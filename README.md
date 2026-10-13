# 我的日记 (my_diary)

一个在本机自用的桌面日记应用。**数据格式与官方《一本日记》兼容**：可以直接读写已有的日记库，
也可以通过 WebDAV 与手机端《一本日记》双向同步。

基于 Electron + Vue 3，纯本地运行，不依赖任何服务端。

---

## 最重要的一件事

**本程序与官方《一本日记》不能同时运行。**

两者共用同一个数据目录下的 IndexedDB（Chromium LevelDB），而同一份 LevelDB
同一时刻只能被一个进程持有。同时打开时，后启动的那个会报
`Internal error opening backing store for indexedDB.open`。

切换使用时请先完全退出另一个（注意检查托盘图标）。看到错误页就退出另一方，再点「重试」。

---

## 数据位置与兼容性

所有数据都在官方客户端的数据目录里，本程序不另建目录：

| 内容 | 位置 | 格式 |
|---|---|---|
| 日记 / 分类 / 标签 / 模板 / 历史 / 草稿 | `%APPDATA%\一本日记\IndexedDB\file__0.indexeddb.leveldb` | IndexedDB，库名 `diary`，版本 3 |
| 本地图片 | `%APPDATA%\一本日记\images\` | 文件名即 `localImages` 字段里的值 |
| 加密备份 | `%APPDATA%\一本日记\data\{userId}{syncType}` | AES-256-ECB，hex |

### 库结构

六张表，版本号必须一致，否则 IndexedDB 打开会报 `VersionError`：

```
v1: diary / category / recordModel / tag
v2: history
v3: draft
```

`diary` 表的索引字段：

```
++id, title, content, createTime, updateTime, recordTime, images, localImages,
city, address, temperature, weather, color, dayOfMonth, monthOfYear, year,
latitude, longitude, deleted, uuid, synced, isHidden, device, category, type,
audio, localAudio, contentType, tag, historyTime, draw, localDraw, top, bt, m, ind
```

除此之外记录里还可能有 `isSynced` 等未建索引的字段，照原样保留即可。

### 字段约定

- `images`、`localImages`、`tag` 三个字段是 **`|` 分隔的字符串**，不是数组。
- `createTime` / `updateTime` / `recordTime` / `historyTime` 是**毫秒时间戳**。
- `deleted` / `isHidden` / `isDeleted` / `isDelete` 等在本地用 **0/1**，
  同步到远端时转成**布尔**。
- `category` 存的是分类**名称**，不是 id；每条日记最多一个分类。

### 两套加密

**1. 备份文件**（`data/` 目录）：`aes-256-ecb`，密钥是该格式固定的 32 字节 hex 常量，
明文 UTF-8 → 密文 hex。见 `src/main.js` 的 `backupEncrypt` / `backupDecrypt`。

**2. 同步信息文件**（`si`）：AES-256-CBC，key 为口令的 SHA-256 摘要原始字节，
**IV 是全零 16 字节**，UTF-8 ↔ base64。见 `src/main.js` 的 `signAes` / `signDecodeAes`。
口令是该格式的固定常量，定义在 `SYNC_SECRET`。

### 一条重要的写入约定

本程序写入的所有记录一律设置 `synced = 1` 与 `isSynced = 1`。

官方客户端把 `synced = 0` 视为「待上传」，会把这些记录推到厂商云端。
设为 1 可以确保**用本程序写的日记不会被上传到厂商服务器**。

---

## 与官方客户端同步（WebDAV）

设置页里配置云盘账号后，可以与本机/手机上的官方《一本日记》互相拉取。
实现的是与官方第三方同步兼容的协议。

### 远端布局

| 路径 | 内容 |
|---|---|
| `${base}/diary/diary.json` | 主数据 |
| `${base}/diary/si` | 同步信息，用于让对方知道「该拉取了」 |
| `${base}/diary/<文件名去扩展名>_<字节数>.<扩展名>` | 图片 |

`${base}` 由云盘类型决定：坚果云 `https://dav.jianguoyun.com/dav`、
box `https://dav.box.com/dav`、或自定义 URL。
认证走 `Authorization: Basic base64(账号:密码)`（坚果云要填**应用密码**，不是登录密码）。

