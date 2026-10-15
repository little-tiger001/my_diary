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

| 内容 | 位置 | 格式 |
|---|---|---|
| 日记 / 分类 / 标签 / 模板 / 历史 / 草稿 | `%APPDATA%\一本日记\IndexedDB\file__0.indexeddb.leveldb` | IndexedDB，库名 `diary`，版本 3 |
| 本地图片 | `%APPDATA%\一本日记\images\` | 文件名即 `localImages` 字段里的值 |
| 加密备份 | `%APPDATA%\一本日记\data\{userId}{syncType}` | AES-256-ECB，hex |
| 远端快照 | `%APPDATA%\一本日记\mydiary-remote-backup\` | 覆盖云端 `diary.json` 之前留的底，只保留最近 5 份 |

前三项都在官方客户端的数据目录里，本程序不另建目录。
最后一项 `mydiary-remote-backup/` 是本程序唯一自建的目录，官方客户端不认识它、也不会去动它。

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

### 两条重要的写入约定

**1. 本程序写入的所有记录一律设置 `synced = 1` 与 `isSynced = 1`。**

官方客户端把 `synced = 0` 视为「待上传」，会把这些记录推到厂商云端。
设为 1 可以确保**用本程序写的日记不会被上传到厂商服务器**。

**2. 删除日记是打墓碑（`deleted = 1`），不是把记录抹掉。**

官方格式靠 `deleted` 标志 + `uuid` 表达「这条被删了」。如果直接硬删除，
远端仍留着这条记录，下次同步按 `uuid` 在本地查不到，就会把它当成新记录**重新插回来**——
删掉的日记复活，而且删除永远传不到手机端。所以 `deleteDiary` 走的是
`db.diary.update(id, { deleted: 1, ... })`，与分类的 `isDeleted`、标签的 `deleted` 一致。

列表、统计、日历都按 `deleted` 过滤，界面上看不到已删除的记录。

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

`${base}` 就是设置页里填的 WebDAV 地址，本程序不内置任何云盘预设。
官方客户端的 sync_type（坚果云 / box / 自定义）只是替它自己选 base 的开关，
远端布局与认证方式在所有 base 下完全相同——所以想和用坚果云的官方客户端互通，
直接填 `https://dav.jianguoyun.com/dav` 就行，协议层面没有区别。
认证走 `Authorization: Basic base64(账号:密码)`；若云盘提供**应用密码**，
要填应用密码而不是登录密码。

遇到 3xx 会按**同样的方法与请求体**重发（最多 5 跳），并且**只跟同主机的跳转**：
请求头里带着 Basic 账号密码，跟到别的主机等于把密码发给第三方。同主机 http → https 允许。

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
| diary | `deleted` / `isHidden` / **`isSynced`** → 布尔；`category` 挪到 `type`，`category` 置空 |
| category | `isDeleted` → 布尔 |
| recordModel | `isDelete` / `isDefault` → 布尔 |
| tag | `deleted` / `lock` → 布尔 |

本程序对**副本**做转换，不回写本地；下载时再反向还原。本地主键 `id` 不会写进远端。

**`isSynced` 必须是布尔，`synced` / `top` 必须是数字，空的数值字段必须删键——这几条不是可选项。**
官方 PC 端的上传函数里根本没有 `isSynced`（它的 app.asar 里搜不到这个字符串），
但手机端（Java + Gson）把它声明成 `boolean`——手机自己上传的云端记录里就是 `true`。
本地库按 `0/1` 存，原样发 `1` 会让手机端解析整份 `diary.json` 时抛

```
java.lang.IllegalStateException: Expected a BOOLEAN but was NUMBER at line 1 ...
```

也就是手机上那句「同步出错」，而且整份云端数据都读不进去。
反过来 `synced` 官方 PC 上传的就是数字（`synced: 0`），`top` 是置顶时间戳
（置顶 `top: Date.now()` / 取消 `top: 0`），这两个不要"顺手"也转成布尔。

同样地，`latitude` / `longitude` / `temperature` 在手机端是按 `double` 解析的，
而 Android 的 `StringToReal` 对空串直接抛 `NumberFormatException("empty String")`
（界面显示成「同步出错: EMPTY STRING」）。本地这三项按 `''` 存"没填"，
所以上传副本里**值为空就删掉这个键**，不要发 `""`；有值（数字或数字字符串）原样保留。
官方 PC 端从不构造这三个字段（`temperature` 这个字面量在它的 asar 里都不存在），
手机自己上传的记录里也没有这几个键，删键与它们的行为一致。

