const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
// 本程序自己的目录：覆盖远端 diary.json 之前留的底。
// 原版不认识这个目录，不会去动它。
const SNAPSHOT_DIR = path.join(USER_DATA, 'mydiary-remote-backup');
const SNAPSHOT_KEEP = 5;

// 原版硬编码密钥，用于 data/ 目录下的备份文件（AES-256-ECB，hex）
const BACKUP_SECRET = '2909246C549D656546C40576393A78802F787959012E551EADE697707B4579C0';
const BACKUP_KEY = Buffer.from(BACKUP_SECRET, 'hex');

// 第三方同步 si 文件用的固定口令
const SYNC_SECRET = '9ejc8kdq';

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

// 同步是全量 PUT，没有增量：一旦本地数据有问题，覆盖上去就把云端记录销毁了。
// 所以每次写远端之前先把当前的 diary.json 原样存一份，只保留最近几份。
function writeSnapshot(text) {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const name = 'diary-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  fs.writeFileSync(path.join(SNAPSHOT_DIR, name), text, 'utf8');
  const old = fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((f) => /^diary-.*\.json$/.test(f))
    .sort();
  while (old.length > SNAPSHOT_KEEP) fs.unlinkSync(path.join(SNAPSHOT_DIR, old.shift()));
  return name;
}

let mainWindow = null;

/* 窗口与任务栏图标。打包配置里 signAndEditExecutable=false（不签也不改 exe），
 * 所以 exe 自身带的仍是 Electron 图标，标题栏/任务栏只能靠这里指定，按顺序找：
 *   1) 安装目录的 resources/icon.ico（electron-builder 的 extraResources 放的那份）
 *   2) exe 同级的 icon.ico（tools/install.ps1 会复制一份）
 *   3) 仓库里的 build/icon.ico（开发时跑 electron . 用）
 */
function resolveIcon() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.ico') : '',
    path.join(path.dirname(process.execPath), 'icon.ico'),
    path.join(__dirname, '..', 'build', 'icon.ico')
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: '我的日记',
    icon: resolveIcon(),
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

module.exports = {
  registerIpc,
  ensureDirs,
  writeSnapshot,
  SHARED_USER_DATA,
  USER_DATA,
  DATA_DIR,
  IMAGES_DIR,
  SNAPSHOT_DIR
};

// 暴露给渲染进程的接口只保留真正用到的那些。
// 之前还挂着一批没人调用的桥接，其中 readTextFile / writeTextFile 接受任意路径，
// 等于把整个文件系统读写交给页面——纯负担的攻击面，已删除。
// 剩下这几个仍然收路径的接口（saveImage / webdavUploadImage）都在下面各自校验了来源。
function registerIpc() {
  ipcMain.on('getPath', (e) => { e.returnValue = USER_DATA; });

  // ---- WebDAV（原版第三方同步协议）----
  const wrap = (fn) => async (evt, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };

  const davTarget = (cfg) => ({
    base: webdav.resolveBase(cfg.customUrl),
    auth: webdav.basicAuth(cfg.username, cfg.password),
    selfSigned: !!cfg.selfSigned
  });

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

  // 覆盖远端前留底；远端还没有 diary.json 时返回 null（首次同步，无底可留）
  ipcMain.handle('webdavSnapshotRemote', wrap(async (cfg) => {
    const t = davTarget(cfg);
    const text = await webdav.getDiaryJsonText(t.base, t.auth, t.selfSigned);
    return text ? writeSnapshot(text) : null;
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
    if (!insideImages(localPath)) throw new Error('只能上传 images/ 目录里的本地图片：' + localPath);
    const t = davTarget(cfg);
    return webdav.uploadImage(t.base, t.auth, localPath, t.selfSigned);
  }));

  // ---- 备份文件：与原版 data/{userId}{syncType} 双向兼容 ----
  // 名字来自共享 localStorage（b / sync_type），和图片名一样按不可信输入校验：
  // 不校验的话 "../../x" 就能写到数据目录外。
  const dataFileName = (name) => {
    const base = path.basename(String(name));
    if (!base || base !== String(name) || base === '.' || base === '..') throw new Error('备份文件名不合法：' + name);
    return path.join(DATA_DIR, base);
  };

  ipcMain.handle('saveData', async (e, { name, text }) => {
    ensureDirs();
    try {
      fs.writeFileSync(dataFileName(name), backupEncrypt(String(text)));
      return true;
    } catch (err) {
      return false;
    }
  });

  ipcMain.handle('getData', async (e, { name }) => {
    ensureDirs();
    let p;
    try {
      p = dataFileName(name);
    } catch (err) {
      return '';
    }
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

  // ---- 本地图片：与原版 userData/images 一致 ----
  // 名字一律是本程序自己生成的 uuid + 扩展名，这里再校验一次，避免路径穿越写到目录外。
  const imageName = (name) => {
    const base = path.basename(String(name));
    if (!base || base !== String(name) || base === '.' || base === '..') throw new Error('图片名不合法：' + name);
    return path.join(IMAGES_DIR, base);
  };

  // 能进 images/ 的扩展名。saveImage 走的是「用户在文件框里挑一个文件，主进程复制进来」，
  // 来源路径是渲染进程给的，属于不可信输入：不校验就等于给了页面一个
  // 「把本机任意文件复制进图片目录」的口子。
  const IMAGE_EXTS = new Set([
    '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.apng', '.gif', '.webp',
    '.bmp', '.ico', '.svg', '.heic', '.heif', '.avif', '.tif', '.tiff'
  ]);

  const safeExt = (ext, fallback) =>
    IMAGE_EXTS.has(String(ext || '').toLowerCase()) ? String(ext).toLowerCase() : fallback;

  // 上传只允许上传 images/ 目录里的图。渲染进程给的 localPath 一律当不可信输入：
  // 之前直接交给 fs.readFileSync 再 PUT 出去，等于"读本机任意文件并传到云盘"。
  const insideImages = (p) => {
    const abs = path.resolve(String(p || ''));
    return abs.startsWith(path.resolve(IMAGES_DIR) + path.sep);
  };

  ipcMain.handle('saveImage', async (e, { sourcePath }) => {
    ensureDirs();
    const src = path.resolve(String(sourcePath || ''));
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('图片文件不存在：' + sourcePath);
    const ext = path.extname(src).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) throw new Error('不支持的文件类型：' + (ext || '(无扩展名)'));
    const name = crypto.randomUUID().replace(/-/g, '') + ext;
    fs.copyFileSync(src, path.join(IMAGES_DIR, name));
    return name;
  });

  ipcMain.handle('saveImageBuffer', async (e, { buffer, ext }) => {
    ensureDirs();
    const name = crypto.randomUUID().replace(/-/g, '') + safeExt(ext, '.jpeg');
    fs.writeFileSync(path.join(IMAGES_DIR, name), Buffer.from(buffer));
    return name;
  });

  ipcMain.handle('imageExists', async (e, { name }) => fs.existsSync(imageName(name)));

  ipcMain.handle('deleteImage', async (e, { name }) => {
    const p = imageName(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
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
}
