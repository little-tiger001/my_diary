// 冒烟测试：以真实 userData 启动一个隐藏窗口，用页面上下文里的 Dexie
// 打开共享的 "diary" 库，验证 schema 与原版一致且能读到真实数据。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SHARED_USER_DATA = process.env.MYDIARY_USER_DATA || path.join(app.getPath('appData'), '一本日记');
app.setPath('userData', SHARED_USER_DATA);
console.log('userData = ' + SHARED_USER_DATA);

const ROOT = path.join(__dirname, '..');

// 必须注册 IPC：app.js 的 onMounted 第一句就是 fileApi.getPath()（sendSync），
// 没有监听者会直接抛错，后面的 openDb / countPendingImages / window.__mydiary 全都不会执行。
// 这个测试只读库，但页面得先真的挂起来，冒烟才有意义。
const appMain = require(path.join(ROOT, 'src', 'main.js'));

const PROBE = `
(async () => {
  const out = { userAgent: navigator.userAgent };
  try {
    // schema 来自 src/schema.js（index.html 已加载），不再在这里抄一遍：
    // 抄本一旦漂移，这个"校验 schema 与原版一致"的测试就会给出假信号。
    out.hasSharedSchema = typeof MYDIARY_SCHEMA !== 'undefined';
    if (!out.hasSharedSchema) throw new Error('MYDIARY_SCHEMA 未加载');
    const probe = MYDIARY_SCHEMA.apply(new Dexie(MYDIARY_SCHEMA.DB_NAME));

    await probe.open();
    out.verno = probe.verno;
    out.declaredVersion = MYDIARY_SCHEMA.DB_VERSION;
    out.tables = probe.tables.map(t => t.name).sort();

    const all = await probe.diary.toArray();
    out.diaryCount = all.length;
    out.sampleFields = all.length ? Object.keys(all[0]).sort() : [];
    out.records = all.map(d => ({
      uuid: d.uuid,
      title: d.title || '',
      contentLen: (d.content || '').length,
      createTime: d.createTime,
      recordTime: d.recordTime,
      year: d.year, month: d.monthOfYear, day: d.dayOfMonth,
      category: d.category || '',
      tag: d.tag || '',
      images: (d.images || '').slice(0, 40),
      localImages: d.localImages || '',
      synced: d.synced, deleted: d.deleted, isHidden: d.isHidden
    }));
    out.categoryCount = await probe.category.count();
    out.tagCount = await probe.tag.count();
    out.historyCount = await probe.history.count();
    out.draftCount = await probe.draft.count();
    out.modelCount = await probe.recordModel.count();
    probe.close();
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = (e && e.name ? e.name + ': ' : '') + ((e && e.message) || String(e));
    out.stack = e && e.stack ? String(e.stack).split('\\n').slice(0, 6).join(' | ') : '';
  }
  return out;
})()
`;

app.whenReady().then(async () => {
  appMain.ensureDirs();
  appMain.registerIpc();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.webContents.on('console-message', (e, level, message) => {
    console.log('[renderer] ' + message);
  });

  try {
    await win.loadURL('file://' + path.join(ROOT, 'renderer', 'index.html'));
    console.log('renderer loaded (index.html)');
  } catch (e) {
    console.log('LOAD FAILED: ' + e.message);
  }

  // 给 Vue/Dexie 一点启动时间，同时验证 app.js 是否报错
  await new Promise((r) => setTimeout(r, 1500));

  const appState = await win.webContents.executeJavaScript(
    `({
       hasVue: typeof Vue !== 'undefined',
       hasDexie: typeof Dexie !== 'undefined',
       hasMarkdownit: typeof markdownit !== 'undefined',
       hasEcharts: typeof echarts !== 'undefined',
       hasSharedSchema: typeof MYDIARY_SCHEMA !== 'undefined',
       mounted: !!document.querySelector('.topbar') || !!document.querySelector('.fatal'),
       fatalText: document.querySelector('.fatal-msg') ? document.querySelector('.fatal-msg').textContent : '',
       hasApi: !!window.__mydiary
     })`
  );
  console.log('APP STATE: ' + JSON.stringify(appState, null, 2));

  const result = await win.webContents.executeJavaScript(PROBE, true);
  console.log('PROBE RESULT:');
  console.log(JSON.stringify(result, null, 2));

  // 光看库能不能读不够：IPC 没注册 / schema 缺失 / Vue 报错都会让页面根本没挂起来
  const uiOk = !!(appState && appState.mounted && appState.hasApi && !appState.fatalText);
  app.exit(result && result.ok && uiOk ? 0 : 1);
});
