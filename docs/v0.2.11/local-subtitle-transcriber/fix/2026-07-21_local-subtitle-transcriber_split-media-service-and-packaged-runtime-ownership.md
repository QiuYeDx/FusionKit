# MEDIA-001 / NATIVE-002 修正：拆分媒体服务与发布产物所有权

## 背景与现象

`MEDIA-001` 开始接入正式 FFprobe/FFmpeg 规范化服务后，同时触及 verified runtime、
PCM/WAV 临时文件、进程退出和应用 shutdown。若继续把这些事实归为一个工作包，容易
产生两种错误结论：一是把开发态 verified bundle 可启动误记为最终安装包已包含并验证
FFmpeg；二是让 `NATIVE-002` 或后续启动清理代码凭路径重新判断并删除 `MEDIA-001`
当前进程持有的临时目录。

反方向也存在边界漂移：PCM window 的 frame range、内容哈希和 main-only proof 是单次
任务的媒体语义事实，不能因为 FFmpeg final bytes 已冻结就交给 artifact/builder 脚本；
结构窗口、媒体 proof、Supervisor epoch 和 HTTP response 若分开流转，也无法阻止 window
swap、旧 proof 复用或 restart 后的 stale response。

## 根因

原计划把“bundled FFmpeg 可用”描述为单一事实，实际上至少包含四层不同证明：

1. `MEDIA-001` 持有的授权源文件、音轨选择、规范化 PCM 与当前进程生命周期；
2. `NATIVE-002` 持有的目标平台 final bytes、manifest、builder 与签名/分发事实；
3. `BE-002` 持有的 exact window dispatch、Supervisor generation 与 response 关系；
4. `BE-003` 持有的应用重启后、已经没有内存 proof 的历史 orphan 发现与清理。

这四层可以互相消费受控结果，但不能互相替代。文件存在、路径位于受控根、开发态
bundle verifier 通过或一次 FFmpeg 命令成功，都不足以同时证明另外三层。

## 修正后的所有权

### MEDIA-001：媒体服务、PCM proof 与当前进程 cleanup

- 只从 CORE-002 verified runtime bundle 解析固定 FFmpeg/ffprobe artifact；packaged 与
  development 均禁止 PATH、用户 executable 或任意路径 fallback。
- 绑定 owner、授权源文件 identity、runtime generation 与当前音轨表；`streamId` 只能
  选择同一份已复核输入中的音轨，源文件替换、旧音轨表或跨 owner 复用必须失败。
- 为每个任务创建私有 source snapshot，整段媒体只解码一次；验证 16 kHz mono PCM16
  RIFF/WAVE 后，按 exact frame interval 延迟物化窗口，并复核 header、size、duration
  与 SHA-256。
- 产出不可结构伪造的 main-only PCM/window proof。proof 绑定 owner、文件、runtime、
  track table、frame range 与实际窗口内容；窗口内容或头部损坏后立即失效，恢复原字节
  也不能让旧 proof 复活。
- 持有本进程创建的 temp root、任务目录、source snapshot、PCM/window 文件和 FFmpeg /
  ffprobe child。取消、owner release 与 app shutdown 必须先 fence late result，再终止
  child，并以真实 `close` 作为可删除相关临时目录的边界。
- cleanup 只消费本进程内存中持有的 opaque identity/proof；目录身份、权限或 containment
  变化时 fail closed。未知目录和上次进程遗留目录不属于 MEDIA-001 的删除权限。

`MEDIA-001` 的单元/集成测试可以证明服务只消费受信 artifact、无 PATH fallback、PCM
语义和本进程 cleanup 正确，但不能据此宣称正式安装包已包含目标平台 final bytes。

### NATIVE-002：final packaged bytes 与构建/分发门禁

- 生成或采集 PRE-006 冻结的 macOS arm64 与 Windows x64 FFmpeg/ffprobe final bytes，
  固定来源、版本、平台、架构、依赖、大小、SHA-256、许可证和 source-offer 证据。
- 负责正式 runtime manifest 中的 exact artifact 集及其最终 hash；不得用开发机
  `/opt/homebrew/bin`、系统 PATH 或 PRE spike 临时文件填充 production staging。
- 更新正式 `electron-builder.json` 的 `extraResources`、`${arch}` 产物命名和
  `beforePack` 门禁。缺 server、FFmpeg、ffprobe、manifest、license/source-offer 或
  错误架构时必须在生成安装包前失败。