`tools/smoke_sync.js` 里有一张按手机端模型逐字段核对类型的断言表 + 空串数值字段断言，
加新字段时照它的方式补。**改完 `diary.json` 的字节形状要同步 `REMOTE_FORMAT` +1**
（见下），否则水位线会把这次改动判成「无需同步」，修好的格式永远推不上去。

### si 文件

`base64(AES-256-CBC(sha256(口令), IV=16个0, JSON))`，明文是：

```json
{ "t": 毫秒时间戳, "d": 1, "dv": "pc", "id": 本机设备标识 }
```

### 同步流程

```
MKCOL ${base}/diary/
  → GET si
     若 si.t 与本地记录的 s_t 相同、没有待上传图片、且本地没有比上次上传更新的记录 → 结束
     若 si.d 大于本程序支持的数据版本 → 提示需要更新
  → GET diary.json 并合并
  → 上传待传的本地图片
  → GET diary.json 原文，存进 mydiary-remote-backup/（留底）
  → PUT diary.json
  → PUT si（写入新的 t，让对方下次拉取）
```

**「无需同步」是三个条件，缺一不可。** `si.t` 与本地 `s_t` 相同只说明「云端没被别人动过」；
而本程序写库时一律 `synced = 1`（见上），所以「本地有没有还没推上去的改动」看不了 `synced`。
每次上传成功后会把**这次真正推上去的那批记录里最大的 `updateTime`** 记成水位线
（`lastUploadTs`，存在 WebDAV 配置里），下次同步拿它和表里当前的 `updateTime` 比，更大就还要推。
少了这条判据会出现：「自己上传完 → 再改一篇日记 → 点同步」被判成「云端与本地一致，无需同步」，
改动一直推不上去，只能等手机端先同步把 `si.t` 顶掉。
水位线取自**这次真正上传的行**而不是事后重新扫表，所以上传过程中新改的内容不会被它盖住；
没有水位线时（第一次同步、刚换了云盘账号）一律当作有改动——宁可白推一次全量。

**保存后会自动同步**（设置页可关掉），编辑页右上角另有「同步」按钮，不必切到设置页。
三个入口（编辑页按钮、设置页三个按钮、保存后自动同步）共用一把锁：正在同步时再触发只记一次
"排队"，跑完补做一次，避免两个同步交叉执行、互相覆盖远端。没配 WebDAV 时自动同步静默跳过。

**留底这一步是硬性的：拿不到快照就不往远端写。**
同步是全量 PUT、没有增量，一旦本地数据有问题，覆盖上去就把云端记录销毁了。
快照保留最近 5 份，设置页会显示最后一份的文件名。

**远端数据读不出来时中止同步，不会静默当成空。**
`diary.json` 的四个键都是双重编码的字符串，任何一个 `JSON.parse` 失败都会直接报错返回。
以前是吞掉异常当成空数组，紧接着就用本地全量覆盖远端——等于把读不出来的云端数据销毁。

### 合并规则

按 `uuid` 匹配，四张表的整个合并过程在**一个 IndexedDB 事务**里完成，
中途失败不会留下半合并状态：

- 本地已存在且 `updateTime` 更旧 → 用远端覆盖
- 本地已存在、`updateTime` 相同、但本地 `synced = 0` → 只把 `synced` 补成 1
- 本地不存在 → 插入；但远端 `deleted` 且无 `historyTime` 的跳过（不必在本地建墓碑）
- 分类 / 标签 / 模板同理，远端已删除的跳过

批量写用的是 `bulkPut`，它是**整条替换**而不是字段合并，
所以覆盖分支必须先 `Object.assign({}, 本地记录, 远端字段)`，
才能保住远端没带的本地字段（`isSynced` / `device` / `bt` / `m` / `ind` 等）。

### 图片上传的一个细节

只有**真的传上去了**才刷新那条日记的 `updateTime`。
一张都没传成功时不能碰时间戳：合并规则是 `updateTime` 大者胜，
白刷一次会让本地这份陈旧记录在下次同步时压过手机端的新编辑。

### 图片

本地图 `abc.jpeg` 上传为 `${base}/diary/abc_<字节数>.jpeg`，
成功后该 URL 进入日记的 `images`（`|` 分隔），同时把文件名从 `localImages` 移除。

---

## 功能

- 日记增删改查，正文为 Markdown（源码 / 预览切换）
- 标题、日期、天气、地点、分类、标签
- 本地图片：选择文件或直接粘贴剪贴板图片，存入 `images/`；
  移除图片后保存时会把不再被引用的文件从 `images/` 删掉，不留孤儿
