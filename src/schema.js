/* Dexie 库结构声明 —— 与官方《一本日记》1.30.0 逐字一致，不要重排或增删字段。
 *
 * 这份声明同时被渲染进程（index.html 用 <script> 引入，挂到 window.MYDIARY_SCHEMA）
 * 和 tools/ 下的测试脚本（require）使用。之前它在 app.js / smoke.js / smoke_write.js
 * 里各抄了一遍：测试脚本抄本一旦漂移，校验就会给出假信号，而任何一处与官方不一致
 * 都会让 IndexedDB 抛 VersionError，或者写坏官方客户端读不了的数据。
 *
 * 版本号必须与官方一致（v1 四张表、v2 加 history、v3 加 draft），否则打开即 VersionError。
 */
(function (root, factory) {
  const schema = factory();
  if (typeof module === 'object' && module.exports) module.exports = schema;
  if (root) root.MYDIARY_SCHEMA = schema;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const stores = {
    1: {
      diary:
        '++id, title, content, createTime, updateTime, recordTime, images, localImages, city, address, temperature, weather, color, dayOfMonth, monthOfYear, year, latitude, longitude, deleted, uuid, synced, isHidden, device, category, type, audio, localAudio, contentType, tag, historyTime, draw, localDraw, top, bt, m, ind',
      category: '++id, name, count, pic, isDeleted, uuid, recordModelId, createTime, updateTime, synced',
      recordModel:
        '++id, content, position, order, title, contentType, name, uuid, isDelete, isDefault, createTime, updateTime, synced',
      tag: '++id, name, deleted, uuid, order, lock, createTime, updateTime, synced'
    },
    2: { history: '++id, content, uuid, createTime' },
    3: { draft: '++id, title, content, uuid, createTime, shown' }
  };

  return {
    DB_NAME: 'diary',
    DB_VERSION: 3,
    stores,
    apply(db) {
      for (const version of Object.keys(stores)) db.version(Number(version)).stores(stores[version]);
      return db;
    }
  };
});
