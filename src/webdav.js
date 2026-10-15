const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/* ===========================================================================
 * WebDAV 客户端 —— 实现与《一本日记》兼容的第三方同步协议
 *
 *   本程序只支持「自定义 WebDAV 地址」一种配置。
 *   官方客户端的 sync_type（2=坚果云、3=box、4=自定义）只是替它自己选 base 的开关；
 *   远端布局、认证方式、文件内容在所有 base 下完全相同，所以本程序直接填地址即可，
 *   填官方客户端正在用的那个 base（比如坚果云的 https://dav.jianguoyun.com/dav）
 *   一样能互通。
 *
 *   认证：请求头 Authorization，即 "Basic <base64(账号:密码)>"
 *
 *   远端文件：
 *     ${base}/diary/diary.json   主数据，四个字段各自是被 JSON.stringify 过的字符串
 *     ${base}/diary/si           同步信息，sign.aes("9ejc8kdq", JSON) 的 base64
 *     ${base}/diary/<名>_<字节数>.<扩展名>   图片
 *
 *   建目录：MKCOL ${base}/diary/，409/405/200/201 都算成功
 *
 *   重定向：3xx 一律按同样的方法与请求体重发（最多 5 跳），但只跟同主机的跳转——
 *   请求头里带着 Basic 账号密码，跨主机跟随等于把密码发给第三方。
 * =========================================================================== */

const OCTET = 'application/octet-stream;charset=UTF-8';

function resolveBase(customUrl) {
  return String(customUrl || '').replace(/\/+$/, '');
}

function basicAuth(username, password) {
  if (!username) return '';
  return 'Basic ' + Buffer.from(`${username}:${password || ''}`, 'utf8').toString('base64');
}

