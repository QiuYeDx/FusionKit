# 工作包 SUB-002：SRT/LRC 导出、原子写与 Artifact Registry

## 基本信息

- 日期：2026-07-22
- 状态：已完成
- 对应执行计划工作包：`SUB-002`
- 目标平台/硬件：跨平台纯 TypeScript / Electron main 合同；本次未生成 packaged/native artifact

## 本次认领边界

- 包含：strict SRT/LRC formatter/parser/round-trip、同目录 private partial、index/overwrite atomic commit、full/partial/none-success、commit 前后取消、app-scoped Artifact Registry、artifact read/reveal IPC。
- 不包含：`handoffArtifact`、one-shot translation import token、字幕翻译 Store/任务/target handle（`LINK-006` 及后续 LINK 包）；Job Manager、session snapshot/ref rotation（`BE-002`）；跨重启扫描任意用户输出目录（不持久化 raw path）。

## 本次实现内容

### Strict SRT/LRC 格式与回读

- SRT 使用精确整数毫秒 `HH:MM:SS,mmm`，LF-only、UTF-8 no BOM，序号从 1 开始；parser 复核 cue 数、时间单调、正文约束和 canonical round-trip。
- 标准 LRC 固定 `floor(startMs / 10)`，保留相同标签的多行 cue 和原顺序；canonical 多行正文只投影为空格，不做文本合并或去重。
- formatter 逐块执行 16 MiB UTF-8 上限，避免先构造无界字符串；parser 拒绝 BOM、非法 UTF-8、结构破坏控制字符、unpaired surrogate、超限 cue/时间/正文。
- parse-back 只证明 artifact 与 canonical transcript 一致，不替代 SUB-001 raw transcript quality gate。

### 原子导出与终态

- 每格式在授权目录中创建 exclusive `0600` `.fusionkit-local-subtitle-*.partial`，分块写入后 sync/close/reopen/parse-back/hash。
- partial ownership 只绑定 stable device/inode/birthtime，mutable size 独立作为内容校验；大于 1 MiB 的分块写入在首块后取消仍能按对象身份清理。
- index 模式在目录对象 mutex 下使用 hard-link no-clobber；成功后同步解除 partial link，再由 Registry 冻结 final identity，避免 unlink 更新 inode `ctime` 后新 ref 立即失效。detach 或 Registry activation 失败会撤销 reservation、同步回滚 identity-matching final，并拒绝激活 ref。Registry activation 同步绑定 prepared file object 与授权 directory identity，realpath 后二次 lstat 并记录最终 file identity。
- overwrite 模式在确认目标不是 symlink/非普通文件后直接 atomic rename，不先删除旧目标；rename 失败时旧目标保留。
- mutex 内重新解析 output lease 并复核目录 identity；格式独立提交，复用 shared terminal resolver 生成 full/partial/none-success 和 `cancelled_after_partial_commit`；resolver 拒绝没有 cancellation evidence 的 `cancel_failed`，failed transition 也拒绝 partial-commit marker。
- 正常失败、取消和未 commit 分支清理 owned partial；只有 `ENOENT` 可视为已清理，identity mismatch / unlink failure 不再吞掉。显式 `cancel_failed` 优先于同时到达的 abort：无 commit 进入 failed，已有 commit 保留为 completed partial warning。

### Artifact Registry 与 IPC

- Registry 只在 main 保存真实路径、directory/file identity、size/hash；公开 summary 只有 ref/format/displayName/expiry。
- ref 绑定 owner、task、generation、TTL 和 allowed operation。更高 generation 原子撤销旧 ref，低 generation late reserve 拒绝；task/owner release 后永久 fence 当前 session。
- 每次 read/reveal/main-only handoff snapshot 都重新 no-follow 打开并验证 directory/file identity、size/hash、UTF-8、格式和 cue；文件/目录替换稳定返回 `artifact_changed`。
- `readArtifactText` 返回 parser 生成的 `rawText/plainText/cueCount`，且整个序列化 DTO 必须满足 frozen 16 MiB schema；合法 artifact 因 raw/plain 双份内容超预算时返回 `content_too_large`。
- `readArtifactText` / `revealArtifact` 已作为 app-scoped built-in operation 接入 `LocalSubtitleIpcService`。公开 `handoffArtifact` 继续返回 stable unavailable，等待 `LINK-006`。
- 修复 capability reservation sweep：短 lease 到期而 draft TTL 仍有效时恢复 draft，只有 draft 本身到期才彻底删除，避免 reservation timeout 无故丢失仍有效授权。

## 修改文件

- `electron/main/local-subtitle/subtitle-formats.ts`
- `electron/main/local-subtitle/subtitle-exporter.ts`
- `electron/main/local-subtitle/subtitle-artifact-registry.ts`
- `electron/main/local-subtitle/authorizations.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/index.ts`
- `src/type/localSubtitle.ts`
- `src/type/localSubtitleIpc.ts`
- `src/type/localSubtitle.test.ts`
- `src/type/localSubtitleIpc.test.ts`
- `test/local-subtitle/subtitleFormats.test.ts`
- `test/local-subtitle/subtitleExporter.test.ts`
- `test/local-subtitle/subtitleArtifactRegistry.test.ts`
- `test/local-subtitle/authorizations.test.ts`
- `test/local-subtitle/ipc.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/unlink-hardlink-before-freezing-file-identity.md`
- `.agents/skills/fusionkit-pitfall-guard/references/keep-partial-file-identity-stable-during-cleanup.md`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- Final Design、主题/版本执行计划、v0.2.11 README 与本实施记录

