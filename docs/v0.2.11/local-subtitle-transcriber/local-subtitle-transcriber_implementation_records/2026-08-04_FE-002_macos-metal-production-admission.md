# 工作包 FE-002：macOS Metal production admission checkpoint

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`FE-002`
- 目标平台/硬件：macOS arm64 production代码路径；本轮不声明restricted sandbox、packaged app或unrestricted target host的真实Metal验收通过

## 本次实现内容

- 新增production `LocalSubtitleProductionBackendAttestor`。它只在`darwin/arm64`声明Metal能力；Windows x64与CUDA继续稳定拒绝，不会因为同名artifact、health成功或renderer probe而开放。
- Supervisor为每个exact child epoch建立module-private opaque evidence。evidence绑定`processEpoch`、exact PID、runtime generation和server artifact ID，不能由结构对象伪造，也不包含renderer可读取字段。
- stdout/stderr分别保留最大64 KiB滚动窗口，避免跨stream尾首误拼。Metal只在观察到初始化标志、device标志且1秒观察窗内没有failure标志时通过；marker与原始诊断不离开Supervisor。
- attestation继续复用既有startup deadline、AbortSignal、child close race及严格返回对象校验；PID/epoch/backend/runtime/artifact任一不一致仍返回`backend_unverified`或`backend_mismatch`并先关闭该process epoch。
- Backend Resolver只有在production attestor capability、`darwin/arm64` target和verified exact `metal_cpu` server artifact同时成立时，才把`auto`或显式Metal冻结为`resolvedBackend=metal`。显式CPU继续解析为CPU并由Supervisor固定`--no-gpu`；显式GPU不做CPU fallback。
- Job Manager与Production Executor放开对branded Metal resolution的复核与消费；preview仍只返回path/hash-free summary，enqueue仍重新解析最终proof，queue-admission runtime pin仍冻结exact runtime/artifact/model/backend identity。
- renderer、preload和IPC schema没有新增path/hash/flag/evidence authority；远端`audio:*` ASR路由与状态未改动。

## 修改文件

- `electron/main/local-subtitle/backend-attestor.ts`
- `electron/main/local-subtitle/backend-resolver.ts`
- `electron/main/local-subtitle/server-supervisor.ts`
- `electron/main/local-subtitle/job-manager.ts`
- `electron/main/local-subtitle/production-executor.ts`
- `electron/main/index.ts`
- backend resolver、Supervisor、Job Manager、Production Executor聚焦测试
- Final Design、Execution Plan与本实施记录

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/backendResolver.test.ts test/local-subtitle/serverSupervisor.test.ts test/local-subtitle/jobManager.test.ts test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
git diff --check
```

结果：

- 聚焦4 files / 185 tests通过，覆盖auto/显式Metal admission、显式CPU保持、Windows拒绝、split stream chunk、晚到failure marker、缺device marker、unsupported target、opaque evidence、preview summary及Metal queue-admission pin。
- 完整local-subtitle回归50 files / 1037 tests通过，2个既有真实runtime测试按环境跳过。
- TypeScript、renderer/main/preload三段Vite test build、四语言locale parity/source usage、manifest validator（0 errors / 0 warnings）与diff check通过；build只有既有dynamic/static import与chunk size warning。
- 未执行真实Metal server、模型下载、Vite/Electron视觉QA或packaged app目标机验证；未启动前端/Electron服务，未执行pnpm，未修改`pnpm-lock.yaml`。

## Pitfall边界

- `FK-PIT-0067`要求restricted sandbox中的Metal失败只能记录为环境负信号；真实支持结论必须在unrestricted Apple Silicon目标机用同一content-addressed runtime/model完成positive attestation。本轮因此只声明代码闭环。
- `FK-PIT-0038`要求startup readiness与ready-state health分离；Metal attestation位于readiness成功后、epoch进入ready前，不把`/health`当作GPU证明。
- `FK-PIT-0039`要求close observer与主动retire共享同一finalization；evidence listener只随既有stdio-drain finalization detach，没有新增第二套process cleanup owner。
- `FK-PIT-0054`要求GPU runtime identity继续绑定queue-admission slice；本轮沿用原batch pin生命周期，没有将attestation或preview变成renderer runtime authority。
- `FK-PIT-0021`要求本地字幕独立于远端Audio ASR；本轮没有触碰`audio:*`合同或provider调用。

## 未完成事项

- Windows CUDA仍需把managed accelerator pack的exact server/DLL identity接入Backend Resolver、Process Descriptor与Production Executor，并实现exact-PID VRAM positive attestor；不得从resource summary或`nvidia-smi`非PID摘要推断。
- 真实Metal正向证据仍需在unrestricted arm64目标机执行；restricted sandbox失败不能改写为CPU fallback策略或产品不支持。
- GPU generation在load/OOM/driver/crash后的批次暂停与“用户确认后以CPU新generation重试”尚未实现；当前失败generation明确失败，不会静默显示为CPU成功。
- `FE-002`继续保持进行中，完成CUDA与确认式CPU generation后再进入`FE-003`。
