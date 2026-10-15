// 端到端同步协议测试（健壮版）
//   起本地 WebDAV -> 用数据副本启动应用 -> 完整同步 -> 校验远端格式 -> 校验反向合并
//   -> 校验删除墓碑 -> 校验覆盖前留底 -> 校验远端损坏时中止
// 空库会自动播种，所以干净检出 + 一个临时 userData 就能跑，不必先准备真实数据副本。
// 结果同时写入 _sync_test.log，避免管道缓冲导致看不到输出。
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { app, BrowserWindow } = require('electron');

const USER_DATA = process.env.MYDIARY_USER_DATA;
const DAV_PORT = Number(process.env.DAV_PORT || 8099);
const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, '_sync_test.log');
const DAV_URL = `http://127.0.0.1:${DAV_PORT}/dav`;
const SNAPSHOT_DIR = path.join(USER_DATA || '', 'mydiary-remote-backup');

if (!USER_DATA) { console.error('需要 MYDIARY_USER_DATA'); process.exit(2); }
app.setPath('userData', USER_DATA);

// 复用真实主进程的 IPC 注册，保证测的是应用本身的代码路径
const appMain = require(path.join(ROOT, 'src', 'main.js'));
const webdav = require(path.join(ROOT, 'src', 'webdav.js'));

fs.writeFileSync(LOG, '', 'utf8');
function log(line) {
  fs.appendFileSync(LOG, line + '\n', 'utf8');
  process.stdout.write(line + '\n');
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
}

function finish(code) {
  const failed = results.filter((r) => !r.ok);
  log('\n==== ' + (results.length - failed.length) + '/' + results.length + ' passed ====');
  if (failed.length) log('FAILED: ' + failed.map((f) => f.name).join('; '));
  app.exit(code);
}

process.on('unhandledRejection', (e) => { log('UNHANDLED REJECTION: ' + (e && e.stack || e)); finish(3); });
process.on('uncaughtException', (e) => { log('UNCAUGHT: ' + (e && e.stack || e)); finish(3); });
setTimeout(() => { log('!! 硬超时 180 秒，强制结束'); finish(4); }, 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dump() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${DAV_PORT}/__dump`, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(c).toString('utf8'))));
    }).on('error', reject);
  });
}

function remoteFile(files, p) {
  return files.find((f) => f.path === p);
}

// DAV 服务器是常驻的内存存储，开头先清空，测试才能重复运行
function resetRemote() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${DAV_PORT}/__reset`, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
}

function decodeSi(b64) {
  const key = Buffer.from(crypto.createHash('sha256').update('9ejc8kdq').digest('hex'), 'hex');
  const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16, 0));
  return JSON.parse(d.update(b64, 'base64', 'utf8') + d.final('utf8'));
}

function putRemote(bodyStr) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(bodyStr, 'utf8');
    const req = http.request(
      { hostname: '127.0.0.1', port: DAV_PORT, path: '/dav/diary/diary.json', method: 'PUT', headers: { 'Content-Length': data.length } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function loadAndWait(win, fn, label) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { log('WARN 等待 ' + label + ' 超时'); resolve(); }, 20000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); resolve(); });
    fn();
  });
}

let win;

async function js(code, label) {
  try {
    return await win.webContents.executeJavaScript(code, true);
  } catch (e) {
    log('JS ERROR [' + label + ']: ' + (e && e.message || e));
    return undefined;
  }
}

const count = () => js(`(async () => (await window.__mydiary.db.diary.toArray()).length)()`, 'count');
const resetStamp = () => js(`localStorage.setItem('s_t','0'); true;`, 'reset s_t');