### diary.json 的形状

四个键，每个值都是**再被 `JSON.stringify` 一次的字符串**（双重编码）：

```json
{
  "json":     "[{...日记...}]",
  "catagory": "[{...分类...}]",
  "model":    "[{...模板...}]",
  "tag":      "[{...标签...}]"
}
```

分类那个键名固定是 `catagory`（注意拼写），不是 `category`。

上传前的字段转换：

| 表 | 转换 |
|---|---|
| diary | `deleted` / `isHidden` → 布尔；`category` 挪到 `type`，`category` 置空 |
| category | `isDeleted` → 布尔 |
| recordModel | `isDelete` / `isDefault` → 布尔 |
| tag | `deleted` / `lock` → 布尔 |

本程序对**副本**做转换，不回写本地；下载时再反向还原。本地主键 `id` 不会写进远端。

### si 文件

`base64(AES-256-CBC(sha256(口令), IV=16个0, JSON))`，明文是：

```json
{ "t": 毫秒时间戳, "d": 1, "dv": "pc", "id": 本机设备标识 }
```

### 同步流程

```
MKCOL ${base}/diary/
  → GET si
     若 si.t 与本地记录的 s_t 相同、且没有待上传图片 → 结束
     若 si.d 大于本程序支持的数据版本 → 提示需要更新
  → GET diary.json 并合并
  → 上传待传的本地图片
  → PUT diary.json
  → PUT si（写入新的 t，让对方下次拉取）
```

### 合并规则

按 `uuid` 匹配：

- 本地已存在且 `updateTime` 更旧 → 用远端覆盖
- 本地不存在 → 插入；但远端 `deleted` 且无 `historyTime` 的跳过
- 分类 / 标签 / 模板同理，远端已删除的跳过

### 图片

本地图 `abc.jpeg` 上传为 `${base}/diary/abc_<字节数>.jpeg`，
成功后该 URL 进入日记的 `images`（`|` 分隔），同时把文件名从 `localImages` 移除。

---

## 功能

- 日记增删改查，正文为 Markdown（源码 / 预览切换）
- 标题、日期、天气、地点、分类、标签
- 本地图片：选择文件或直接粘贴剪贴板图片，存入 `images/`
- 日历视图（按月，有日记的日期显示计数）
- 全文搜索（标题 + 正文），按分类 / 标签筛选
- 统计：总篇数、总字数、写作天数、当前连续天数，以及每年 / 每月 / 分类三张图
- 本地备份：导出 / 导入加密备份文件；另有 JSON 导入导出
- WebDAV 同步：与官方客户端互通（见上）

未实现：官方「默认云」账号体系、会员、模板管理界面、历史版本界面、草稿界面、
隐藏日记的密码锁。`recordModel` / `history` / `draft` 三张表已按格式建立，只是还没有对应界面。

---

## 目录结构

```
my_diary/
  package.json          依赖、构建与打包配置
  src/
    main.js             主进程：数据目录、IPC、两套加密、图片与备份读写
    preload.js          contextBridge：sign / api / fileApi / webdav
    webdav.js           WebDAV 客户端（Node http/https，绕开渲染进程 CORS）
  renderer/
    index.html          Vue 模板
    app.js              数据层（Dexie 声明）+ 全部界面逻辑
    style.css
  vendor/               运行时的第三方库副本，由 npm run sync-vendor 生成（不进仓库）
  tools/                构建与测试脚本，见下
  build/                生成的图标
  dist/                 打包产物
```

---

## 开发与构建

```bash
npm install          # 需要 electron@19.1.9
npm start            # 直接运行（会先同步 vendor/）
npm run dist         # 打包（产物在 dist/）
```

**Electron 版本必须是 19.1.9。** 因为与官方客户端共用同一个 Chromium profile 目录，
跨大版本可能引发 profile 格式不兼容。

`vendor/` 里的 vue / dexie / markdown-it / echarts 是从 `node_modules` 拷出来的副本，
不进仓库；`npm start` 和 `npm run dist` 都会自动先执行 `npm run sync-vendor`。
单独执行用 `npm run sync-vendor`。

