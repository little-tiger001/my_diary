// 端到端同步协议测试（健壮版）
//   起本地 WebDAV -> 用真实数据副本启动应用 -> 完整同步 -> 校验远端格式 -> 校验反向合并
// 结果同时写入 _sync_test.log，避免管道缓冲导致看不到输出。
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');

const USER_DATA = process.env.MYDIARY_USER_DATA;
const DAV_PORT = Number(process.env.DAV_PORT || 8099);
const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, '_sync_test.log');
const DAV_URL = `http://127.0.0.1:${DAV_PORT}/dav`;

if (!USER_DATA) { console.error('需要 MYDIARY_USER_DATA'); process.exit(2); }
app.setPath('userData', USER_DATA);

// 复用真实主进程的 IPC 注册，保证测的是应用本身的代码路径
const appMain = require(path.join(ROOT, 'src', 'main.js'));

fs.writeFileSync(LOG, '', 'utf8');
function log(line) {
  fs.appendFileSync(LOG, line + '\n', 'utf8');
  process.stdout.write(line + '\n');
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function finish(code) {
  const failed = results.filter((r) => !r.ok);
  log('\n==== ' + (results.length - failed.length) + '/' + results.length + ' passed ====');
  if (failed.length) log('FAILED: ' + failed.map((f) => f.name).join('; '));
  try { fs.writeFileSync(LOG, fs.readFileSync(LOG, 'utf8'), 'utf8'); } catch (e) { /* ignore */ }
  app.exit(code);
}

process.on('unhandledRejection', (e) => { log('UNHANDLED REJECTION: ' + (e && e.stack || e)); finish(3); });
process.on('uncaughtException', (e) => { log('UNCAUGHT: ' + (e && e.stack || e)); finish(3); });
setTimeout(() => { log('!! 硬超时 120 秒，强制结束'); finish(4); }, 120000);

function dump() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${DAV_PORT}/__dump`, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8'))));
    }).on('error', reject);
  });
}

function decodeSi(b64) {
  const key = Buffer.from(crypto.createHash('sha256').update('9ejc8kdq').digest('hex'), 'hex');
  const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16, 0));
  return JSON.parse(d.update(b64, 'base64', 'utf8') + d.final('utf8'));
}

function putRemote(bodyStr) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(bodyStr, 'utf8');
    const req = http.request(
      { hostname: '127.0.0.1', port: DAV_PORT, path: '/dav/diary/diary.json', method: 'PUT', headers: { 'Content-Length': data.length } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function loadAndWait(win, fn, label) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { log('WARN 等待 ' + label + ' 超时'); resolve(); }, 20000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); resolve(); });
    fn();
  });
}

let win;

async function js(code, label) {
  try {
    return await win.webContents.executeJavaScript(code, true);
  } catch (e) {
    log('JS ERROR [' + label + ']: ' + (e && e.message || e));
    return undefined;
  }
}

app.whenReady().then(async () => {
  appMain.ensureDirs();
  appMain.registerIpc();
  log('IPC 已注册，userData=' + app.getPath('userData'));

  win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });

  await loadAndWait(win, () => win.loadURL('file://' + path.join(ROOT, 'renderer', 'index.html')), 'first load');
  await new Promise((r) => setTimeout(r, 1500));

  // 直接注入 WebDAV 配置，避免 reload（reload 的 did-finish-load 在此环境下不触发）
  await js(`
    window.__mydiary.sync.setCfg({
      syncType: 4, customUrl: ${JSON.stringify(DAV_URL)},
      username: 'tester', password: 'secret', selfSigned: false
    }); true;
  `, 'set dav cfg');

  const state = await js(`({
    ready: !!(window.__mydiary && window.__mydiary.sync),
    fatal: document.querySelector('.fatal-msg') ? document.querySelector('.fatal-msg').textContent : '',
    mounted: !!document.querySelector('.topbar')
  })`, 'state');
  log('页面状态: ' + JSON.stringify(state));
  check('应用已挂载并暴露同步入口', !!(state && state.ready), state && state.fatal ? '致命错误:' + state.fatal : '');
  if (!state || !state.ready) return finish(1);

  const before = await js(`(async () => (await window.__mydiary.db.diary.toArray()).length)()`, 'count');
  check('本地已读到真实日记', before > 0, 'count=' + before);

  // ---------- 第一次同步 ----------
  const syncErr = await js(`(async () => {
    try { await window.__mydiary.sync.now(); return ''; }
    catch (e) { return String(e && e.message || e); }
  })()`, 'sync.now');
  check('sync.now() 未抛异常', syncErr === '', syncErr || '');

  const davState = await js(`window.__mydiary.sync.state()`, 'dav state');
  log('同步状态: ' + JSON.stringify(davState));
  check('同步未记录错误', !(davState && davState.lastError), (davState && davState.lastError) || '');

  const d1 = await dump();
  log('远端文件: ' + JSON.stringify(d1.dirs) + ' ' + JSON.stringify(d1.files.map((f) => f.path)));
  check('创建了 diary 目录', d1.dirs.includes('/dav/diary'), d1.dirs.join(','));
  const dj = d1.files.find((f) => f.path === '/dav/diary/diary.json');
  const si = d1.files.find((f) => f.path === '/dav/diary/si');
  check('写入了 diary.json', !!dj);
  check('写入了 si', !!si);

  let obj = null;
  if (dj) {
    try { obj = JSON.parse(dj.body); } catch (e) { log('diary.json 解析失败: ' + e.message); }
    check('diary.json 是合法 JSON', !!obj);
  }
  if (obj) {
    const keys = Object.keys(obj).sort();
    check('四个键名与原版一致（含拼写错误 catagory）',
      JSON.stringify(keys) === JSON.stringify(['catagory', 'json', 'model', 'tag']), JSON.stringify(keys));
    let list = null;
    try { list = JSON.parse(obj.json); } catch (e) { /* ignore */ }
    check('json 是双重编码的数组', Array.isArray(list));
    if (Array.isArray(list)) {
      check('日记条数与本地一致', list.length === before, `remote=${list.length} local=${before}`);
      const s = list[0];
      check('deleted 已转布尔', typeof s.deleted === 'boolean', 'typeof=' + typeof s.deleted);
      check('isHidden 已转布尔', typeof s.isHidden === 'boolean', 'typeof=' + typeof s.isHidden);
      check('category 已挪到 type', !list.some((x) => x.category), 'hasType=' + list.some((x) => x.type));
      check('未泄漏本地主键 id', !('id' in s));
      check('保留 uuid / updateTime', !!s.uuid && typeof s.updateTime === 'number');
    }
    check('catagory 可解析为数组', Array.isArray(JSON.parse(obj.catagory)));
  }

  if (si) {
    let info = null;
    try { info = decodeSi(si.body.trim()); } catch (e) { info = { __err: e.message }; }
    check('si 能用 9ejc8kdq 解密（与原版同算法）', !info.__err, info.__err || JSON.stringify(info));
    if (!info.__err) {
      check('si 含 t/d/dv/id', 't' in info && 'd' in info && 'dv' in info && 'id' in info, JSON.stringify(info));
      check('si.d == 1', Number(info.d) === 1);
      check('si.dv == pc', info.dv === 'pc');
    }
  }

  // ---------- 反向合并 ----------
  const NEW_UUID = 'davtest-1111-2222-3333-444444444444';
  if (obj) {
    const remoteList = JSON.parse(obj.json);
    remoteList.push({
      uuid: NEW_UUID, title: '来自云端的测试条目', content: 'hello from remote',
      createTime: Date.now(), updateTime: Date.now() + 100000, recordTime: Date.now(),
      year: 2026, monthOfYear: 1, dayOfMonth: 1,
      deleted: false, isHidden: false, synced: true,
      category: '', type: '云端分类', tag: '', images: '', localImages: ''
    });
    const obj2 = Object.assign({}, obj, { json: JSON.stringify(remoteList) });
    await putRemote(JSON.stringify(obj2));
    await js(`localStorage.setItem('s_t','0'); true;`, 'reset s_t');
    await js(`window.__mydiary.sync.download()`, 'download');
    await new Promise((r) => setTimeout(r, 1000));

    const merged = await js(`(async () => {
      const d = await window.__mydiary.db.diary.where('uuid').equals(${JSON.stringify(NEW_UUID)}).first();
      return d ? { title: d.title, category: d.category, type: d.type, deleted: d.deleted, isHidden: d.isHidden, synced: d.synced } : null;
    })()`, 'check merge');
    check('远端新日记已合并到本地', !!merged, JSON.stringify(merged));
    if (merged) {
      check('远端 type 还原为 category', merged.category === '云端分类' && merged.type === '', JSON.stringify(merged));
      check('远端布尔 deleted 还原为 0/1', merged.deleted === 0 || merged.deleted === 1, 'deleted=' + merged.deleted);
      check('合并后 synced=1', Number(merged.synced) === 1);
    }

    await js(`(async () => {
      const d = await window.__mydiary.db.diary.where('uuid').equals(${JSON.stringify(NEW_UUID)}).first();
      if (d) await window.__mydiary.db.diary.delete(d.id);
      return true;
    })()`, 'cleanup');
  }

  finish(results.some((r) => !r.ok) ? 1 : 0);
});