- 持有 nested runtime signing、外层 app/builder signing 配置和 final-byte hash 不变性
  证明。Windows 首版继续使用已冻结的 `unsigned_personal_distribution`；macOS
  Developer ID、公证和 Gatekeeper accepted 仍由 `QA-004` 在发布产物上验收。
- 在真实 packaged app 中隔离 PATH，运行 server health 与媒体格式/fault smoke，证明
  resolver 读取的是 asar 外 `extraResources` 中的 final bytes。development launch、
  mock verifier 或 MEDIA focused tests 不能替代该 packaged/no-PATH 证据。

`NATIVE-002` 不解析音轨、不创建 PCM window、不签发媒体 proof，也不清理某个媒体任务
的临时目录。它只交付可由 CORE-002 verifier 和 MEDIA-001 安全消费的发布产物事实。

### BE-002：window brand 与 response 原子绑定

`BE-002` 在一次不可拆分的 dispatch 记录中绑定：

- `MEDIA-001` 的 exact immutable window proof；
- `SUB-001` structural window descriptor 与 `windowAttempt`；
- Supervisor `processEpoch`；
- dispatch / response `requestGeneration`；
- 本次 server response。

进入 `SUB-001` 前必须同时复核上述身份。window/brand swap、proof reuse、frame mismatch、
epoch restart 后的 late response 或 generation 不一致都必须拒绝，不能只验证 WAV path
存在或 response schema 合法。MEDIA-001 证明“这些 PCM bytes 属于哪个窗口”，BE-002
证明“这份 response 正是由该窗口在该次进程请求中产生”。

### BE-003：启动 orphan 扫描

`BE-003` 负责应用启动时扫描并清理历史进程遗留的媒体 temp、server session、
`.partial`、过期 token/download 等 orphan。扫描必须从固定受控根和严格命名/结构合同
出发，拒绝 symlink、越界路径和 manifest 注入；不能信任旧会话记录中的任意路径，也
不能假设已丢失的 MEDIA-001 内存 proof 仍然存在。

因此，正常运行期由 MEDIA-001 清理本进程持有 proof 的媒体资源；crash 或强杀后由
BE-003 在下一次启动按 orphan 合同处理。BE-003 不接管活动媒体服务，MEDIA-001 也不
在 shutdown 时扫描并删除所有历史目录。

## 影响范围

- `electron/main/local-subtitle/media-process.ts`
- `electron/main/local-subtitle/pcm-window.ts`
- `electron/main/local-subtitle/media-normalizer.ts`
- `electron/main/local-subtitle/main-runtime.ts`
- `electron/main/local-subtitle/resource-manifest.ts`
- `electron-builder.json`（仅 `NATIVE-002` 后续正式接线）
- `test/local-subtitle/mediaProcess.test.ts`
- `test/local-subtitle/pcmWindow.test.ts`
- `test/local-subtitle/mediaNormalizer.test.ts`
- `local-subtitle-transcriber_final_design.md`
- `local-subtitle-transcriber_execution_plan.md`

## 实现与验收约束

- `MEDIA-001` 完成条件是媒体 service、PCM/window proof、本进程 owner/app cleanup 和
  对应 fault/cancel/late-close 测试通过；不得顺带把 `NATIVE-002` 标为完成。
- `NATIVE-002` 完成条件是目标平台 final artifact、正式 manifest/`extraResources` /
  builder/signing 门禁和 packaged no-PATH smoke 通过；不得用 MEDIA-001 的开发态测试
  缩减该矩阵。
- `BE-002` 必须覆盖 window swap、旧 proof 复用、frame mismatch、stale epoch /
  generation/response；只传递路径或普通对象不满足原子绑定合同。
- `BE-003` 必须覆盖 crash/强杀后的 orphan、symlink/identity replacement、越界与清理
  再入；不能让启动扫描删除当前进程仍持有的活动目录。

本文只修正工作包职责，不新增发布成功证据。各工作包仍须在自己的实施记录中列出
实际执行的定向测试、全量测试、TypeScript/build/manifest gate、目标平台 packaged
smoke 与进程/临时文件清理结果。

## 后续

先由 `MEDIA-001` 收口服务与 PCM proof，再由 `BE-002` 消费 proof 建立完整 dispatch
brand。`NATIVE-002` 可并行推进 final artifact 与 builder 接线，但只有 packaged
no-PATH 矩阵通过后才能声明发布运行时闭环；`BE-003` 在 Job Manager 目录合同稳定后
实现启动 orphan 扫描。四个工作包必须保留独立完成状态和验收证据。
