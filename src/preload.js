const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sign', {
  md5: (s) => s, // 本地应用不需要签名，保留占位以兼容原版调用点
  base64: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
  decodeBase64: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
  aes: (secret, text) => ipcRenderer.sendSync('signAes', { secret, text }),
  decodeAes: (secret, text) => ipcRenderer.sendSync('signDecodeAes', { secret, text })
});

contextBridge.exposeInMainWorld('api', {
  getOS: () => ipcRenderer.sendSync('getOS'),
  getVersion: () => ipcRenderer.sendSync('getVersion'),
  originalRunning: () => ipcRenderer.sendSync('originalRunning'),
  openUrl: (url) => ipcRenderer.invoke('openExternal', { url }),
  copy: (text) => ipcRenderer.invoke('copyText', { text }),
  blur: () => ipcRenderer.invoke('blur'),
  showEditMenu: () => ipcRenderer.send('popEditRightMenu')
});

contextBridge.exposeInMainWorld('fileApi', {
  getPath: () => ipcRenderer.sendSync('getPath'),

  saveData: (name, text) => ipcRenderer.invoke('saveData', { name, text }),
  getData: (name) => ipcRenderer.invoke('getData', { name }),
  listDataFiles: () => ipcRenderer.invoke('listDataFiles'),
  deleteData: (name) => ipcRenderer.invoke('deleteData', { name }),

  saveImage: (sourcePath) => ipcRenderer.invoke('saveImage', { sourcePath }),
  saveImageBuffer: (buffer, ext) => ipcRenderer.invoke('saveImageBuffer', { buffer, ext }),
  imageExists: (name) => ipcRenderer.invoke('imageExists', { name }),
  deleteImage: (name) => ipcRenderer.invoke('deleteImage', { name }),
  listImages: () => ipcRenderer.invoke('listImages'),
  getImageUrl: (name) => 'file://' + ipcRenderer.sendSync('getPath') + '/images/' + name,
  getLocalImage: (name) => ipcRenderer.sendSync('getPath') + '/images/' + name,

  exportTextFile: (fileName, content) => ipcRenderer.invoke('exportTextFile', { fileName, content }),
  importTextFile: () => ipcRenderer.invoke('importTextFile'),
  readTextFile: (filePath) => ipcRenderer.invoke('readTextFile', { filePath }),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('writeTextFile', { filePath, content })
});

contextBridge.exposeInMainWorld('webdav', {
  base: (cfg) => ipcRenderer.invoke('webdavBase', cfg),
  check: (cfg) => ipcRenderer.invoke('webdavCheck', cfg),
  getDiaryJson: (cfg) => ipcRenderer.invoke('webdavGetDiaryJson', cfg),
  putDiaryJson: (cfg, payload) => ipcRenderer.invoke('webdavPutDiaryJson', { cfg, payload }),
  getSi: (cfg) => ipcRenderer.invoke('webdavGetSi', cfg),
  putSi: (cfg, info) => ipcRenderer.invoke('webdavPutSi', { cfg, info }),
  uploadImage: (cfg, localPath) => ipcRenderer.invoke('webdavUploadImage', { cfg, localPath }),
  sign: (text) => ipcRenderer.invoke('webdavSign', { text })
});
