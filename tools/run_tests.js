/* 统一测试入口：npm test
 *
 * 所有测试都跑在临时目录里，绝不碰 %APPDATA%\一本日记 的真实数据。
 * 可选地传一个真实数据目录，脚本会先把它复制一份（去掉 Cache 之类的大目录和 LevelDB 的
 * LOCK 文件）再在副本上跑，这样既能用真实数据验证，又不会改动原件。
 *
 *   node tools/run_tests.js                     用全新空库跑（干净检出即可，等价于 CI）
 *   node tools/run_tests.js "<一份数据目录>"     先复制该目录，在副本上跑
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = require('electron'); // 在纯 Node 里 require，拿到的是 electron 可执行文件路径

// 只复制数据本身，跳过缓存（几百 MB，对测试没用）
const COPY_DIRS = ['IndexedDB', 'Local Storage', 'data', 'images'];
const COPY_FILES = ['config.json', 'Preferences', 'Local State'];

function log(msg) {
  process.stdout.write(msg + '\n');
}

function copyUserData(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of COPY_DIRS) {
    const from = path.join(src, d);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dst, d), { recursive: true });
  }
  for (const f of COPY_FILES) {
    const from = path.join(src, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, f));
  }
  // LevelDB 的 LOCK 是从原件带过来的，留着会让副本看起来正被别的进程占用
  removeLocks(dst);
}

function removeLocks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) removeLocks(p);
    else if (entry.name === 'LOCK') fs.unlinkSync(p);
  }
}

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON, [path.join(ROOT, 'tools', script)], {
      cwd: ROOT,
      env: Object.assign({}, process.env, env),
      stdio: 'inherit'
    });
    child.on('exit', (code) => resolve(code || 0));
    child.on('error', () => resolve(1));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startDavServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'dav_server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { DAV_PORT: String(port) }),
    stdio: 'ignore'
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(child); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('DAV 测试服务器起不来'));
        else setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });
}

(async () => {
  const source = process.argv[2];
  if (source && !fs.existsSync(source)) {
    log('数据目录不存在：' + source);
    process.exit(2);
  }

  const stamp = Date.now();
  const workRoot = path.join(os.tmpdir(), 'mydiary-tests-' + stamp);
  const dataA = path.join(workRoot, 'data-a'); // 前四个测试用
  const dataB = path.join(workRoot, 'data-b'); // 空库播种路径用
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(dataB, { recursive: true });

  if (source) {
    log('复制数据目录到临时副本（原件不会被改动）：' + source);
    copyUserData(source, dataA);
  } else {
    log('未指定数据目录，用全新空库跑');
    fs.mkdirSync(dataA, { recursive: true });
  }

  const port = await freePort();
  const dav = await startDavServer(port);
  log('DAV 测试服务器已启动，端口 ' + port + '\n');

  const suites = [
    { name: 'smoke.js       只读：schema / 挂载 / 读库', script: 'smoke.js', data: dataA },
    { name: 'smoke_write.js 写入：墓碑 / 图片 / 路径校验', script: 'smoke_write.js', data: dataA },
    { name: 'smoke_ui.js    界面：弹窗 / 分类标签 / 脏检查', script: 'smoke_ui.js', data: dataA },
    { name: 'smoke_sync.js  同步协议（真实数据）', script: 'smoke_sync.js', data: dataA },
    { name: 'smoke_sync.js  同步协议（空库自动播种）', script: 'smoke_sync.js', data: dataB }
  ];

  const failed = [];
  for (const s of suites) {
    log('======== ' + s.name + ' ========');
    const code = await run(s.script, { MYDIARY_USER_DATA: s.data, DAV_PORT: String(port) });
    if (code !== 0) failed.push(s.name + ' (exit ' + code + ')');
    log('');
  }

  dav.kill();

  log('======== 汇总 ========');
  if (failed.length) {
    log('失败 ' + failed.length + ' 项：\n  ' + failed.join('\n  '));
  } else {
    log('全部 ' + suites.length + ' 组测试通过');
  }
  log('临时数据目录：' + workRoot + '（可安全删除）');

  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  log('测试入口异常：' + ((e && e.stack) || e));
  process.exit(3);
});
