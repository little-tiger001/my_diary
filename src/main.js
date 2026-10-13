const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, shell, clipboard, Menu, dialog } = require('electron');
const webdav = require('./webdav');

// ---------------------------------------------------------------------------
// 与原版「一本日记」共用同一份数据目录。
// 原版 productName = 一本日记，app.getPath('userData') 指向 %APPDATA%\一本日记。
// 必须在 app ready 之前设置，且必须与原版完全一致，否则 IndexedDB(file__0) 不是同一个库。
// ---------------------------------------------------------------------------
// 默认与原版共用 %APPDATA%\一本日记。
// 设 MYDIARY_USER_DATA 可指向一份副本——用于测试或想隔离运行时。
const SHARED_USER_DATA = process.env.MYDIARY_USER_DATA || path.join(app.getPath('appData'), '一本日记');
app.setPath('userData', SHARED_USER_DATA);

const USER_DATA = SHARED_USER_DATA;
const DATA_DIR = path.join(USER_DATA, 'data');
const IMAGES_DIR = path.join(USER_DATA, 'images');

// 原版硬编码密钥，用于 data/ 目录下的备份文件（AES-256-ECB，hex）
const BACKUP_SECRET = '2909246C549D656546C40576393A78802F787959012E551EADE697707B4579C0';
const BACKUP_KEY = Buffer.from(BACKUP_SECRET, 'hex');

// 第三方同步 si 文件用的固定口令
const SYNC_SECRET = '9ejc8kdq';
const SYNC_VERSION = 1;