## 接口、状态或数据结构变化

- 新增 `formatLocalSubtitleSrt/Lrc`、strict UTF-8 parser、round-trip verifier 和 plain-text projection。
- 新增 `LocalSubtitleExporter` 与真实 Registry collaborator contract；没有新增 public status、warning 或 error code。
- shared terminal resolver 与 task summary schema 识别 `failed(cancel_failed)` 取消证据，保持无 commit failed / 已有 commit completed partial 的既有 public contract，并拒绝没有取消请求的 cleanup failure 组合。
- 新增 `LocalSubtitleArtifactRegistry`，替代 IPC 中只冻结 token 的 generic artifact registry；保留既有 fixed preload/channel/schema。
- app 启动时创建一个共享 Artifact Registry，并注入 Electron `shell.showItemInFolder()` host。
- public `readArtifactText` / `revealArtifact` 从 unavailable 变为真实 built-in handler；`handoffArtifact` 未改变。

## 安全、隐私与许可证检查

- 路径/capability：renderer 不接触 artifact path；所有 ref owner/op/TTL/generation-bound，文件和目录每次操作重新验证；未增加任意 channel、path 或 executable 输入。
- 日志/持久化：没有持久化路径、字幕正文、ref 或诊断。任意用户输出目录不能在重启后全局扫描；正常清理已闭环，crash 后隐藏 partial 的未来回收需 main-only 授权 receipt。
- 第三方来源与许可：没有新增依赖或第三方代码；没有修改 `package.json` / `pnpm-lock.yaml`，没有执行裸 `pnpm`。
- 避坑记录：新增 `FK-PIT-0044`，固定 hard-link unlink 必须发生在 final identity 冻结前；新增 `FK-PIT-0045`，固定 partial stable identity、mutable size 分离与 required cleanup failure 语义。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/subtitleFormats.test.ts test/local-subtitle/subtitleArtifactRegistry.test.ts test/local-subtitle/subtitleExporter.test.ts test/local-subtitle/authorizations.test.ts test/local-subtitle/ipc.test.ts
node_modules/.bin/vitest run src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- 聚焦：5 files / 94 tests 全部通过；shared terminal/schema 2 files / 83 tests 全部通过。
- local-subtitle：23 passed + 2 skipped files / 431 passed + 2 skipped tests。
- 全量 Vitest：124 passed + 2 skipped files / 1383 passed + 2 skipped tests；既有 AI SDK warning 不影响结果。
- TypeScript、renderer/main/preload 三段 Vite test build、manifest 0 error / 0 warning、validator 17/17 与 diff check 通过。
- 未启动 Vite dev server、Electron、official server 或 FFmpeg；收口进程检查无项目相关残留。
- 未运行真实 packaged/target-hardware smoke：本包只实现格式、文件提交和 registry；正式 target bytes/builder 仍属 `NATIVE-002`。

## 产生的证据

- 测试覆盖 exact millisecond/centisecond boundaries、1h+、重复 LRC 标签、最大文本/bytes、invalid UTF-8/BOM/control/surrogate、round-trip drift。
- 测试覆盖 index race、overwrite old-target protection、same-size partial inode replacement、authorized directory replacement、symlink、目录 lease 重查、real Registry repeated read、full/partial/none、取消竞态、大文件首块后取消、pre-commit unlink failure、hard-link detach/activation rollback 与 `cancel_failed` terminal/schema。
- 测试覆盖跨 owner/op/TTL/task/generation、owner release、file/directory replacement、same-size hash drift、combined result over budget 和 late reveal owner release。
- 本次没有产生需要保留的模型、媒体、native binary、`.partial` 或服务日志。

## 未完成事项与风险

- `handoffArtifact`、one-shot token、ref 安全轮换与字幕翻译导入仍由 `LINK-006` / `LINK-007` 完成。
- `BE-002` 尚未把 exporter 接入真实 task pipeline；SUB-002 单测不等于端到端转写已可用。
- 进程在 user-output partial 写入后、正常 cleanup 前被强杀时可能留下隐藏 partial。因 raw output path 不持久化，重启后不能全盘扫描；不以破坏隐私边界换取清理便利。
- `readArtifactText` 同时返回 raw/plain，接近 16 MiB 的合法文件可能超出 frozen DTO budget；当前稳定返回 `content_too_large`，未来如需流式预览必须升级公开合同。

## 下一步建议

- 优先实现 `MODEL-001`：strict model manifest、GGML header/size/hash verifier、managed copy/move staging 与受控 no-VAD load smoke，并把 ResourceJob/session revision 收敛到一个 app-scoped session registry。
- `MODEL-001` 完成后 `BE-002` 的最后一个业务依赖解除，可开始单文件 CPU → SRT 最小闭环接线。
