# 工作包 FE-002：用户确认 CPU 新 generation checkpoint

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`FE-002`
- 目标平台/硬件：共享任务状态与Electron main/preload/renderer代码路径；本轮不声明Windows CUDA、真实GPU故障注入、packaged app或目标机验收通过

## 本次认领边界

- 包含：失败GPU generation的main签发资格、用户确认、显式CPU proof、新generation、新queue admission/runtime slice、owner lifecycle及四语言UI。
- 不包含：Windows CUDA production admission、exact-PID CUDA attestation、真实GPU/packaged Electron QA、批量任务页扩展。

## 本次实现内容

- 共享task summary新增可选`cpuRetryAvailable: true`，只允许失败、非CPU backend及固定GPU/runtime错误白名单组合；IPC schema拒绝伪造到其他状态。
- 新增fixed public `retryTaskOnCpu({ taskId, generation })`。preload没有generic invoke，renderer不能提交backend proof、path、hash、artifact identity、runtime generation或flags。
- Job Manager把config、managed model identity、runtime generation及backend resolution proof保存为generation-scoped execution binding。普通retry继续沿用当前binding，不会把失败GPU任务静默切换为CPU。
- CPU retry严格校验owner、task与exact failed generation，续租capability，重新验证managed model与runtime，并要求main resolver签发显式CPU proof后才发布`generation + 1`。
- CPU generation使用新的QueueAdmission和runtime slice；旧GPU generation保留为历史失败代际，late event不能覆盖新generation。
- pending CPU retry绑定owner和AbortSignal，计入owner/app idle与shutdown，并在准备期间阻止managed model删除。
- Session Registry只允许`eligible failed GPU generation -> queued CPU next generation`改变backend，其他相邻generation仍要求backend不变。
- LocalSubtitleTranscriber只在main公开资格时显示CPU重试按钮，并在提交前明确提示CPU可能明显变慢；成功后刷新共享session runtime。
- 远端`audio:*` ASR、provider路由和字幕翻译Store均未改动。

## 修改文件

- `src/type/localSubtitle.ts`
- `src/type/localSubtitleIpc.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/session-registry.ts`
- `electron/main/local-subtitle/job-ipc.ts`
- `electron/preload/local-subtitle-api.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/locales/{zh,zh-Hant,en,ja}/subtitle.json`
- 对应type、Job Manager、Session Registry、preload与页面聚焦测试
- Final Design、Execution Plan与本实施记录

## 接口、状态或数据结构变化

- `LocalSubtitleTaskSummary.cpuRetryAvailable?: true`
- `LOCAL_SUBTITLE_CPU_RETRY_ERROR_CODES`
- `local-subtitle:retry-task-on-cpu`
- `LocalSubtitleRendererApi.retryTaskOnCpu({ taskId, generation })`
- Job Manager内部`TaskExecutionBinding`与`PendingCpuRetry`

## 安全、隐私与许可证检查

- 路径/capability：公开请求只有task identity与generation；capability、model/runtime/artifact路径及proof只在main内解析和复核。
- 日志/持久化：没有新增日志或持久化字段；task snapshot只增加布尔资格位，不包含原始诊断或GPU证据。
- 第三方来源与许可：未新增依赖、二进制、下载源或许可；Windows CUDA pack许可边界仍归`QA-005`。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/type/localSubtitleIpc.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/sessionRegistry.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/preloadApi.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts
node_modules/.bin/vitest run test/local-subtitle src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts src/store/tools/subtitle/useLocalSubtitleTranscriberStore.test.ts src/services/local-subtitle src/pages/Tools/Subtitle/LocalSubtitleTranscriber
node_modules/.bin/tsc --noEmit --pretty false
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 聚焦6 files / 160 tests通过。
- 完整local-subtitle范围60 files / 1182 tests通过，2个需要真实native runtime的测试按既有条件跳过。
- TypeScript、四语言locale parity/source usage、manifest validator（0 errors / 0 warnings）、renderer/main/preload三段Vite test build与diff check通过。
- i18n parity只有既有warning；Vite只有既有dynamic/static import与chunk size warning。
- 未运行真实GPU/packaged/Electron视觉QA；未启动前端或Electron服务，未执行pnpm，未修改`pnpm-lock.yaml`。

## Pitfall边界

- `FK-PIT-0054`：每次retry必须领取新queue admission/runtime slice；execution binding不能挂在长生命周期batch pin上。
- `FK-PIT-0052`：pending CPU retry按owner分区，release会abort并跳过admission，不能阻塞其他owner的全局FIFO。
- `FK-PIT-0050`与`FK-PIT-0037`：新generation通过既有串行revision stream发布，旧generation事件只推进水位，不能修改当前任务。
- `FK-PIT-0046`：shutdown operation先缓存再abort pending工作，保持同步重入的Promise identity。
- `FK-PIT-0014`：四语言locale parity与source usage都已校验，不能只依赖fallback文案。
- `FK-PIT-0021`：本地字幕IPC/runtime继续独立于远端`audio:*` ASR。

## 未完成事项与风险

- Windows CUDA仍需把managed accelerator pack的exact server/DLL identity接入Backend Resolver、Process Descriptor与Production Executor，并实现exact-PID positive attestation。
- 真实Metal/CUDA故障与CPU retry仍需在unrestricted目标机及packaged app中验证；本轮自动化不能替代该证据。
- `FE-002`保持`进行中`，不得在目标机证据缺失时声明完整GPU支持。

## 下一步建议

- 继续Windows CUDA production admission：组合verified base runtime与managed accelerator pack，冻结server/DLL完整identity，并在exact child PID上完成正向backend attestation；显式CUDA或已commit GPU失败仍不得静默回退CPU。