- 未保存改动保护：切换日记或新建之前会拦一下，不会静默丢掉写了半天的内容
- 保存后自动同步（可在设置页关掉）；编辑页右上角也有「同步」按钮，不用切到设置页
- 日历视图（按月，有日记的日期显示计数）
- 全文搜索（标题 + 正文），按分类 / 标签筛选
- 统计：总篇数、总字数、写作天数、当前连续天数，以及每年 / 每月 / 分类三张图
- 本地备份：导出 / 导入加密备份文件；另有 JSON 导入导出
- WebDAV 同步：与官方客户端互通（见上），覆盖云端前自动留底
未实现：官方「默认云」账号体系、会员、模板管理界面、历史版本界面、草稿界面、
隐藏日记的密码锁。`recordModel` / `history` / `draft` 三张表已按格式建立，只是还没有对应界面。

---

## 目录结构

```
my_diary/
  package.json          依赖、构建与打包配置
  src/
    main.js             主进程：数据目录、IPC、两套加密、图片与备份读写、远端快照
    preload.js          contextBridge：fileApi / webdav
    schema.js           Dexie 库结构声明，渲染进程与测试脚本共用同一份
    webdav.js           WebDAV 客户端（Node http/https，绕开渲染进程 CORS）
  renderer/
    index.html          Vue 模板
    app.js              数据层 + 全部界面逻辑 + 同步流程
    style.css
  vendor/               运行时的第三方库副本，由 npm run sync-vendor 生成（不进仓库）
  tools/                构建与测试脚本，见下
  build/                生成的图标
  release/              打包产物（不进仓库）
```

`src/schema.js` 是一段 UMD：`index.html` 用 `<script>` 引入时挂到 `window.MYDIARY_SCHEMA`，
测试脚本 `require` 时走 `module.exports`。之前这份声明在 `app.js`、`smoke.js`、
`smoke_write.js` 里各抄了一遍——抄本一旦漂移，那个「校验 schema 与官方一致」的测试
反而会给出假信号。

---

## 从零开始（clone 之后）

```bash
git clone git@github.com:little-tiger001/my_diary.git
cd my_diary
npm install
npm start
```

要出安装包和装到本机：

```bash
npm run dist
```

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

### 两个可能踩到的点

**1. Electron 二进制没下载下来。** `npm install` 会触发 `electron` 的 postinstall 去下载
约 90 MB 的运行时。如果这一步被跳过（比如 npm 配置了忽略安装脚本），
`node_modules/electron/dist/electron.exe` 就不存在，`npm start` 会直接失败。手动补：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node node_modules\electron\install.js
```

**2. 国内网络下载 electron-builder 的辅助二进制很慢或失败。** 先设好镜像和缓存目录：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_BUILDER_CACHE="$PWD\.eb-cache"
npm run dist
```

如果 `electron-builder` 报临时文件相关的错误（`!tempfile: Unable to create temporary file`），
把 `TEMP` 指到项目内再跑：

```powershell
$env:TEMP="$PWD\.tmp"; $env:TMP="$PWD\.tmp"
npm run dist
```

---

## 开发与构建

```bash
npm install          # 需要 electron@19.1.9
npm start            # 直接运行（会先同步 vendor/）
npm test             # 跑全部测试，只用临时目录，不碰真实数据
npm run dist         # 打包（产物在 release/）
```

**Electron 版本必须是 19.1.9。** 因为与官方客户端共用同一个 Chromium profile 目录，
跨大版本可能引发 profile 格式不兼容。

`vendor/` 里的 vue / dexie / markdown-it / echarts 是从 `node_modules` 拷出来的副本，
不进仓库；`npm start` 和 `npm run dist` 都会自动先执行 `npm run sync-vendor`。
单独执行用 `npm run sync-vendor`。

### 打包注意

产物输出到 `release/`：

```
release/
  win-unpacked/                未压缩的程序目录（安装脚本用的就是它）
  我的日记-安装包-1.0.0.exe      NSIS 安装包
```

