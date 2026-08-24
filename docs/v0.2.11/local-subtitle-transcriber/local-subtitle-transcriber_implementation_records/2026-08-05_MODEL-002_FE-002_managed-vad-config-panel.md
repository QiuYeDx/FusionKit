# 工作包 MODEL-002 / FE-002：Managed VAD 与完整配置面板

## 基本信息

- 日期：2026-08-05
- 状态：部分完成（本次代码职责完成，真实大文件、目标机与 packaged 证据未执行）
- 对应执行计划工作包：`MODEL-002`、`FE-002`

## 本次实现内容

- Job Manager 在 enqueue、确认式 CPU retry 和 task 执行前解析、冻结并复验固定 managed VAD identity。
- VAD identity 进入 queue-admission runtime slice、Supervisor pin identity和资源占用判断；pending、queued、running VAD 均阻止删除。
- Production Executor 发送冻结的真实 `vadEnabled`，VAD 仍固定 `token_timestamps=false`、`segment_only_v1` 与 mapped segment timeline。
- 配置面板接通设备偏好、源语言、原文/转英文模式、质量预设、VAD、session-only initial prompt、6 项数值高级设置、SRT/LRC、index/overwrite和模型格式/量化摘要。
- backend preview 改为使用当前 device preference，并以 generation、model和preference identity拒绝stale/mismatched响应。
- VAD启用但固定managed资源未ready时禁止开始；renderer请求冻结当前device、VAD、task mode、initial prompt和全部高级设置。
- 解除Job Manager/Executor对既有`translate_to_english` server合同的production gate，不新增renderer native authority。

## 修改文件

- `electron/main/index.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/model-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/index.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
- `src/type/localSubtitleIpc.ts`
- `src/locales/{zh,zh-Hant,en,ja}/subtitle.json`
- 对应renderer、schema、Model Manager、Job Manager与Production Executor测试
- Final Design与Execution Plan

## 接口或数据结构变化

- `LocalSubtitleJobModelResolver`要求实现`resolveManagedVad()`；batch/task execution context新增main-only optional managed VAD identity。
- managed resource公开摘要为model新增可选`modelFormat`和`quantization`；非model资源携带这些字段会被schema拒绝。
- 未新增IPC channel、raw path、hash、runtime generation、backend flag或proof字段。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts src/store/tools/subtitle/localSubtitleTranscriberConfig.test.ts src/store/tools/subtitle/useLocalSubtitleTranscriberStore.test.ts src/type/localSubtitleIpc.test.ts test/local-subtitle/modelManager.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/jobManagerIpc.test.ts test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberPage.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 9个测试文件、256项测试通过。
- 高级区层级调整后，renderer model/page 2个文件、14项测试再次通过。
- TypeScript通过。
- 四语言各1777个键，locale parity与source usage通过；仅保留既有/合理同值warning。
- renderer、Electron main与preload三段Vite test build通过；仅保留既有dynamic import和chunk size warning。
- `git diff --check`通过。
- 未启动Vite、Electron或其他前端服务。

## 未完成事项

- 未执行真实885 KB VAD下载与official server native smoke。
- 未执行Windows CUDA、unrestricted Metal目标机和packaged产品矩阵。
- 顶层`MODEL-002`与`FE-002`继续保持`进行中`，不把源码级验证记作发布证据。

## 下一步建议

- 非QA开发项已基本收口；有目标环境时补真实VAD/模型/CUDA资源获取和packaged正向证据。
- 若继续纯代码工作，优先进入`DOC-001`或审查执行计划中未开始但不依赖目标机的文档/发布说明内容。
