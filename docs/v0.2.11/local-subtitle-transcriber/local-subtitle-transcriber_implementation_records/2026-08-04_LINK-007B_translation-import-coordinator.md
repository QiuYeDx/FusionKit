# 工作包 LINK-007B：生成字幕翻译导入协调器闭环

## 基本信息

- 日期：2026-08-04
- 状态：已完成
- 对应执行计划工作包：LINK-007B（顶层 LINK-007）
- 目标平台/硬件：跨平台 TypeScript / Electron main + preload + renderer；不依赖目标 GPU 或 Windows 环境

## 本次认领边界

- 包含：one-shot import token 消费、main-private candidate、稳定 handoff identity、source/custom target authority、两阶段所有权转移、完整不可变 receipt、精确启动、生成任务执行与清理。
- 不包含：普通页面/Agent 新建任务生产者切换、RecoveryDialog/checkpoint 恢复消费者切换、legacy path/`outputURL` 删除、三种本地转写后处理模式产品接线；这些继续归 LINK-004、LINK-005 与 LINK-008。

## 本次实现内容

- preload 固定导入 API 私有携带 local-subtitle 与 subtitle-translation 两个 document owner session；main 分别校验两者属于同一 sender/frame，受保护 namespace 不进入 public generic invoke。
- main 一次性消费 LINK-006 `translationImportToken`，基于稳定 artifact identity 与 translator snapshot 派生 `taskId`、`handoffKey` 和 `candidateBinding`；artifactRef 安全轮换不改变交接身份。
- `source` 模式使用 handoff 时冻结并复核的 main-only artifact 目录 proof；`custom` 模式从 translator draft 派生 snapshot-bound batch lease，同一批多个候选可安全复用且分别取得 task authority。
- candidate 创建时 target 保持不可执行。renderer import ledger 原子完成 handoff reservation 与队列插入后，才幂等 commit target；duplicate、未入队候选与 queue 异常均显式 release。
- `releaseBatch` 只释放 snapshot、custom lease、ledger reservation 与未转移 candidate，不撤销已进入 `addedTaskIds` 的 task-owned handle。
- 协调器构造自包含 `manifest_fragments` 生成任务并尝试费用估算；回执冻结 `startedTaskIds`、`waitingTaskIds`、`notStartedTaskIds` 与 `startFailures`，三个 ID 集合两两不交且并集等于 `addedTaskIds`，失败只能引用未启动任务。
- `enqueue_translation` 保持全部未启动；`enqueue_and_start_translation` 只调用 `startTasks(addedTaskIds)`，不调用 `startAllTasks()`。相同 handoff 的精确重试返回原始 receipt，不重复入队或启动。
- generated task 执行 IPC 剥离兼容的 `originFileURL`、`targetFileURL` 与 `checkpointPath`，只发送 opaque task reference；task reference 编辑时不可换绑。
- 删除单个生成任务或批量清空时，通过 owner-bound fixed IPC 释放 target handle；失败进入最多 5 次有界重试，不影响 legacy task。
- 保留 `outputURL` 与所有 legacy path 字段，没有从旧 raw path 静默签发 capability，也没有提前切换普通页面、Agent 或 RecoveryDialog。

## 修改文件

- Main candidate / authority：`electron/main/translation/generated-import-candidate.ts`、`directory-capability.ts`、`ipc.ts`、`electron/main/index.ts`。
- Artifact handoff：`electron/main/local-subtitle/artifact-handoff.ts`、`subtitle-artifact-registry.ts`。
- Preload / shared contract：`electron/preload/subtitle-translation-api.ts`、`electron/preload/index.ts`、`src/type/generatedSubtitleImport.ts`、`src/type/subtitleTranslationIpc.ts`。
- Renderer coordinator / queue / execution：`src/services/subtitle/generatedSubtitleImportCoordinator.ts`、`translatorExecutionService.ts`、`translatorQueueService.ts`、`src/store/tools/subtitle/useSubtitleTranslatorStore.ts`、`src/type/subtitle.ts`。
- Tests：`test/translation/generated-import-candidate.test.ts`、`src/services/subtitle/generatedSubtitleImportCoordinator.test.ts`、`translatorExecutionService.test.ts` 及既有 subtitle/local-subtitle 回归。

## 接口、状态或数据结构变化

- 新增 main-private generated import candidate create/commit/release 合同；candidate target 只有在 renderer ledger 已接受任务后才能成为可执行 task authority。
- 导入 IPC 请求绑定两个 owner session、one-shot token、snapshot 与 handoff mode；公开响应只返回 path-free candidate/receipt 数据。
- `GeneratedSubtitleImportReceipt` 增加完整启动分区和失败明细，并在创建后深冻结；重试复用同一不可变回执。
- generated execution request 只携带 `generated_task_v1` opaque reference；main authoritative registry 负责实际 source/target 解析。
- Store 删除/清空生成任务时触发 task target authority cleanup queue，清理操作按 owner/taskId 固定绑定并有界重试。

## 安全、隐私与许可证检查

- renderer、Store、回执、日志与持久化不包含 artifact/source/target raw path、API Key、header 或 capability token；字幕正文只存在于自包含任务输入和启动后的恢复所需 fragments。
- one-shot token 无论消费成功或失败均不可重放；snapshot、batch lease、candidate 与 task handle 的所有权边界显式且可幂等清理。
- generated task 不能回退 `legacy_path_v1`，旧 `outputURL` 只保留给尚未迁移的显式 legacy consumer。
- 未新增第三方依赖、网络下载、二进制或许可证变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/services/subtitle src/store/tools/subtitle src/agent test/translation test/local-subtitle/ipc.test.ts test/local-subtitle/subtitleArtifactRegistry.test.ts test/local-subtitle/authorizations.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：扩大回归 30 个测试文件 / 215 项测试；TypeScript；renderer/main/preload 三段 Vite test build；diff check。
- Vite 只有既有 chunk-size 与 `useModelStore` 动态/静态 import 提示，无新增构建失败。
- 未运行 Electron 人工 picker/窗口矩阵、packaged、真实外部翻译 API 或 Windows 目标机测试；本包的 authority/queue/receipt 合同由跨平台代码与测试覆盖，产品/目标机验证继续归 QA。

## 产生的证据

- 测试和构建输出仅在当前会话终端；未生成需提交的截图、模型或 runtime 资产。
- 未启动 Vite/Electron 常驻服务。

## 未完成事项与风险

- 普通 SubtitleTranslator 页面和 Agent 新建任务仍通过显式 legacy adapter，尚未切换到 source/target ref；归 LINK-004。
- RecoveryDialog、Agent recovery、checkpointRef/v2 manifest 与历史 v1 main-only compatibility reader 尚未迁移；归 LINK-005。
- `outputURL`、`originFileURL`、`targetFileURL`、`checkpointPath` 继续保留，不能在 LINK-004/005 全消费者验证前删除。
- 本地字幕 `export_only` / `enqueue_translation` / `enqueue_and_start_translation` 三种产品模式尚未接到 FE-004；归 LINK-008。

## 下一步建议

- 进入 LINK-004：迁移普通页面与 Agent 的新建字幕翻译任务生产者，确保新任务只使用 taskId、execution binding 和 source/target ref，同时继续保留恢复流的 legacy adapter。
- LINK-004 稳定后进入 LINK-005，迁移 checkpoint/recovery 消费者并完成旧 path 生命周期的最终 cutover。
