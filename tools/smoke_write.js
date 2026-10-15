// 写入测试：在真实数据的副本上，用与原版一致的字段结构
// 新增 -> 读回 -> 修改 -> 删除，验证不会破坏 schema，且字段类型与原版一致。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const USER_DATA = process.env.MYDIARY_USER_DATA;
if (!USER_DATA) {
  console.error('需要设置 MYDIARY_USER_DATA');
  process.exit(2);
}
app.setPath('userData', USER_DATA);
console.log('userData = ' + USER_DATA);

const ROOT = path.join(__dirname, '..');

// 图片那几步要走真实 IPC，所以必须注册主进程处理器（复用应用自己的代码路径）
const appMain = require(path.join(ROOT, 'src', 'main.js'));

// saveImage 的来源校验要有真实文件才测得了：一个真图片、一个非图片
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mydiary-saveimage-'));
const tmpPng = path.join(tmpDir, 'pick.png');
const tmpTxt = path.join(tmpDir, 'pick.txt');
fs.writeFileSync(tmpPng, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]));
fs.writeFileSync(tmpTxt, 'not an image');

const PROBE = `
(async () => {
  const out = { steps: [] };
  // schema 来自 src/schema.js（index.html 已加载），不在这里另抄一份
  const db = MYDIARY_SCHEMA.apply(new Dexie(MYDIARY_SCHEMA.DB_NAME));

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

  // 删除走的是墓碑（deleted=1）而不是硬删除：记录必须还在，同步才能把删除传给对端。
  // 硬删除的话远端仍留着这条，下次合并会按 uuid 查不到本地而把它重新插回来。
  await db.diary.update(id, { deleted: 1, updateTime: Date.now(), synced: 1, isSynced: 1 });
  got = await db.diary.get(id);
  out.tombstone = !!got && got.deleted === 1 && got.uuid === rec.uuid;
  out.steps.push('tombstone: ' + (out.tombstone ? 'ok' : 'MISS') + ' (deleted=' + (got && got.deleted) + ')');

  // 图片：saveImageBuffer 现在直接传 Uint8Array（结构化克隆支持），
  // 走一遍 存 -> 存在性 -> 删除，顺带验证 deleteImage 的路径校验没把正常文件名挡掉。
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  const imgName = await window.fileApi.saveImageBuffer(png, '.png');
  const existsAfterSave = await window.fileApi.imageExists(imgName);
  await window.fileApi.deleteImage(imgName);
  const existsAfterDelete = await window.fileApi.imageExists(imgName);
  out.image = !!imgName && existsAfterSave === true && existsAfterDelete === false;
  out.steps.push('image roundtrip: name=' + imgName + ' saved=' + existsAfterSave + ' deleted=' + !existsAfterDelete);

  // 路径穿越必须被挡住
  let traversalBlocked = false;
  try {
    await window.fileApi.deleteImage('..\\\\..\\\\evil.png');
  } catch (e) {
    traversalBlocked = true;
  }
  out.traversalBlocked = traversalBlocked;
  out.steps.push('path traversal rejected: ' + traversalBlocked);

  // saveImage 的来源是渲染进程给的路径，属于不可信输入：只接受真实存在的图片文件。
  // （不校验的话等于给了页面一个"把本机任意文件复制进图片目录"的口子）
  let nonImageRejected = false;
  try {
    await window.fileApi.saveImage(${JSON.stringify(tmpTxt)});
  } catch (e) {
    nonImageRejected = true;
  }
  let missingRejected = false;
  try {
    await window.fileApi.saveImage(${JSON.stringify(path.join(tmpDir, 'nope.png'))});
  } catch (e) {
    missingRejected = true;
  }
  const picked = await window.fileApi.saveImage(${JSON.stringify(tmpPng)});
  const pickedExists = await window.fileApi.imageExists(picked);
  await window.fileApi.deleteImage(picked);
  out.saveImage = nonImageRejected && missingRejected && !!picked && pickedExists === true;
  out.steps.push('saveImage 只收真实图片: 非图片被拒=' + nonImageRejected +
    ' 不存在被拒=' + missingRejected + ' 正常图片=' + pickedExists);

  // 上传只允许上传 images/ 目录里的图（否则就是"读本机任意文件并传到云盘"）。
  // 端口 1 上没有任何服务：被目录校验挡下的会带"只能上传 images/"，过了校验的才会是连接失败。
  const badUrl = { customUrl: 'http://127.0.0.1:1/dav', username: 'x', password: 'y' };
  const outside = await window.webdav.uploadImage(badUrl, 'C:/Windows/win.ini');
  const outsideBlocked = !!(outside && outside.ok === false && (outside.error || '').indexOf('images/') >= 0);
  const insideName = await window.fileApi.saveImageBuffer(png, '.png');
  const insideRes = await window.webdav.uploadImage(badUrl, window.fileApi.getLocalImage(insideName));
  await window.fileApi.deleteImage(insideName);
  const insideAllowed = !!(insideRes && insideRes.ok === false && (insideRes.error || '').indexOf('images/') < 0);
  out.uploadGuard = outsideBlocked && insideAllowed;
  out.steps.push('upload 只收 images/ 目录: 目录外被拒=' + outsideBlocked +
    ' 目录内放行(败在连不上)=' + insideAllowed);

  await db.diary.delete(id);
  const after = await db.diary.count();
  out.steps.push('hard-deleted test record, count=' + after);
  out.restored = after === before;

  db.close();
  out.ok = out.match && out.restored && out.tombstone && out.image && out.traversalBlocked &&
    out.saveImage && out.uploadGuard;
  return out;
})()
`;

app.whenReady().then(async () => {
  appMain.ensureDirs();
  appMain.registerIpc();

  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadURL('file://' + path.join(ROOT, 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const res = await win.webContents.executeJavaScript(PROBE, true);
  console.log('WRITE TEST:');
  console.log(JSON.stringify(res, null, 2));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  app.exit(res && res.ok ? 0 : 1);
});
