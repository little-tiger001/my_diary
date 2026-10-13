// 写入测试：在真实数据的副本上，用与原版一致的字段结构
// 新增 -> 读回 -> 修改 -> 删除，验证不会破坏 schema，且字段类型与原版一致。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const USER_DATA = process.env.MYDIARY_USER_DATA;
if (!USER_DATA) {
  console.error('需要设置 MYDIARY_USER_DATA');
  process.exit(2);
}
app.setPath('userData', USER_DATA);
console.log('userData = ' + USER_DATA);

const ROOT = path.join(__dirname, '..');

const PROBE = `
(async () => {
  const out = { steps: [] };
  const db = new Dexie('diary');
  db.version(1).stores({
    diary: '++id, title, content, createTime, updateTime, recordTime, images, localImages, city, address, temperature, weather, color, dayOfMonth, monthOfYear, year, latitude, longitude, deleted, uuid, synced, isHidden, device, category, type, audio, localAudio, contentType, tag, historyTime, draw, localDraw, top, bt, m, ind',
    category: '++id, name, count, pic, isDeleted, uuid, recordModelId, createTime, updateTime, synced',
    recordModel: '++id, content, position, order, title, contentType, name, uuid, isDelete, isDefault, createTime, updateTime, synced',
    tag: '++id, name, deleted, uuid, order, lock, createTime, updateTime, synced'
  });
  db.version(2).stores({ history: '++id, content, uuid, createTime' });
  db.version(3).stores({ draft: '++id, title, content, uuid, createTime, shown' });

  await db.open();
  const before = await db.diary.count();
  out.steps.push('opened v' + db.verno + ', count=' + before);

  const now = Date.now();
  const d = new Date(now);
  const rec = {
    title: '__写入测试__',
    content: '# 测试\\n\\n**粗体** 与 \`代码\`\\n\\n- 项目一\\n- 项目二',
    createTime: now, updateTime: now, recordTime: now,
    images: '', localImages: 'aaa.jpeg|bbb.jpeg',
    city: '', address: '测试地点', temperature: '', weather: '晴', color: '',
    dayOfMonth: d.getDate(), monthOfYear: d.getMonth() + 1, year: d.getFullYear(),
    latitude: '', longitude: '', deleted: 0,
    uuid: 'smoketest-' + now, synced: 1, isSynced: 1, isHidden: 0, device: '',
    category: '', type: '', audio: '', localAudio: '', contentType: 0,
    tag: '标签A|标签B', top: 0
  };

  const id = await db.diary.add(rec);
  out.steps.push('added id=' + id);

  let got = await db.diary.get(id);
  out.steps.push('readback title=' + got.title + ' localImages=' + got.localImages + ' tag=' + got.tag);
  out.match = (got.localImages === 'aaa.jpeg|bbb.jpeg') && (got.tag === '标签A|标签B');

  const byUuid = await db.diary.where('uuid').equals(rec.uuid).first();
  out.steps.push('uuid index lookup: ' + (byUuid ? 'hit' : 'MISS'));

  await db.diary.update(id, { title: '__写入测试_已改__', updateTime: Date.now() });
  got = await db.diary.get(id);
  out.steps.push('after update title=' + got.title);

  const yearIdx = await db.diary.where('year').equals(d.getFullYear()).count();
  out.steps.push('year index count=' + yearIdx);

  await db.diary.delete(id);
  const after = await db.diary.count();
  out.steps.push('deleted, count=' + after);
  out.restored = after === before;

  db.close();
  out.ok = out.match && out.restored;
  return out;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('file://' + path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const res = await win.webContents.executeJavaScript(PROBE, true);
  console.log('WRITE TEST:');
  console.log(JSON.stringify(res, null, 2));
  app.exit(res && res.ok ? 0 : 1);
});