function ensureDirs() {
  for (const d of [DATA_DIR, IMAGES_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// 与原版 aes-encryption@1.0.4 完全一致：aes-256-ecb，无 IV，明文 utf8 -> 密文 hex
function backupEncrypt(plain) {
  const c = crypto.createCipheriv('aes-256-ecb', BACKUP_KEY, '');
  return c.update(plain, 'utf8', 'hex') + c.final('hex');
}
function backupDecrypt(cipherHex) {
  const d = crypto.createDecipheriv('aes-256-ecb', BACKUP_KEY, '');
  return d.update(cipherHex, 'hex', 'utf8') + d.final('utf8');
}

// 与原版 preload 的 sign.aes / sign.decodeAes 一致：AES-256-CBC，key=sha256(secret) 的 hex 原始字节，IV 全 0
function signAes(secret, text) {
  if (!text) return '';
  const key = Buffer.from(crypto.createHash('sha256').update(secret).digest('hex'), 'hex');
  const iv = Buffer.alloc(16, 0);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  return c.update(text, 'utf8', 'base64') + c.final('base64');
}
function signDecodeAes(secret, cipherB64) {
  if (!cipherB64) return '';
  const key = Buffer.from(crypto.createHash('sha256').update(secret).digest('hex'), 'hex');
  const iv = Buffer.alloc(16, 0);
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return d.update(cipherB64, 'base64', 'utf8') + d.final('utf8');
}

// 注意：绝不能去碰 IndexedDB 目录下的 LOCK 文件 —— LevelDB 的 LOCK 是 fcntl 锁，
// 删除它会让正在运行的实例写坏数据。这里只做只读探测：能否独占打开 LOCK 文件。
// 真正的冲突判定交给 IndexedDB 打开失败（见渲染进程的错误处理）。
function originalIsRunning() {
  const lock = path.join(USER_DATA, 'IndexedDB', 'file__0.indexeddb.leveldb', 'LOCK');
  if (!fs.existsSync(lock)) return false;
  try {
    const fd = fs.openSync(lock, 'r+');
    fs.closeSync(fd);
    return false; // 能打开说明没人独占，但 LevelDB 用的是 fcntl，结论仅供参考
  } catch (e) {
    return true;
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '我的日记',
    backgroundColor: '#f5f5f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('file://' + path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 只有在被当作入口脚本直接运行时才接管应用生命周期；
// 被工具脚本 require 时只导出 registerIpc，方便测试走真实代码路径。
if (require.main === module) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(() => {
      ensureDirs();
      registerIpc();
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    });

    app.on('window-all-closed', () => { app.quit(); });
  }
}

module.exports = { registerIpc, ensureDirs, SHARED_USER_DATA, USER_DATA, DATA_DIR, IMAGES_DIR };

function registerIpc() {
  ipcMain.on('getPath', (e) => { e.returnValue = USER_DATA; });
  ipcMain.on('getOS', (e) => { e.returnValue = process.platform === 'darwin' ? 'mac' : 'win'; });
  ipcMain.on('getVersion', (e) => { e.returnValue = app.getVersion(); });

  ipcMain.on('originalRunning', (e) => { e.returnValue = originalIsRunning(); });

  ipcMain.on('signAes', (e, { secret, text }) => {
    try { e.returnValue = signAes(secret, text); } catch (err) { e.returnValue = ''; }
  });
  ipcMain.on('signDecodeAes', (e, { secret, text }) => {
    try { e.returnValue = signDecodeAes(secret, text); } catch (err) { e.returnValue = ''; }
  });

  // ---- WebDAV（原版第三方同步协议）----
  const wrap = (fn) => async (evt, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };

  const davTarget = (cfg) => ({
    base: webdav.resolveBase(cfg.syncType, cfg.customUrl),
    auth: webdav.basicAuth(cfg.username, cfg.password),
    selfSigned: !!cfg.selfSigned
  });

  ipcMain.handle('webdavBase', wrap((cfg) => webdav.resolveBase(cfg.syncType, cfg.customUrl)));

  ipcMain.handle('webdavCheck', wrap(async (cfg) => {
    const t = davTarget(cfg);
    if (!t.base) throw new Error('还没有填写 WebDAV 地址');
    if (!t.auth) throw new Error('还没有填写账号');
    return webdav.check(t.base, t.auth, t.selfSigned);
  }));

  ipcMain.handle('webdavGetDiaryJson', wrap(async (cfg) => {
    const t = davTarget(cfg);
    return webdav.getDiaryJson(t.base, t.auth, t.selfSigned);
  }));

  ipcMain.handle('webdavPutDiaryJson', wrap(async ({ cfg, payload }) => {
    const t = davTarget(cfg);
    return webdav.putDiaryJson(t.base, t.auth, payload, t.selfSigned);
  }));

  ipcMain.handle('webdavGetSi', wrap(async (cfg) => {
    const t = davTarget(cfg);
    const raw = await webdav.getSyncInfoRaw(t.base, t.auth, t.selfSigned);
    if (!raw) return null;
    try {
      return JSON.parse(signDecodeAes(SYNC_SECRET, raw));
    } catch (e) {
      return { __undecodable: true, raw: String(raw).slice(0, 200) };
    }
  }));

  ipcMain.handle('webdavPutSi', wrap(async ({ cfg, info }) => {
    const t = davTarget(cfg);
    const cipher = signAes(SYNC_SECRET, JSON.stringify(info));
    return webdav.putSyncInfoRaw(t.base, t.auth, cipher, t.selfSigned);
  }));

  ipcMain.handle('webdavUploadImage', wrap(async ({ cfg, localPath }) => {
    const t = davTarget(cfg);
    return webdav.uploadImage(t.base, t.auth, localPath, t.selfSigned);
  }));

  ipcMain.handle('webdavSign', wrap(({ text }) => signAes(SYNC_SECRET, text)));

  ipcMain.handle('blur', async () => { if (mainWindow) mainWindow.blur(); });

  ipcMain.handle('saveFile', async (e, { url, fileName, file }) => {
    try {
      const res = await dialog.showSaveDialog(mainWindow, { defaultPath: fileName });
      if (res.canceled || !res.filePath) return '';
      if (file && fs.existsSync(file)) fs.copyFileSync(file, res.filePath);
      return res.filePath;
    } catch (err) {
      return '';
    }
  });

  ipcMain.handle('exportTextFile', async (e, { fileName, content }) => {
    const res = await dialog.showSaveDialog(mainWindow, { defaultPath: fileName });
    if (res.canceled || !res.filePath) return '';
    fs.writeFileSync(res.filePath, content, 'utf8');
    return res.filePath;
  });

  ipcMain.handle('importTextFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (res.canceled || !res.filePaths.length) return '';
    return fs.readFileSync(res.filePaths[0], 'utf8');
  });

  // ---- 备份文件：与原版 data/{userId}{syncType} 双向兼容 ----
  ipcMain.handle('saveData', async (e, { name, text }) => {
    ensureDirs();
    try {
      fs.writeFileSync(path.join(DATA_DIR, String(name)), backupEncrypt(String(text)));
      return true;
    } catch (err) {
      return false;
    }
  });

  ipcMain.handle('getData', async (e, { name }) => {
    ensureDirs();
    const p = path.join(DATA_DIR, String(name));
    if (!fs.existsSync(p)) return '';
    try {
      return backupDecrypt(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      return '';
    }
  });

  ipcMain.handle('listDataFiles', async () => {
    ensureDirs();
    try {
      return fs.readdirSync(DATA_DIR).filter((f) => fs.statSync(path.join(DATA_DIR, f)).isFile());
    } catch (err) {
      return [];
    }
  });

  ipcMain.handle('deleteData', async (e, { name }) => {
    const p = path.join(DATA_DIR, String(name));
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  });

  // ---- 本地图片：与原版 userData/images 一致 ----
  ipcMain.handle('saveImage', async (e, { sourcePath }) => {
    ensureDirs();
    const ext = path.extname(sourcePath) || '.jpeg';
    const name = crypto.randomUUID().replace(/-/g, '') + ext;
    fs.copyFileSync(sourcePath, path.join(IMAGES_DIR, name));
    return name;
  });

  ipcMain.handle('saveImageBuffer', async (e, { buffer, ext }) => {
    ensureDirs();
    const name = crypto.randomUUID().replace(/-/g, '') + (ext || '.jpeg');
    fs.writeFileSync(path.join(IMAGES_DIR, name), Buffer.from(buffer));
    return name;
  });

  ipcMain.handle('imageExists', async (e, { name }) => fs.existsSync(path.join(IMAGES_DIR, name)));

  ipcMain.handle('deleteImage', async (e, { name }) => {
    const p = path.join(IMAGES_DIR, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  });

  ipcMain.handle('listImages', async () => {
    ensureDirs();
    try {
      return fs.readdirSync(IMAGES_DIR).filter((f) => fs.statSync(path.join(IMAGES_DIR, f)).isFile());
    } catch (err) {
      return [];
    }
  });

  ipcMain.handle('openExternal', async (e, { url }) => { shell.openExternal(url); });

  ipcMain.handle('copyText', async (e, { text }) => { clipboard.writeText(String(text)); return true; });

  ipcMain.handle('readTextFile', async (e, { filePath }) => {
    try { return fs.readFileSync(filePath, 'utf8'); } catch (err) { return ''; }
  });

  ipcMain.handle('writeTextFile', async (e, { filePath, content }) => {
    try { fs.writeFileSync(filePath, content, 'utf8'); return true; } catch (err) { return false; }
  });

  // ---- 右键菜单：替代原版的 popCopyRightMenu / popEditRightMenu ----
  const editMenu = Menu.buildFromTemplate([
    { role: 'undo', label: '撤销' },
    { role: 'redo', label: '重做' },
    { type: 'separator' },
    { role: 'cut', label: '剪切' },
    { role: 'copy', label: '复制' },
    { role: 'paste', label: '粘贴' },
    { role: 'selectAll', label: '全选' }
  ]);
  ipcMain.on('popEditRightMenu', () => { editMenu.popup({ window: mainWindow }); });
}