app.whenReady().then(async () => {
  appMain.ensureDirs();
  appMain.registerIpc();
  log('IPC 已注册，userData=' + app.getPath('userData'));

  await resetRemote();
  // 清掉上一轮留下的快照，否则"留了快照"这条断言会被旧文件蒙过去
  if (fs.existsSync(SNAPSHOT_DIR)) {
    for (const f of fs.readdirSync(SNAPSHOT_DIR)) fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
  }

  win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });

  await loadAndWait(win, () => win.loadURL('file://' + path.join(ROOT, 'renderer', 'index.html')), 'first load');
  await sleep(1500);

  // 直接注入 WebDAV 配置，避免 reload（reload 的 did-finish-load 在此环境下不触发）
  await js(`
    window.__mydiary.sync.setCfg({
      customUrl: ${JSON.stringify(DAV_URL)},
      username: 'tester', password: 'secret', selfSigned: false
    }); true;
  `, 'set dav cfg');

  const state = await js(`({
    ready: !!(window.__mydiary && window.__mydiary.sync),
    schema: typeof MYDIARY_SCHEMA !== 'undefined' ? MYDIARY_SCHEMA.DB_VERSION : 0,
    fatal: document.querySelector('.fatal-msg') ? document.querySelector('.fatal-msg').textContent : '',
    mounted: !!document.querySelector('.topbar')
  })`, 'state');
  log('页面状态: ' + JSON.stringify(state));
  check('应用已挂载并暴露同步入口', !!(state && state.ready), state && state.fatal ? '致命错误:' + state.fatal : '');
  check('库结构声明来自共享的 src/schema.js', !!(state && state.schema === 3), 'DB_VERSION=' + (state && state.schema));
  if (!state || !state.ready) return finish(1);

  // 空库自动播种，让测试不依赖真实数据
  let before = await count();
  if (!before) {
    log('库是空的，播种两条测试记录');
    await js(`(async () => {
      const db = window.__mydiary.db;
      const now = Date.now();
      const d = new Date(now);
      const mk = (uuid, title) => ({
        title, content: '# ' + title, createTime: now, updateTime: now, recordTime: now,
        images: '', localImages: '', city: '', address: '', temperature: '', weather: '', color: '',
        dayOfMonth: d.getDate(), monthOfYear: d.getMonth() + 1, year: d.getFullYear(),
        latitude: '', longitude: '', deleted: 0, uuid, synced: 1, isSynced: 1, isHidden: 0,
        device: 'pc', category: '', type: '', audio: '', localAudio: '', contentType: 0, tag: '', top: 0
      });
      await db.diary.bulkAdd([mk('seed-aaaa-1', '播种一'), mk('seed-bbbb-2', '播种二')]);
      return true;
    })()`, 'seed');
    before = await count();
  }
  check('本地库里有日记', before > 0, 'count=' + before);

  // 给一条记录填上真的数值和数字字符串：修复"空串删键"时不能把有值的也一起删掉
  await js(`(async () => {
    const all = await window.__mydiary.db.diary.toArray();
    await window.__mydiary.db.diary.update(all[0].id, {
      latitude: 39.9042, longitude: 116.4074, temperature: '31.2'
    });
    return true;
  })()`, 'set numerics');

  // ---------- 第一次同步 ----------
  const syncErr = await js(`(async () => {
    try { await window.__mydiary.sync.now(); return ''; }
    catch (e) { return String(e && e.message || e); }
  })()`, 'sync.now');
  check('sync.now() 未抛异常', syncErr === '', syncErr || '');

  const davState = await js(`window.__mydiary.sync.state()`, 'dav state');
  log('同步状态: ' + JSON.stringify(davState));
  check('同步未记录错误', !(davState && davState.lastError), (davState && davState.lastError) || '');

  const d1 = await dump();
  log('远端文件: ' + JSON.stringify(d1.dirs) + ' ' + JSON.stringify(d1.files.map((f) => f.path)));
  check('创建了 diary 目录', d1.dirs.includes('/dav/diary'), d1.dirs.join(','));
  const dj = remoteFile(d1.files, '/dav/diary/diary.json');
  const si = remoteFile(d1.files, '/dav/diary/si');
  check('写入了 diary.json', !!dj);
  check('写入了 si', !!si);

  let obj = null;
  if (dj) {
    try { obj = JSON.parse(dj.body); } catch (e) { log('diary.json 解析失败: ' + e.message); }
    check('diary.json 是合法 JSON', !!obj);
  }
  if (obj) {
    const keys = Object.keys(obj).sort();
    check('四个键名与原版一致（含拼写错误 catagory）',
      JSON.stringify(keys) === JSON.stringify(['catagory', 'json', 'model', 'tag']), JSON.stringify(keys));
    let list = null;
    try { list = JSON.parse(obj.json); } catch (e) { /* ignore */ }
    check('json 是双重编码的数组', Array.isArray(list));
    if (Array.isArray(list)) {
      check('日记条数与本地一致', list.length === before, `remote=${list.length} local=${before}`);
      const s = list[0];
      check('deleted 已转布尔', typeof s.deleted === 'boolean', 'typeof=' + typeof s.deleted);
      check('isHidden 已转布尔', typeof s.isHidden === 'boolean', 'typeof=' + typeof s.isHidden);
      // isSynced 曾经没转布尔，手机端（Java + Gson）解析整份 diary.json 时直接抛
      // "Expected a BOOLEAN but was NUMBER"，界面上就是"同步出错"。
      // 依据：官方 PC 的 b() 里没有这个字段（asar 里搜不到），而手机自己上传的记录里是 boolean。
      check('isSynced 已转布尔（手机端 Gson 要求）', typeof s.isSynced === 'boolean', 'typeof=' + typeof s.isSynced);
      // synced 相反：官方 PC 上传的就是数字（synced: 0），不要"顺手"也转成布尔
      check('synced 仍是数字（与官方 PC 上传一致）', typeof s.synced === 'number', 'typeof=' + typeof s.synced);
      // 手机端模型的字段类型，取自 2026-10-13 手机自己上传到云端的记录快照。
      // 逐字段核对，防止再有字段被写成手机端接受不了的类型。
      const PHONE_TYPES = {
        isSynced: 'boolean', deleted: 'boolean',
        year: 'number', monthOfYear: 'number', dayOfMonth: 'number',
        createTime: 'number', updateTime: 'number', recordTime: 'number',
        uuid: 'string', content: 'string', device: 'string'
      };
      const typeMismatch = [];
      for (const row of list) {
        for (const field of Object.keys(PHONE_TYPES)) {
          if (row[field] !== undefined && typeof row[field] !== PHONE_TYPES[field]) {
            typeMismatch.push(field + '=' + typeof row[field]);
          }
        }
      }
      check('每个字段的类型都和手机端模型一致', typeMismatch.length === 0, typeMismatch.join(',') || '全部一致');

      // 手机端按 double 解析 latitude / longitude / temperature：空串会让 Android 的
      // StringToReal 抛 NumberFormatException("empty String")，界面显示成
      // "同步出错: EMPTY STRING"。本地按 '' 存"没填"，上传时必须删掉这个键。
      const localEmpty = await js(`(async () => {
        const all = await window.__mydiary.db.diary.toArray();
        return all.filter((d) => ['latitude', 'longitude', 'temperature'].some((f) => d[f] === '')).length;
      })()`, 'local empty numerics');
      check('本地确实存在空串的数值字段（保证下面的断言不空转）', localEmpty > 0, 'count=' + localEmpty);

      const emptyNumerics = [];
      for (const row of list) {
        for (const field of ['latitude', 'longitude', 'temperature']) {
          if (row[field] === '' || row[field] === null) emptyNumerics.push(field);
        }
      }
      check('上传副本里没有空串的数值字段', emptyNumerics.length === 0, emptyNumerics.join(',') || '干净');
      check('有值的数值字段原样保留（数字与数字字符串都不改写）',
        list.some((r) => r.latitude === 39.9042) && list.some((r) => r.temperature === '31.2'),
        'latitude 保留=' + list.some((r) => r.latitude === 39.9042) +
        ' temperature 保留=' + list.some((r) => r.temperature === '31.2'));
      check('category 已挪到 type', !list.some((x) => x.category), 'hasType=' + list.some((x) => x.type));
      check('未泄漏本地主键 id', !('id' in s));
      check('保留 uuid / updateTime', !!s.uuid && typeof s.updateTime === 'number');
    }
    check('catagory 可解析为数组', Array.isArray(JSON.parse(obj.catagory)));
  }

  if (si) {
    let info = null;
    try { info = decodeSi(si.body.trim()); } catch (e) { info = { __err: e.message }; }
    check('si 能用 9ejc8kdq 解密（与原版同算法）', !info.__err, info.__err || JSON.stringify(info));
    if (!info.__err) {
      check('si 含 t/d/dv/id', 't' in info && 'd' in info && 'dv' in info && 'id' in info, JSON.stringify(info));
      check('si.d == 1', Number(info.d) === 1);
      check('si.dv == pc', info.dv === 'pc');
    }
  }

  // ---------- 反向合并 ----------
  const NEW_UUID = 'davtest-1111-2222-3333-444444444444';
  if (obj) {
    const remoteList = JSON.parse(obj.json);
    remoteList.push({
      uuid: NEW_UUID, title: '来自云端的测试条目', content: 'hello from remote',
      createTime: Date.now(), updateTime: Date.now() + 100000, recordTime: Date.now(),
      year: 2026, monthOfYear: 1, dayOfMonth: 1,
      deleted: false, isHidden: false, synced: true,
      category: '', type: '云端分类', tag: '', images: '', localImages: ''
    });
    await putRemote(JSON.stringify(Object.assign({}, obj, { json: JSON.stringify(remoteList) })));
    await resetStamp();
    await js(`window.__mydiary.sync.download()`, 'download');
    await sleep(1000);

    const merged = await js(`(async () => {
      const d = await window.__mydiary.db.diary.where('uuid').equals(${JSON.stringify(NEW_UUID)}).first();
      return d ? { title: d.title, category: d.category, type: d.type, deleted: d.deleted, isHidden: d.isHidden, synced: d.synced } : null;
    })()`, 'check merge');
    check('远端新日记已合并到本地', !!merged, JSON.stringify(merged));
    if (merged) {
      check('远端 type 还原为 category', merged.category === '云端分类' && merged.type === '', JSON.stringify(merged));
      check('远端布尔 deleted 还原为 0/1', merged.deleted === 0 || merged.deleted === 1, 'deleted=' + merged.deleted);
      check('合并后 synced=1', Number(merged.synced) === 1);
    }
  }

  // ---------- 本地改动必须被推上去（不再靠 resetStamp 兜） ----------
  // 同步开头那句"云端 si.t 与本地 s_t 相同且没有待传图片 -> 无需同步"如果没有
  // 「本地还有没有比上次上传更新的记录」这条判据，就会出现：
  //   sync（记住 s_t = si.t）-> 改一篇日记 -> sync -> 被判成"云端与本地一致，无需同步"
  // 改动永远推不上去，只能等手机端先同步把 si.t 顶掉。这段就是那条判据的回归测试。
  const LOCAL_UUID = 'davtest-local-8888-9999-000000000000';
  await js(`(async () => {
    const now = Date.now();
    const d = new Date(now);
    await window.__mydiary.db.diary.add({
      title: '本地改动一', content: 'x', createTime: now, updateTime: now, recordTime: now,
      dayOfMonth: d.getDate(), monthOfYear: d.getMonth() + 1, year: d.getFullYear(),
      images: '', localImages: '', deleted: 0, uuid: ${JSON.stringify(LOCAL_UUID)},
      synced: 1, isSynced: 1, isHidden: 0, device: 'pc', category: '', type: '',
      audio: '', localAudio: '', contentType: 0, tag: '', top: 0
    });
    return true;
  })()`, 'add local record');

  await resetStamp();
  await js(`window.__mydiary.sync.now()`, 'sync to set s_t');
  await sleep(800);
  // s_t 现在等于云端 si.t，下面这次同步不会再靠 resetStamp 绕过"无需同步"的判断
  await js(`(async () => {
    const db = window.__mydiary.db;
    const r = await db.diary.where('uuid').equals(${JSON.stringify(LOCAL_UUID)}).first();
    // 水位线是"表里所有记录最大的 updateTime"，而本节前面刚合并过一条 updateTime 在未来的
    // 远端记录（+100000），所以本地这次改动必须取当前最大值再往上加，才算真的更新。
    const rows = await db.diary.toArray();
    const max = rows.reduce((m, d) => Math.max(m, Number(d.updateTime) || 0), 0);
    await db.diary.update(r.id, { title: '本地改动二', updateTime: max + 10000 });
    return max;
  })()`, 'edit local record');
  const stBefore = await js(`({
    s_t: localStorage.getItem('s_t'),
    lastUploadTs: window.__mydiary.sync.state().lastUploadTs
  })`, 'stamp before');
  await js(`window.__mydiary.sync.now()`, 'sync after local edit');
  await sleep(800);

  const dLocal = await dump();
  const listLocal = (() => {
    const f = remoteFile(dLocal.files, '/dav/diary/diary.json');
    try { return f ? JSON.parse(JSON.parse(f.body).json) : []; } catch (e) { return []; }
  })();
  const pushed = listLocal.find((x) => x.uuid === LOCAL_UUID);
  check('本地改动没有被"无需同步"挡下，已推到远端',
    !!pushed && pushed.title === '本地改动二',
    pushed ? '远端标题=' + pushed.title + ' 水位线=' + JSON.stringify(stBefore) : '远端没有这条');

  // 反过来：真的没有改动时那句判断必须还能命中，否则每次同步都要全量拉 + 全量推
  const idle = await js(`(async () => {
    await window.__mydiary.sync.now();
    await new Promise((r) => setTimeout(r, 300));
    const n = document.querySelector('.notice');
    return { text: n ? n.textContent : '', error: window.__mydiary.sync.state().lastError };
  })()`, 'idle sync');
  check('没有改动时仍然判定"无需同步"',
    !!(idle && /无需同步/.test(idle.text) && !idle.error), JSON.stringify(idle));

  // 升级后我们这侧改了云端序列化格式（比如 isSynced 改布尔）：本地数据没变、s_t 也还等于
  // si.t，但那次必须强制重推一遍。否则修好的格式永远上不去，手机端一直读到旧的坏 payload
  // ——真实踩过：修好 isSynced 后点同步，界面显示"无需同步"，手机继续报同步出错。
  const fmt = await js(`(async () => {
    window.__mydiary.sync.setCfg({ lastUploadFormat: 0 });
    await window.__mydiary.sync.now();
    await new Promise((r) => setTimeout(r, 300));
    const n = document.querySelector('.notice');
    return { text: n ? n.textContent : '', format: window.__mydiary.sync.state().lastUploadFormat };
  })()`, 'format stale sync');
  check('我们这侧改了序列化格式会强制重推一遍',
    !!(fmt && /同步完成/.test(fmt.text) && Number(fmt.format) > 0), JSON.stringify(fmt));

  const idle2 = await js(`(async () => {
    await window.__mydiary.sync.now();
    await new Promise((r) => setTimeout(r, 300));
    const n = document.querySelector('.notice');
    return { text: n ? n.textContent : '', error: window.__mydiary.sync.state().lastError };
  })()`, 'idle sync after format sync');
  check('重推之后又恢复"无需同步"',
    !!(idle2 && /无需同步/.test(idle2.text) && !idle2.error), JSON.stringify(idle2));

  // ---------- 删除墓碑 ----------
  // 硬删除的话远端仍留着这条，下次合并按 uuid 查不到本地就会把它重新插回来。
  const TOMB_UUID = 'davtest-tomb-5555-6666-777777777777';
  await js(`(async () => {
    const now = Date.now();
    const d = new Date(now);
    await window.__mydiary.db.diary.add({
      title: '待删除', content: 'x', createTime: now, updateTime: now, recordTime: now,
      dayOfMonth: d.getDate(), monthOfYear: d.getMonth() + 1, year: d.getFullYear(),
      images: '', localImages: '', deleted: 0, uuid: ${JSON.stringify(TOMB_UUID)},
      synced: 1, isSynced: 1, isHidden: 0, device: 'pc', category: '', type: '',
      audio: '', localAudio: '', contentType: 0, tag: '', top: 0
    });
    return true;
  })()`, 'add record to delete');

  await resetStamp();
  await js(`window.__mydiary.sync.now()`, 'sync upload new record');
  await sleep(800);
  const d2 = await dump();
  const list2 = (() => {
    const f = remoteFile(d2.files, '/dav/diary/diary.json');
    try { return f ? JSON.parse(JSON.parse(f.body).json) : []; } catch (e) { return []; }
  })();
  check('新建的日记已上传到远端', list2.some((x) => x.uuid === TOMB_UUID));

  await js(`(async () => {
    const db = window.__mydiary.db;
    const r = await db.diary.where('uuid').equals(${JSON.stringify(TOMB_UUID)}).first();
    await db.diary.update(r.id, { deleted: 1, updateTime: Date.now(), synced: 1, isSynced: 1 });
    return true;
  })()`, 'soft delete');

  await resetStamp();
  await js(`window.__mydiary.sync.now()`, 'sync after delete');
  await sleep(800);
  const d3 = await dump();
  const list3 = (() => {
    const f = remoteFile(d3.files, '/dav/diary/diary.json');
    try { return f ? JSON.parse(JSON.parse(f.body).json) : []; } catch (e) { return []; }
  })();
  const remoteTomb = list3.find((x) => x.uuid === TOMB_UUID);
  check('删除以墓碑形式传到远端（deleted=true）', !!remoteTomb && remoteTomb.deleted === true,
    remoteTomb ? 'deleted=' + remoteTomb.deleted : '远端没有这条');

  const localTomb = await js(`(async () => {
    const r = await window.__mydiary.db.diary.where('uuid').equals(${JSON.stringify(TOMB_UUID)}).first();
    return r ? { deleted: r.deleted, title: r.title } : null;
  })()`, 'check resurrection');
  check('同步后本地墓碑仍在，没有被远端复活', !!localTomb && localTomb.deleted === 1, JSON.stringify(localTomb));

  const tombVisible = await js(`(async () => {
    await window.__mydiary.sync.now();
    await new Promise((r) => setTimeout(r, 400));
    return [...document.querySelectorAll('.card-title')]
      .map((e) => e.textContent)
      .filter((t) => t.indexOf('待删除') >= 0).length;
  })()`, 'list excludes tombstone');
  check('已删除的日记不出现在列表里', tombVisible === 0, '命中卡片数=' + tombVisible);

  // ---------- 覆盖远端前留底 ----------
  const snapFiles = fs.existsSync(SNAPSHOT_DIR)
    ? fs.readdirSync(SNAPSHOT_DIR).filter((f) => /^diary-.*\.json$/.test(f)).sort()
    : [];
  check('覆盖远端前在 mydiary-remote-backup/ 留了快照', snapFiles.length > 0, snapFiles.join(','));
  if (snapFiles.length) {
    let snapOk = false;
    let snapHasTomb = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, snapFiles[snapFiles.length - 1]), 'utf8'));
      const l = JSON.parse(parsed.json);
      snapOk = Array.isArray(l);
      snapHasTomb = l.some((x) => x.uuid === TOMB_UUID);
    } catch (e) { log('快照解析失败: ' + e.message); }
    check('快照是完整可用的 diary.json', snapOk);
    check('快照里能找到已知记录', snapHasTomb, '含测试 uuid=' + snapHasTomb);
  }

  // ---------- 远端数据损坏时必须中止，不能覆盖 ----------
  const CORRUPT = JSON.stringify({ json: '{ 这不是合法 JSON', catagory: '[]', model: '[]', tag: '[]' });
  await putRemote(CORRUPT);
  await resetStamp();
  await js(`window.__mydiary.sync.now()`, 'sync against corrupt remote');
  await sleep(800);
  const stCorrupt = await js(`window.__mydiary.sync.state()`, 'state after corrupt');
  check('远端数据损坏时报错而不是静默当成空', !!(stCorrupt && stCorrupt.lastError), (stCorrupt && stCorrupt.lastError) || '');
  const d4 = await dump();
  const dj4 = remoteFile(d4.files, '/dav/diary/diary.json');
  check('损坏的远端数据没有被本地全量覆盖', !!dj4 && dj4.body === CORRUPT, dj4 ? dj4.body.slice(0, 50) : '远端文件不见了');

  // ---------- 重定向 ----------
  // 云盘把 http 挑到 https、或把路径归一化时会回 3xx。客户端必须跟随（且只跟同主机：
  // 请求头里带着 Basic 账号密码，跨主机跟过去等于把密码发给第三方）。
  // 这里直接用 webdav.js 自己打，不经过界面，断言的是客户端行为本身。
  const REDIRECT_BASE = DAV_URL + '/__redirect__';
  let direct = null, redirected = null, redirectErr = '';
  try {
    direct = await webdav.getDiaryJsonText(DAV_URL, '', false);
    redirected = await webdav.getDiaryJsonText(REDIRECT_BASE, '', false);
  } catch (e) { redirectErr = String(e.message || e); }
  check('GET 会跟随同主机 302 重定向', !redirectErr && !!redirected && redirected === direct,
    redirectErr || ('直连 ' + (direct ? direct.length : 'null') + ' 字节 / 重定向 ' + (redirected ? redirected.length : 'null') + ' 字节'));

  // putDiaryJson 收的是对象（它自己 JSON.stringify），所以这里用一份能一眼认出来的内容
  const redirectPayload = { json: 'redirect-ok', catagory: '[]', model: '[]', tag: '[]' };
  let putRedirectErr = '';
  try { await webdav.putDiaryJson(REDIRECT_BASE, '', redirectPayload, false); } catch (e) { putRedirectErr = String(e.message || e); }
  const d5 = await dump();
  const dj5 = remoteFile(d5.files, '/dav/diary/diary.json');
  check('PUT 会跟随同主机 302 重定向',
    putRedirectErr === '' && !!dj5 && dj5.body === JSON.stringify(redirectPayload),
    putRedirectErr || (dj5 ? dj5.body.slice(0, 40) : '远端文件不见了'));

  let crossErr = '';
  try { await webdav.getDiaryJsonText(DAV_URL + '/__crosshost__', '', false); } catch (e) { crossErr = String(e.message || e); }
  check('跨主机重定向被拒绝（不把账号密码带过去）', crossErr.indexOf('其它主机') >= 0, crossErr || '居然没有报错');

  // ---------- 清理测试记录 ----------
  await js(`(async () => {
    const db = window.__mydiary.db;
    const all = await db.diary.toArray();
    const ids = all.filter((d) => /^(seed-|davtest-)/.test(d.uuid || '')).map((d) => d.id);
    if (ids.length) await db.diary.bulkDelete(ids);
    return ids.length;
  })()`, 'cleanup');

  finish(results.some((r) => !r.ok) ? 1 : 0);
});
