// 通过 CDP 连接正在运行的应用，切换视图并截图。
// 用法: node tools/shot.js <port> <输出目录>
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = Number(process.argv[2] || 9336);
const OUT = process.argv[3] || path.join(__dirname, '..', '_shots');

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const targets = await getJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到 page 目标');
  console.log('目标: ' + page.title + '  ' + page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });

  function send(method, params) {
    const mid = ++id;
    return new Promise((resolve, reject) => {
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }

  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result && r.result.value;
  }

  const state = await evaluate(`({
    mounted: !!document.querySelector('.topbar'),
    fatal: document.querySelector('.fatal-msg') ? document.querySelector('.fatal-msg').textContent : '',
    buttons: [...document.querySelectorAll('.navbtn')].map(b => b.textContent.trim())
  })`);
  console.log('页面状态: ' + JSON.stringify(state));
  if (!state.mounted) {
    console.log('应用未挂载（可能是数据库锁），已退出');
    ws.close();
    process.exit(1);
  }

  const views = ['日历', '统计', '设置', '日记'];
  for (const v of views) {
    const clicked = await evaluate(`
      (() => {
        const b = [...document.querySelectorAll('.navbtn')].find(x => x.textContent.trim() === ${JSON.stringify(v)});
        if (!b) return false;
        b.click();
        return true;
      })()
    `);
    if (!clicked) { console.log('跳过（找不到按钮）: ' + v); continue; }
    await sleep(v === '统计' ? 1800 : 700);

    const geom = await evaluate(`
      (() => {
        const wide = document.querySelector('.center.wide');
        const vis = [...document.querySelectorAll('.center, .editor')].filter(e => e.offsetParent !== null);
        return {
          visible: vis.map(e => ({ cls: e.className, w: Math.round(e.getBoundingClientRect().width) })),
          wideW: wide && wide.offsetParent !== null ? Math.round(wide.getBoundingClientRect().width) : null,
          winW: window.innerWidth
        };
      })()
    `);
    console.log(v + ' -> ' + JSON.stringify(geom));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, 'view-' + v + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('已保存 ' + file);
  }

  ws.close();
  process.exit(0);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