`package.json` 里已设 `electronDist: node_modules/electron/dist`，避免重新下载 Electron。
`signAndEditExecutable: false` 跳过签名与 exe 改写（不需要证书），
因此 **exe 本身没有自定义图标和版本信息**：标题栏与任务栏图标靠 `main.js` 里的
`BrowserWindow.icon`，按 `resources/icon.ico`（`extraResources` 打进去的那份，NSIS 安装用的是这个）
→ exe 同级 `icon.ico`（`install.ps1` 复制的那份）→ 仓库 `build/icon.ico`（开发时）顺序找；
快捷方式图标则由 `build/icon.ico` 指定。图标用 `node tools/make_icon.js` 重新生成
（纯 Node 手写 PNG/ICO，4 倍超采样抗锯齿，ICO 内含 16/32/48/64/128/256 六个尺寸）。

**在本项目目录里重新打包可能报 `EBUSY`。**
症状：第二次 `npm run dist` 替换 `release\win-unpacked\resources\app.asar` 时报
`EBUSY: resource busy or locked, unlink ...`；这个文件删不掉、改不了名、也无法独占打开，
但**同目录的其他文件一切正常**。
已实测排除 Seafile：本机客户端登记的同步库只有 `科大云盘\大四上` 与 `科大云盘\keepass`，
不含本目录；把 seaf 进程挂起期间锁也不释放。RestartManager 同样查不到持有者，
所以最可能是某个以 SYSTEM 身份运行的扫描组件（杀软 / 索引服务）在内核态持有句柄——
这类句柄用户态工具看不到，**重启一次即可清掉**。
在查清之前，稳妥做法是把产物输出到项目目录外，避免"替换已存在的大文件"这一步：

```bash
npx electron-builder --win nsis --config.directories.output="%LOCALAPPDATA%\mydiary-build"
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Source "%LOCALAPPDATA%\mydiary-build\win-unpacked"
```

`install.ps1` 的 `-Source` 不传时默认仍是 `release\win-unpacked`，行为不变。

---

## 安装到本机

```powershell
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

把 `release/win-unpacked` 复制到 `%LOCALAPPDATA%\Programs\我的日记`，
创建开始菜单与桌面快捷方式（指向随包的 `icon.ico`），并写入 HKCU 卸载项。
卸载脚本 `uninstall.ps1` 会一并生成到安装目录。

---

## tools/

| 脚本 | 用途 |
|---|---|
| `run_tests.js` | **测试总入口**，`npm test` 调的就是它 |
| `sync_vendor.js` | 从 `node_modules` 同步运行时库到 `vendor/` |
| `make_icon.js` | 纯 Node 手写 PNG + ICO 生成图标 |
| `install.ps1` | 手动安装到本机；`-Source` 可指向别的构建产物目录（`release/` 里的文件被锁时用） |
| `smoke.js` | 只读冒烟测试：打开库、校验表结构、读出全部记录 |
| `smoke_write.js` | 写入测试：新增 → 读回 → 更新 → 删除墓碑 → 图片存取 → 路径穿越拦截 |
| `smoke_ui.js` | UI 交互测试：+ 按钮 / 弹窗 / 删除确认 / 侧栏刷新 / 未保存改动拦截 |
| `dav_server.js` | 内存版最小 WebDAV 服务器；`/__dump` 查看存储、`/__reset` 清空 |
| `smoke_sync.js` | 端到端同步协议测试（40 项断言） |
| `smoke_isolated.js` | 在系统临时目录建一个全新 profile，单独验证 IndexedDB 本身能否打开，用于排查共享目录 / LOCK 的干扰 |
| `probe_dialogs.js` | 探测 Electron 里 prompt / confirm / alert 的可用性 |
| `cdp.js` | 极简 CDP 客户端，对运行中的应用执行 JS |
| `shot.js` | 连 CDP 切换视图并截图 |

### 跑测试

```bash
npm test
```

一条命令跑完全部 5 组，**全程在系统临时目录里，不会碰到 `%APPDATA%\一本日记` 的真实数据**。
`smoke_sync.js` 自己起 DAV 服务器、自己清空远端存储；空库还会自动播种两条记录，
所以刚 clone 下来、一份日记都没有也能跑通。

想用真实数据验证更有说服力（字段都是官方客户端写的）：

```bash
npm test -- "%APPDATA%\一本日记"
```

脚本会先把该目录**复制**一份到临时目录，再在副本上跑，原件不会被改动。

单独跑某一个（`smoke_ui.js` / `smoke_write.js` / `smoke_sync.js` 会写库，
必须显式指定数据目录，不设就直接退出）：

```powershell
$env:MYDIARY_USER_DATA='<一份数据目录副本>'
node_modules\electron\dist\electron.exe tools\smoke_sync.js
Get-Content _sync_test.log
```

---

## 已知限制

- 与官方客户端互斥运行（见文首）。
- 不实现官方「默认云」账号体系，也**不会**与厂商服务器通信。
- 第三方同步是**全量上传 + 按 `uuid` / `updateTime` 合并**：没有增量传输，
  也没有冲突的人工确认。不要同时在官方客户端和本程序上编辑同一条日记，
  `updateTime` 较新的会覆盖较旧的。覆盖远端前会自动留底（见「同步流程」），
  真出事了可以从 `mydiary-remote-backup/` 里捞回来。
- 删除走墓碑，所以**删掉的记录会一直留在库里**（`deleted = 1`），数据库不会因此变小。
  这是官方格式的表达方式，也是删除能同步到手机端的前提；界面上看不到它们。
  目前没有「彻底清除所有已删除记录」的入口。
- 正文按 Markdown 渲染；若历史记录里混有 HTML，会以纯文本安全显示
  （`markdown-it` 的 `html: false`）。
- `renderer/index.html` 的 CSP 允许 `unsafe-eval`，因为用的是 Vue 完整版
  （运行时编译模板）。纯本地应用，不加载任何远程内容。
- WebDAV 账号密码明文存在 `localStorage`（键 `mydiary_webdav`），
  而这份 `localStorage` 与官方客户端共用。官方客户端自己也是这么存 `auth` 的。
- **渲染进程给的路径一律当不可信输入**：`saveImage` 只接受真实存在的图片扩展名文件，
  上传接口只允许上传 `images/` 目录里的文件，备份文件名只取 basename。
  这三处早先都直接信任渲染进程传来的路径，等于把「读本机任意文件并传到云盘」的能力
  交给了页面。残留的一点口子：名为 `xxx.png` 的文件即使内容不是图片也仍会被复制进来并上传，
  想彻底关掉就得取消「从磁盘挑图片」这个用法。
- 可以给本程序单独指定数据目录：设环境变量 `MYDIARY_USER_DATA` 指向一份副本即可
  （用于测试，或想与官方客户端隔离运行）。

### 改代码时的七个坑

1. **不要用 `window.prompt()`**。Electron 明确不支持，调用即抛
   `Error: prompt() is and will not be supported.`。在 async 事件处理里这个异常会被
   吞成 unhandled rejection，表现为「按钮点了没反应」。本程序统一用自绘弹窗
   （`askText` / `askConfirm`）。
2. **`file://` 页面共享同一个 IndexedDB**（`IndexedDB/file__0.indexeddb.leveldb`），
   所以渲染进程的加载路径换了也仍指向同一个 `diary` 库。
