# 工作包 BE-002：Source Output Parent Isolation

## 基本信息

- 日期：2026-07-22
- 状态：已完成（unit/contract 范围；BE-002 总工作包仍进行中）
- 对应执行计划工作包：`BE-002`
- 目标平台/硬件：跨平台 Electron main / Node filesystem contract；未启用真实 native server、FFmpeg、PRE-006 模型或 Electron UI

## 本次认领边界

- 包含：CPU/transcribe/no-VAD/source/SRT/index-only/export-only 批次、task input identity 派生父目录、多父目录逐文件隔离、执行前 fail-fast 与导出时重解析。
- 不包含：production overwrite、LRC/多格式及 partial output 组合、CUDA/Metal、VAD、translate、translation handoff、renderer UI、真实 native/packaged E2E。
- 保持既有 SUB-002 index exporter 的目录 mutex、containment、原子 no-clobber 与 Artifact Registry 合同不变；standalone overwrite 只有 path-based component contract，因 parent replacement/victim recovery TOCTOU 不接入本次 production 调用链。

## 本次实现内容

- `LocalSubtitleInputAuthorizationRegistry` 新增 main-only `resolveTaskSourceOutputDirectory`。input 在首次获得 `derive_source_output` authorization 时即从 canonical file path 冻结 parent object 的 `dev` / `ino` / `birthtimeMs`；committed task resolution 还必须匹配 owner、taskId、exact file token、operation 与 TTL，续期只能改变 expiry，不能接受新的目录对象。
- source parent 的 filesystem structural proof 与公开 display label 校验分离；POSIX 等平台上合法但不适合作为 renderer label 的父目录 basename 不会反向阻断安全文件的 authorization、transcribe 或 custom output，且该 basename 不进入公开状态。
- 每次解析按 file -> parent -> file/parent recheck 顺序验证 exact file identity、canonical containment 与 authorization-time parent proof。即使替换父目录后用 hard link 保持 file inode，也不能把写入重定向到新的目录对象；恢复原目录对象后，后续 retry 必须重新解析而不是复用旧 raw path。
- source enqueue 对每个 input 同时验证 `transcribe` 与 `derive_source_output`，但不创建、续期或释放 batch output lease。任一 operation 缺失时整批 admission 失败，所有 draft 保持可撤销；publication 失败仍回滚 input lease。
- Production Executor 在 media normalization 与 lazy runtime pin 前执行一次 source parent fail-fast，丢弃 raw path，只跨阶段保留无路径 directory identity proof；SUB-002 exporter 每次请求目录时重新解析 task input authority，并必须匹配 preflight proof。输入文件 identity 变化保留 `media_changed/preparing_media`，父目录 availability/identity 失败为 task-scope `output_write_failed/exporting`，TTL 失效保留 `authorization_expired/preflight`；这些 fail-fast 均不占用模型。
- custom 模式继续只使用 batch-scoped output lease；source 模式只使用 task input resolver。当前 production 两条路径都只放行 `index`，`overwrite` 在 capability 消费与路径解析前拒绝；两条路径不互相回退，也不从 renderer label/token 推导路径。
- 不同父目录中的同名源文件各自在自己的目录以 no-clobber index 提交 SRT。某一父目录失效只失败当前 task，后续 sibling 继续运行；failed executor result 已给出 `media_changed` / `output_write_failed` / `authorization_expired` 时，terminal capability renewal failure 不得覆盖该执行错误。公开 batch/task/event/IPC 状态不包含 file token、output token 或 raw path。

## 修改文件

- `electron/main/local-subtitle/authorizations.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/index.ts`
- `test/local-subtitle/authorizations.test.ts`
- `test/local-subtitle/jobManager.test.ts`
- `test/local-subtitle/jobManagerIpc.test.ts`
- `test/local-subtitle/productionExecutor.test.ts`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/derive-source-output-from-task-input-identity.md`
- `.agents/skills/fusionkit-pitfall-guard/references/do-not-enable-path-only-overwrite-across-replaceable-directories.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- 本实施记录

## 接口或数据结构变化

- 新增 main-only input authorization resolver；renderer DTO、public IPC channel 和持久化 schema 均未变化。
- Job Manager 现放行 source/custom 两种 SRT output mode，但 production gate 对两者都要求 `conflictPolicy=index`；overwrite 请求在 capability 消费前以稳定 preflight error 拒绝。source config snapshot 不含 `directoryLeaseRef`，capability transaction 只提交各 task input lease。
- Production Executor 新增 input authorization dependency；source directory resolver 绑定 owner/task/file token，每次调用返回匹配 authorization-time parent proof 的 existing resolved-directory contract。Executor 另持有首次 preflight 的无路径 identity proof，export-time resolution 还必须与该 proof 相同。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/authorizations.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/productionExecutor.test.ts test/local-subtitle/subtitleExporter.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/runtime/validate-runtime-staging.mjs
git diff --check
```

结果：

- 聚焦 source authorization / Job Manager / Job IPC / Production Executor / exporter：5 files / 160 passed。
- local-subtitle：33 passed + 2 skipped files / 681 passed + 2 skipped tests。
- 全量 Vitest：134 passed + 2 skipped files / 1633 passed + 2 skipped tests；2 个 skip 仍是未启用的真实 native server tests。
- TypeScript 通过；renderer/main/preload 三段 Vite test build 通过，仅有既有 dynamic-import/chunk-size warning；PRE manifest 0 errors / 0 warnings；validator 17/17；diff check 通过。
- canonical runtime staging 因 Git 忽略的 canonical runtime path 缺失而按合同 fail closed；未取得真实 native/packaged E2E 结论。
- 未改依赖或 `pnpm-lock.yaml`，未运行 `pnpm`。

## 未完成事项

- Production overwrite 仍需目录句柄相对的校验/victim 备份/替换/回滚事务；当前 standalone path-based overwrite 不构成 production 支持。
- LRC/多格式及 partial output 组合、CUDA/Metal、VAD、translate、translation handoff、FE 和 native/packaged E2E 仍未完成。
- canonical native runtime staging 资源若仍不在当前工作区，真实 runtime/模型/目标硬件矩阵继续由 `NATIVE-002` / QA 提供。

## 下一步建议

- 继续 `BE-002` 的 LRC/多格式与 partial output 组合，再按依赖可用性扩展 backend/VAD/translate；production overwrite 由独立目录句柄事务工作包闭环，不能直接解除当前 index-only gate。
- 在 `NATIVE-002` / QA 阶段补真实 source/custom 多文件 official server 与 packaged filesystem 权限矩阵。
