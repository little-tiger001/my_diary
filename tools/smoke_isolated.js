// 隔离测试：用临时 userData，排除共享目录/LOCK 的影响，判断 IndexedDB 本身能否打开。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const tmp = path.join(os.tmpdir(), 'mydiary-isolated-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
app.setPath('userData', tmp);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  });
  await win.loadURL('data:text/html,<html><body>x</body></html>');

  const r = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const req = indexedDB.open('probe', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('s', { keyPath: 'id' });
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put({ id: 1, v: 'hello' });
        tx.oncomplete = () => {
          const tx2 = db.transaction('s', 'readonly');
          const g = tx2.objectStore('s').get(1);
          g.onsuccess = () => resolve({ ok: true, value: g.result && g.result.v, dbs: 'opened' });
          g.onerror = () => resolve({ ok: false, error: 'get failed' });
        };
      };
      req.onerror = () => resolve({ ok: false, error: String(req.error) });
      req.onblocked = () => resolve({ ok: false, error: 'blocked' });
    })
  `);
  console.log('ISOLATED IDB RESULT: ' + JSON.stringify(r));
  console.log('userData used: ' + tmp);
  app.exit(r && r.ok ? 0 : 1);
});
