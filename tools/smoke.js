// 冒烟测试：以真实 userData 启动一个隐藏窗口，用页面上下文里的 Dexie
// 打开共享的 "diary" 库，验证 schema 与原版一致且能读到真实数据。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SHARED_USER_DATA = process.env.MYDIARY_USER_DATA || path.join(app.getPath('appData'), '一本日记');
app.setPath('userData', SHARED_USER_DATA);
console.log('userData = ' + SHARED_USER_DATA);

const ROOT = path.join(__dirname, '..');

const PROBE = `
(async () => {
  const out = { userAgent: navigator.userAgent };
  try {
    const probe = new Dexie('diary');
    probe.version(1).stores({
      diary: '++id, title, content, createTime, updateTime, recordTime, images, localImages, city, address, temperature, weather, color, dayOfMonth, monthOfYear, year, latitude, longitude, deleted, uuid, synced, isHidden, device, category, type, audio, localAudio, contentType, tag, historyTime, draw, localDraw, top, bt, m, ind',
      category: '++id, name, count, pic, isDeleted, uuid, recordModelId, createTime, updateTime, synced',
      recordModel: '++id, content, position, order, title, contentType, name, uuid, isDelete, isDefault, createTime, updateTime, synced',
      tag: '++id, name, deleted, uuid, order, lock, createTime, updateTime, synced'
    });
    probe.version(2).stores({ history: '++id, content, uuid, createTime' });
    probe.version(3).stores({ draft: '++id, title, content, uuid, createTime, shown' });

    await probe.open();
    out.verno = probe.verno;
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
       mounted: !!document.querySelector('.topbar') || !!document.querySelector('.fatal'),
       fatalText: document.querySelector('.fatal-msg') ? document.querySelector('.fatal-msg').textContent : ''
     })`
  );
  console.log('APP STATE: ' + JSON.stringify(appState, null, 2));

  const result = await win.webContents.executeJavaScript(PROBE, true);
  console.log('PROBE RESULT:');
  console.log(JSON.stringify(result, null, 2));

  app.exit(result && result.ok ? 0 : 1);
});