3. **`tools/install.ps1` 必须保存为 UTF-8 with BOM**（文件头为 `EF BB BF`）。
   Windows PowerShell 5.1 对没有 BOM 的文件按 ANSI 解码，脚本里的中文会变乱码。
   很多编辑器保存时会悄悄去掉 BOM，改完这个文件记得确认一下。
4. **`bulkPut` 是整条替换，不是字段合并**。`db.diary.update(id, { a: 1 })` 只改 `a`；
   `bulkPut([{ id, a: 1 }])` 会把整条记录变成只剩 `{ id, a: 1 }`，其余字段全丢。
   合并逻辑里每个覆盖分支都必须先 `Object.assign({}, 本地记录, 远端字段)`，
   否则 `isSynced` / `device` / `bt` / `m` / `ind` 这些远端不带的字段会被抹掉。
5. **库结构声明只在 `src/schema.js` 里改**。不要在别处再抄一份：
   抄本一旦漂移，那个「校验 schema 与官方一致」的测试反而会给出假信号。
6. **删除记录一律打墓碑**（`deleted = 1` / `isDeleted = 1`），不要 `db.xxx.delete()`。
   硬删除的记录在远端还留着，下次同步会被当成新记录重新插回来。
   `tools/` 里测试结束时的清理是例外——那些是测试自己造的数据，本来就该抹干净。
7. **判断「本地有没有未推送的改动」不要看 `synced`。** 本程序写库一律置 `synced = 1`
   （那是为了不让官方客户端把记录传到厂商云），所以同步开头那句「无需同步」必须带上
   水位线 `lastUploadTs`——上传成功后记下的、这次真正推上去的最大 `updateTime`。
   删掉这条判据不会报错，只会静默丢掉本地改动，并且界面还告诉你「云端与本地一致」。

---

## 第三方依赖

运行时用到 Vue 3、Dexie、markdown-it、echarts（均为 MIT）；
构建与打包用到 Electron、electron-builder。以上版权归各自作者所有。
