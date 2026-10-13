// 最小 WebDAV 服务器，仅用于验证同步协议。内存存储，支持 GET / PUT / MKCOL / DELETE / PROPFIND。
// /__dump 返回已存路径与内容摘要（测试用，不属于 WebDAV）。
const http = require('http');

const PORT = Number(process.env.DAV_PORT || 8099);
const REQUIRE_AUTH = process.env.DAV_AUTH || ''; // 例如 "Basic dTpw"

const store = new Map(); // path -> Buffer
const dirs = new Set(['/']);

function norm(p) {
  return decodeURIComponent(p.split('?')[0]);
}
// 目录一律用不带尾斜杠的规范形式存储与比较（根为 "/"）
function canon(p) {
  let s = norm(p).replace(/\/+$/, '');
  return s || '/';
}
function parentOf(p) {
  const segs = canon(p).split('/');
  segs.pop();
  return segs.join('/') || '/';
}

const server = http.createServer((req, res) => {
  const p = norm(req.url);

  if (p === '/__dump') {
    const out = { dirs: [...dirs], files: [] };
    for (const [k, v] of store) out.files.push({ path: k, size: v.length, body: v.toString('utf8').slice(0, 2000000) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  if (REQUIRE_AUTH && req.headers.authorization !== REQUIRE_AUTH) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
    return res.end('unauthorized');
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (req.method === 'MKCOL') {
      const c = canon(req.url);
      if (dirs.has(c)) { res.writeHead(405); return res.end(); }
      if (!dirs.has(parentOf(c))) { res.writeHead(409); return res.end('parent missing'); }
      dirs.add(c);
      res.writeHead(201);
      return res.end();
    }

    if (req.method === 'PUT') {
      if (!dirs.has(parentOf(req.url))) { res.writeHead(409); return res.end('parent missing'); }
      const existed = store.has(p);
      store.set(p, body);
      res.writeHead(existed ? 204 : 201);
      return res.end();
    }

    if (req.method === 'GET') {
      if (!store.has(p)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(store.get(p));
    }

    if (req.method === 'DELETE') {
      store.delete(p);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === 'PROPFIND') {
      const c = canon(req.url);
      // 只有目录确实存在（或有同名文件）才回 207，否则 404——
      // 否则应用用 PROPFIND 判断「409 是已存在还是缺父级」就会失效。
      const isDir = dirs.has(c);
      const items = [...store.keys()].filter((k) => k.startsWith(c === '/' ? '/' : c + '/'));
      if (!isDir && !store.has(c) && !items.length) { res.writeHead(404); return res.end(); }
      const xml =
        '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
        items.map((k) => `<d:response><d:href>${k}</d:href></d:response>`).join('') +
        '</d:multistatus>';
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      return res.end(xml);
    }

    res.writeHead(405);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('DAV test server listening on http://127.0.0.1:' + PORT);
});

module.exports = server;
