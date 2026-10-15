# my_diary 工程约定

规格、数据格式、同步协议、运维细节都在 `README.md`，动手前先读它。本文件只写「怎么干活」和最容易踩的几条。

## 改文件

- 源文件里有中文注释。**不要用 PowerShell 文本管道改**（`Get-Content -Raw | Set-Content` 会按 ANSI 往返一遍，注释变乱码，页面直接挂成 `{{ dbError }}`）；用编辑工具按字面替换。
- 库结构声明只在 `src/schema.js` 里改一份，别在别处再抄——抄本漂移会让「校验 schema 与官方一致」的测试给出假信号。

## 验证

- 改完一律跑 `npm test`：5 组（smoke / smoke_write / smoke_ui / smoke_sync×2，同步组各 40 项断言），全部在系统临时目录里跑，不碰 `%APPDATA%\一本日记` 的真实数据。
- 单独跑 `smoke_write.js` / `smoke_ui.js` / `smoke_sync.js` 必须显式给 `MYDIARY_USER_DATA`，否则直接退出。
- 加行为断言要做**反向验证**：把新判据临时改成恒假（如 `localPending = false`）重跑 `npm test`，确认**只有**新断言变红、旧断言照常通过。否则断言可能永远为真，给假信号。

## 改动前的硬约束

完整清单见 README「改代码时的七个坑」，最容易踩的几条：

- 删除一律打墓碑（`deleted = 1` / `isDeleted = 1`），不要 `db.xxx.delete()`，否则记录会在下次同步里复活。
- `bulkPut` 是整条替换，覆盖分支必须先 `Object.assign({}, 本地记录, 远端字段)`。
- 不要用 `window.prompt()`（Electron 调用即抛），用自绘弹窗。
- `tools/install.ps1` 必须保存为 UTF-8 with BOM。
- 写库一律 `synced = 1`（避免官方客户端上传到厂商云）；判断「本地有没有未推送的改动」必须带 `lastUploadTs` 水位线，不能看 `synced`。
- 上传副本里的字段类型是**跨端契约**：`isSynced` / `deleted` / `isHidden` 必须是布尔（手机端 Java + Gson 严格解析，传数字会让它整份 diary.json 读不进去、报「同步出错」），`synced` / `top` 必须是数字，`latitude` / `longitude` / `temperature` 为空时必须**删键**（手机端按 double 解析，空串触发 Android 的 `NumberFormatException("empty String")`）。加字段时照 `tools/smoke_sync.js` 里那张按手机端模型核对类型的断言表补一条。依据可查：官方 PC 客户端 `%LOCALAPPDATA%\Programs\day-pc\resources\app.asar` 的上传函数 `b()`；手机端的字段形状看 `%APPDATA%\一本日记\mydiary-remote-backup\` 里 2026-10-13 那份快照。
- **改了 `diary.json` 的字节形状就把 `renderer/app.js` 里的 `REMOTE_FORMAT` +1**。水位线只能证明「本地数据没变」，证明不了「发出去的字节没变」；不 +1 就会被判成「无需同步」，修好的格式永远推不上去。

## 运行环境

- 与原版《一本日记》共用 `%APPDATA%\一本日记` 的 IndexedDB，两者不能同时运行；测试或隔离运行用 `MYDIARY_USER_DATA` 指向副本。
- Electron 必须 19.1.9（共用同一份 Chromium profile），库结构必须与官方同为 v3。
