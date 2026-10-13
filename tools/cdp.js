// 极简 CDP 客户端：连上正在运行的应用页面，执行一段 JS 并打印 JSON 结果。
// 用法: node tools/cdp.js <port> <表达式文件>
const fs = require('fs');
const http = require('http');

const PORT = Number(process.argv[2] || 9336);
const FILE = process.argv[3];
if (!FILE) { console.error('用法: node tools/cdp.js <port> <表达式文件>'); process.exit(2); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到 page 目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

  function send(method, params) {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }

  const body = fs.readFileSync(FILE, 'utf8');
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true
  });

  if (r.exceptionDetails) {
    console.error('页面内异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    process.exit(1);
  }
  console.log(JSON.stringify(r.result && r.result.value, null, 2));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
