// UI 交互测试：验证「分类/标签的 + 按钮」能真正弹出应用内弹窗并写入数据库。
// 背景：Electron 不支持 window.prompt（调用即抛异常），原来的 + 按钮完全无反应。
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, '_ui_test.log');
fs.writeFileSync(LOG, '', 'utf8');
function log(s) { fs.appendFileSync(LOG, s + '\n', 'utf8'); process.stdout.write(s + '\n'); }

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

const appMain = require(path.join(ROOT, 'src', 'main.js'));

setTimeout(() => { log('!! 硬超时'); finish(4); }, 90000);
process.on('unhandledRejection', (e) => { log('UNHANDLED: ' + (e && e.stack || e)); finish(3); });

function finish(code) {
  const failed = results.filter((r) => !r.ok);
  log('\n==== ' + (results.length - failed.length) + '/' + results.length + ' passed ====');
  if (failed.length) log('FAILED: ' + failed.map((f) => f.name).join('; '));
  app.exit(code);
}

let win;
async function js(code) {
  try { return await win.webContents.executeJavaScript(code, true); }
  catch (e) { log('JS ERROR: ' + (e && e.message || e)); return undefined; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  appMain.ensureDirs();
  appMain.registerIpc();

  win = new BrowserWindow({
    show: false,
    width: 1200, height: 800,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('file://' + path.join(ROOT, 'renderer', 'index.html'));
  await sleep(1800);

  const mounted = await js(`!!(window.__mydiary && document.querySelector('.sidebar'))`);
  check('应用已挂载', mounted);
  if (!mounted) return finish(1);

  // 先清掉可能残留的同名测试数据
  await js(`(async () => {
    const db = window.__mydiary.db;
    for (const name of ['__UI测试分类__','__UI测试标签__']) {
      const c = await db.category.where('name').equals(name).first();
      if (c) await db.category.delete(c.id);
      const t = await db.tag.where('name').equals(name).first();
      if (t) await db.tag.delete(t.id);
    }
    return true;
  })()`);

  // ---------- 分类 + ----------
  const clicked = await js(`
    (() => {
      const btn = document.querySelectorAll('.side-block')[0].querySelector('.side-title .mini');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()
  `);
  check('找到并点击了分类的 + 按钮', clicked === 'clicked', String(clicked));
  await sleep(400);

  const modal = await js(`(() => {
    const m = document.querySelector('.modal');
    if (!m) return null;
    return { title: m.querySelector('h3').textContent, hasInput: !!m.querySelector('input') };
  })()`);
  check('弹出了应用内弹窗', !!modal, JSON.stringify(modal));
  check('弹窗是文本输入型', !!(modal && modal.hasInput), JSON.stringify(modal));
  if (!modal) return finish(1);

  await js(`
    (() => {
      const inp = document.querySelector('.modal input');
      inp.value = '__UI测试分类__';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.modal .modal-btns .btn.primary').click();
      return true;
    })()
  `);
  await sleep(700);

  const catCreated = await js(`(async () => {
    const db = window.__mydiary.db;
    const c = await db.category.where('name').equals('__UI测试分类__').first();
    return c ? { name: c.name, uuid: !!c.uuid, synced: c.synced, isDeleted: c.isDeleted } : null;
  })()`);
  check('分类已写入数据库', !!catCreated, JSON.stringify(catCreated));
  check('弹窗已关闭', !(await js(`!!document.querySelector('.modal')`)));

  // ---------- 标签 + ----------
  await js(`
    (() => {
      document.querySelectorAll('.side-block')[1].querySelector('.side-title .mini').click();
      return true;
    })()
  `);
  await sleep(400);
  await js(`
    (() => {
      const inp = document.querySelector('.modal input');
      inp.value = '__UI测试标签__';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.modal .modal-btns .btn.primary').click();
      return true;
    })()
  `);
  await sleep(700);
  const tagCreated = await js(`(async () => {
    const t = await window.__mydiary.db.tag.where('name').equals('__UI测试标签__').first();
    return t ? { name: t.name, order: t.order, deleted: t.deleted } : null;
  })()`);
  check('标签已写入数据库', !!tagCreated, JSON.stringify(tagCreated));

  // ---------- 取消按钮 ----------
  await js(`document.querySelectorAll('.side-block')[0].querySelector('.side-title .mini').click()`);
  await sleep(300);
  await js(`document.querySelector('.modal .modal-btns .btn:not(.primary)').click()`);
  await sleep(300);
  const cancelled = await js(`(async () => {
    const c = await window.__mydiary.db.category.where('name').equals('__UI测试分类2__').first();
    return { modalGone: !document.querySelector('.modal'), noRecord: !c };
  })()`);
  check('取消后弹窗关闭且未创建记录', cancelled.modalGone && cancelled.noRecord, JSON.stringify(cancelled));

  // ---------- 侧栏里出现并可筛选 ----------
  const inSidebar = await js(`
    [...document.querySelectorAll('.side-item')].some(el => el.textContent.includes('__UI测试分类__'))
  `);
  check('新分类出现在侧栏', inSidebar);

  // ---------- 删除分类（确认型弹窗） ----------
  await js(`
    (() => {
      const rows = [...document.querySelectorAll('.side-block')[0].querySelectorAll('.side-item')];
      const row = rows.find(el => el.textContent.includes('__UI测试分类__'));
      if (!row) return 'not-found';
      row.querySelector('.mini.danger').click();
      return 'clicked';
    })()
  `);
  await sleep(400);
  const confirmModal = await js(`(() => {
    const m = document.querySelector('.modal');
    return m ? { title: m.querySelector('h3').textContent, hasInput: !!m.querySelector('input') } : null;
  })()`);
  check('删除弹出了确认弹窗（非输入型）', !!(confirmModal && !confirmModal.hasInput), JSON.stringify(confirmModal));

  await js(`document.querySelector('.modal .modal-btns .btn.primary').click()`);
  await sleep(700);
  const afterDelete = await js(`(async () => {
    const c = await window.__mydiary.db.category.where('name').equals('__UI测试分类__').first();
    return c ? { isDeleted: c.isDeleted } : null;
  })()`);
  check('分类已标记删除', !!(afterDelete && Number(afterDelete.isDeleted) === 1), JSON.stringify(afterDelete));

  // ---------- 清理 ----------
  await js(`(async () => {
    const db = window.__mydiary.db;
    const c = await db.category.where('name').equals('__UI测试分类__').first();
    if (c) await db.category.delete(c.id);
    const t = await db.tag.where('name').equals('__UI测试标签__').first();
    if (t) await db.tag.delete(t.id);
    return true;
  })()`);

  finish(results.some((r) => !r.ok) ? 1 : 0);
});