function encodePath(p) {
  return String(p)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function buildUrl(base, relPath) {
  if (!relPath) return base;
  return base.replace(/\/+$/, '') + '/' + encodePath(relPath.replace(/^\/+/, ''));
}

function request(fullUrl, method, { auth, body, headers, selfSigned } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(fullUrl);
    } catch (e) {
      return reject(new Error('WebDAV 地址无效：' + fullUrl));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const h = Object.assign({}, headers);
    if (auth) h.Authorization = auth;

    let payload = null;
    if (body !== undefined && body !== null) {
      payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
      h['Content-Length'] = payload.length;
    }

    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: h,
        rejectUnauthorized: !selfSigned,
        timeout: 60000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          // 3xx：有的云盘会把 http 挑到 https、或把路径归一化后返回重定向。
          // 不跟随的话表现为一个莫名其妙的 HTTP 301/302。按同样的方法与请求体重发（最多 5 跳）。
          const loc = res.headers && res.headers.location;
          if (loc && res.statusCode >= 300 && res.statusCode < 400) {
            if (hops >= 5) return reject(new Error('WebDAV 重定向次数过多：' + fullUrl));
            let next = null;
            try {
              next = new URL(loc, fullUrl);
            } catch (e) {
              return reject(new Error('WebDAV 重定向地址无效：' + loc));
            }
            // 请求头里带着 Basic 账号密码，所以只跟同主机的跳转。
            // 允许 http -> https（同主机），跨主机一律拒绝，否则等于把密码发给第三方。
            if (next.hostname !== url.hostname) {
              return reject(new Error('WebDAV 重定向到其它主机，已拒绝（避免账号密码被发到第三方）：' + loc));
            }
            try {
              return resolve(await request(next.toString(), method, { auth, body, headers, selfSigned }, hops + 1));
            } catch (e) {
              return reject(e);
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('WebDAV 请求超时（60 秒）')));
    req.on('error', (err) => reject(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function describeStatus(status) {
  if (status === 401) return '认证失败（401）：账号或密码不对。若云盘提供「应用密码」，要填应用密码而不是登录密码';
  if (status === 403) return '没有权限（403）';
  if (status === 404) return '路径不存在（404）';
  if (status === 409) return '父目录不存在（409）';
  if (status === 507) return '云盘空间不足（507）';
  return 'HTTP ' + status;
}

async function collectionExists(target, auth, selfSigned) {
  const res = await request(target, 'PROPFIND', {
    auth,
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    selfSigned
  });
  return res.status === 207 || res.status === 200;
}

async function ensureCollection(base, auth, selfSigned) {
  // MKCOL 的语义在服务器之间不统一：
  //   405 = 已存在；409 既可能是「已存在」也可能是「父目录不存在」。
  // 官方客户端把 200/201/405/409 一律当成功（它用的 base 父目录必然存在）。
  // 自定义 WebDAV 时父目录常常不存在，所以这里用 PROPFIND 把 409 区分开。
  const mkcol = (url) =>
    request(url, 'MKCOL', { auth, headers: { 'Content-Type': OCTET }, selfSigned });

  const target = buildUrl(base, 'diary/');
  let res = await mkcol(target);
  if (res.status === 200 || res.status === 201 || res.status === 405) return { ok: true, status: res.status };
  if (res.status === 409 && (await collectionExists(target, auth, selfSigned))) return { ok: true, status: res.status };
  if (res.status !== 409) throw new Error('无法创建云盘目录：' + describeStatus(res.status));

  // 409 且确实不存在 -> 逐级创建父目录后重试一次
  const root = base.replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(root);
  } catch (e) {
    throw new Error('WebDAV 地址无效：' + base);
  }
  const segs = parsed.pathname.split('/').filter(Boolean);
  let acc = parsed.origin;
  for (const seg of segs) {
    acc += '/' + encodeURIComponent(seg);
    const r = await mkcol(acc + '/');
    if (![200, 201, 405, 409].includes(r.status)) {
      throw new Error('无法创建云盘目录 ' + acc + '：' + describeStatus(r.status));
    }
  }

  res = await mkcol(target);
  if (res.status === 200 || res.status === 201 || res.status === 405) return { ok: true, status: res.status };
  if (res.status === 409 && (await collectionExists(target, auth, selfSigned))) return { ok: true, status: res.status };
  throw new Error('无法创建云盘目录：' + describeStatus(res.status));
}

// 取原始文本：覆盖远端之前要原样留一份底，所以不能只拿 parse 之后的对象。
// 远端没有这个文件、或文件是空的，都返回 null。
async function getDiaryJsonText(base, auth, selfSigned) {
  const url = buildUrl(base, 'diary/diary.json');
  const res = await request(url, 'GET', { auth, selfSigned });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('读取 diary.json 失败：' + describeStatus(res.status));
  const text = res.body.toString('utf8');
  return text.trim() ? text : null;
}

async function getDiaryJson(base, auth, selfSigned) {
  const text = await getDiaryJsonText(base, auth, selfSigned);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('远端 diary.json 不是合法 JSON（可能被其他程序占用）：' + e.message);
  }
}

async function putDiaryJson(base, auth, payload, selfSigned) {
  const url = buildUrl(base, 'diary/diary.json');
  const res = await request(url, 'PUT', {
    auth,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': OCTET },
    selfSigned
  });
  if (![200, 201, 204].includes(res.status)) {
    throw new Error('写入 diary.json 失败：' + describeStatus(res.status));
  }
  return res.status;
}

async function getSyncInfoRaw(base, auth, selfSigned) {
  const url = buildUrl(base, 'diary/si');
  const res = await request(url, 'GET', { auth, selfSigned });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('读取 si 失败：' + describeStatus(res.status));
  const t = res.body.toString('utf8').trim();
  return t || null;
}

async function putSyncInfoRaw(base, auth, cipherText, selfSigned) {
  const url = buildUrl(base, 'diary/si');
  const res = await request(url, 'PUT', {
    auth,
    body: cipherText,
    headers: { 'Content-Type': OCTET },
    selfSigned
  });
  if (![200, 201, 204].includes(res.status)) {
    throw new Error('写入 si 失败：' + describeStatus(res.status));
  }
  return res.status;
}

// 图片在远端的命名规则：
//   ${base}/diary/${文件名去扩展名}_${字节数}.${扩展名}
async function uploadImage(base, auth, localPath, selfSigned) {
  if (!fs.existsSync(localPath)) return null;
  const name = path.basename(localPath);
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? 'jpeg' : name.slice(dot + 1);
  let size = Math.round(fs.statSync(localPath).size);
  if (size <= 0) size = 100;

  const rel = `diary/${stem}_${size}.${ext}`;
  const url = buildUrl(base, rel);
  const res = await request(url, 'PUT', {
    auth,
    body: fs.readFileSync(localPath),
    headers: { 'Content-Type': 'application/octet-stream' },
    selfSigned
  });
  if (![200, 201, 204].includes(res.status)) {
    throw new Error('上传图片失败 ' + name + '：' + describeStatus(res.status));
  }
  return url;
}

// 供「测试连接」用：MKCOL 即可，与原版 check() 一致
async function check(base, auth, selfSigned) {
  return ensureCollection(base, auth, selfSigned);
}

module.exports = {
  resolveBase,
  basicAuth,
  check,
  ensureCollection,
  getDiaryJson,
  getDiaryJsonText,
  putDiaryJson,
  getSyncInfoRaw,
  putSyncInfoRaw,
  uploadImage,
  describeStatus
};
