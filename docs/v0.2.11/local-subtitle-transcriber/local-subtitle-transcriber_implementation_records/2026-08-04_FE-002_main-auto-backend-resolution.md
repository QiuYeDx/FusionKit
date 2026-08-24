# 工作包 FE-002：main auto backend resolution checkpoint

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`FE-002`
- 目标平台/硬件：macOS arm64与Windows x64共享main/renderer合同；本轮未开放Metal/CUDA production admission或执行目标GPU验证

## 本次实现内容

- 新增main-only `LocalSubtitleBackendResolver`与不可结构伪造的verified resolution proof，绑定requested preference、resolved backend、managed model id/hash、runtime root/generation/target及exact server artifact path/size/hash/version/signature identity。
- 当前可信策略只允许`auto -> cpu`和显式CPU。显式CUDA/Metal在production verifier尚未注入时稳定返回`backend_unverified`，不读取renderer probe结论、不解析stderr、不回退CPU。
- Job Manager在batch capability reserve/commit之前调用resolver，并复核proof的brand、preference、runtime generation与model identity；immutable batch snapshot保存真实`devicePreference=auto`与`resolvedBackend=cpu`。
- Production Executor不再自行按CPU规则重新选择artifact；它消费commit-time proof，在模型加载时重新验证runtime generation与exact artifact identity，再让queue-admission batch pin使用proof中的backend/artifact。
- 单文件renderer请求从显式`cpu`改为`auto`；环境区文案改为“自动解析目标”，任务提交后继续展示main snapshot中的真实resolved backend。
- IPC错误映射保留稳定`backend_unverified`，GPU拒绝不会消费input/output draft capability。

## 修改文件

- `electron/main/local-subtitle/backend-resolver.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/index.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
- `src/locales/{en,ja,zh,zh-Hant}/subtitle.json`
- `test/local-subtitle/{backendResolver,jobManager,jobManagerIpc,productionExecutor}.test.ts`
- Final Design、Execution Plan与本实施记录

## 接口或数据结构变化

- main内部`LocalSubtitleJobBatchExecutionContext`与`LocalSubtitleJobTaskExecutionContext`新增`backendResolution` proof；该对象不进入preload、renderer、session snapshot或持久化Store。
- 未新增IPC channel。既有enqueue request继续使用已发布的`devicePreference`枚举，batch/task summary继续只公开requested preference与resolved backend，不公开absolute path、hash、runtime generation或backend flag。
- Production Executor删除独立`selectCpuServerArtifactId`注入点，exact artifact authority统一归commit-time backend proof。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/backendResolver.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/productionExecutor.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
git diff --check
```

结果：

- backend resolver、Job Manager、IPC、Production Executor与renderer request model共5 files / 139 tests通过。
- TypeScript、renderer/main/preload三段Vite test build、四语言locale parity/source usage与diff check通过；仅保留既有dynamic/static import与chunk size warning。
- 覆盖auto/显式CPU proof、伪造proof、runtime/artifact漂移、显式CUDA/Metal fail-closed、draft capability保留与既有batch runtime pin生命周期。
- 未执行Vite/Electron视觉QA、真实模型下载、真实Metal/CUDA推理或packaged目标机验证；未启动任何前端/Electron服务，未执行pnpm，未修改`pnpm-lock.yaml`。

## 未完成事项

- 页面开始前的CPU显示仍来自main runtime probe摘要；尚未新增按selected model调用同一resolver的公开preview summary，因此`FE-002`不能标完成。
- Metal/CUDA需要先实现exact artifact acquisition与main-only positive backend attestation，不能通过放宽Supervisor verifier或复用renderer probe状态开放。
- GPU commit后失败的暂停/阻断和“用户确认后CPU新generation”只有在GPU production admission真实存在后才可闭合；不得用当前CPU-only路径伪造fallback流程。

## 下一步建议

- 新增path/hash-free backend preview summary API，内部复用同一resolver，并在开始按钮前展示main返回的`auto -> resolvedBackend`与稳定不可用原因；enqueue仍需重新解析和commit最终proof以防preview后漂移。
- 随后为macOS bundled Metal与Windows managed CUDA分别建立exact server artifact proof和production `verifyBackend`实现，再接GPU batch pause与CPU新generation确认流程。