### 打包注意

`package.json` 里已设 `electronDist: node_modules/electron/dist`，避免重新下载 Electron。
`signAndEditExecutable: false` 跳过签名与 exe 改写（不需要证书），
因此 **exe 本身没有自定义图标和版本信息**，图标由快捷方式指定。

若 `electron-builder` 因下载缓存或临时文件失败，可显式指定目录：

```powershell
$env:TEMP='<项目>\.tmp'
$env:ELECTRON_BUILDER_CACHE='<项目>\.eb-cache'
npx electron-builder --win nsis
```

---

## 安装到本机

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

把 `dist/win-unpacked` 复制到 `%LOCALAPPDATA%\Programs\我的日记`，
创建开始菜单与桌面快捷方式（指向随包的 `icon.ico`），并写入 HKCU 卸载项。
卸载脚本 `uninstall.ps1` 会一并生成到安装目录。

---

## tools/

| 脚本 | 用途 |
|---|---|
| `sync_vendor.js` | 从 `node_modules` 同步运行时库到 `vendor/` |
| `make_icon.js` | 纯 Node 手写 PNG + ICO 生成图标 |
| `install.ps1` | 手动安装到本机 |
| `smoke.js` | 只读冒烟测试：打开库、校验表结构、读出全部记录 |
| `smoke_write.js` | 写入测试：新增 → 读回 → 更新 → 删除 |
| `dav_server.js` | 内存版最小 WebDAV 服务器，仅用于同步协议测试 |
| `smoke_sync.js` | 端到端同步协议测试（25 项断言） |
| `smoke_ui.js` | UI 交互测试：+ 按钮 / 弹窗 / 删除确认 / 侧栏刷新 |
| `probe_dialogs.js` | 探测 Electron 里 prompt / confirm / alert 的可用性 |
| `cdp.js` | 极简 CDP 客户端，对运行中的应用执行 JS |
| `shot.js` | 连 CDP 切换视图并截图 |

测试都支持指定独立数据目录，**不会碰到真实数据**：

```powershell
$env:MYDIARY_USER_DATA='<一份数据目录副本>'
node_modules\electron\dist\electron.exe tools\smoke.js
```

同步协议测试：

```powershell
node tools\dav_server.js                                    # 终端 A
$env:MYDIARY_USER_DATA='<一份数据目录副本>'                   # 终端 B
node_modules\electron\dist\electron.exe tools\smoke_sync.js
Get-Content _sync_test.log
```

---

## 已知限制

- 与官方客户端互斥运行（见文首）。
- 不实现官方「默认云」账号体系，也**不会**与厂商服务器通信。
- 第三方同步是**全量上传 + 按 `uuid` / `updateTime` 合并**：没有增量传输，
  也没有冲突的人工确认。不要同时在官方客户端和本程序上编辑同一条日记，
  `updateTime` 较新的会覆盖较旧的。
- 正文按 Markdown 渲染；若历史记录里混有 HTML，会以纯文本安全显示
  （`markdown-it` 的 `html: false`）。
- `renderer/index.html` 的 CSP 允许 `unsafe-eval`，因为用的是 Vue 完整版
  （运行时编译模板）。纯本地应用，不加载任何远程内容。
- 可以给本程序单独指定数据目录：设环境变量 `MYDIARY_USER_DATA` 指向一份副本即可
  （用于测试，或想与官方客户端隔离运行）。

### 改代码时的两个坑

1. **不要用 `window.prompt()`**。Electron 明确不支持，调用即抛
   `Error: prompt() is and will not be supported.`。在 async 事件处理里这个异常会被
   吞成 unhandled rejection，表现为「按钮点了没反应」。本程序统一用自绘弹窗
   （`askText` / `askConfirm`）。
2. **`file://` 页面共享同一个 IndexedDB**（`IndexedDB/file__0.indexeddb.leveldb`），
   所以渲染进程的加载路径换了也仍指向同一个 `diary` 库。

---

## 第三方依赖

运行时用到 Vue 3、Dexie、markdown-it、echarts（均为 MIT）；
构建与打包用到 Electron、electron-builder。以上版权归各自作者所有。
