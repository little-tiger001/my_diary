// 验证 Electron 里 prompt / confirm / alert 的实际行为
const path = require('path');
const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(__dirname, '..', '.tmp-probe'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html,<html><body>x</body></html>');
  const r = await win.webContents.executeJavaScript(`(() => {
    const out = { types: {
      prompt: typeof window.prompt,
      confirm: typeof window.confirm,
      alert: typeof window.alert
    } };
    try { out.promptReturn = String(window.prompt('t', 'd')); }
    catch (e) { out.promptThrew = e.name + ': ' + e.message; }
    return out;
  })()`, true);
  console.log(JSON.stringify(r, null, 2));
  app.exit(0);
});
