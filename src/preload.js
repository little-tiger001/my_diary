const { contextBridge, ipcRenderer } = require('electron');

// 只暴露界面真正调用的接口。之前这里还挂着 window.sign 整个命名空间、
// api.openUrl / copy / blur / showEditMenu、fileApi.readTextFile / writeTextFile 等，
// 渲染进程一处都没用到；其中任意路径读写文件的那两个是纯负担的攻击面。

contextBridge.exposeInMainWorld('fileApi', {
  getPath: () => ipcRenderer.sendSync('getPath'),

  saveData: (name, text) => ipcRenderer.invoke('saveData', { name, text }),
  getData: (name) => ipcRenderer.invoke('getData', { name }),
  listDataFiles: () => ipcRenderer.invoke('listDataFiles'),

  saveImage: (sourcePath) => ipcRenderer.invoke('saveImage', { sourcePath }),
  saveImageBuffer: (buffer, ext) => ipcRenderer.invoke('saveImageBuffer', { buffer, ext }),
  imageExists: (name) => ipcRenderer.invoke('imageExists', { name }),
  deleteImage: (name) => ipcRenderer.invoke('deleteImage', { name }),
  getImageUrl: (name) => 'file://' + ipcRenderer.sendSync('getPath') + '/images/' + name,
  getLocalImage: (name) => ipcRenderer.sendSync('getPath') + '/images/' + name,

  exportTextFile: (fileName, content) => ipcRenderer.invoke('exportTextFile', { fileName, content }),
  importTextFile: () => ipcRenderer.invoke('importTextFile')
});

contextBridge.exposeInMainWorld('webdav', {
  check: (cfg) => ipcRenderer.invoke('webdavCheck', cfg),
  getDiaryJson: (cfg) => ipcRenderer.invoke('webdavGetDiaryJson', cfg),
  putDiaryJson: (cfg, payload) => ipcRenderer.invoke('webdavPutDiaryJson', { cfg, payload }),
  snapshotRemote: (cfg) => ipcRenderer.invoke('webdavSnapshotRemote', cfg),
  getSi: (cfg) => ipcRenderer.invoke('webdavGetSi', cfg),
  putSi: (cfg, info) => ipcRenderer.invoke('webdavPutSi', { cfg, info }),
  uploadImage: (cfg, localPath) => ipcRenderer.invoke('webdavUploadImage', { cfg, localPath })
});
