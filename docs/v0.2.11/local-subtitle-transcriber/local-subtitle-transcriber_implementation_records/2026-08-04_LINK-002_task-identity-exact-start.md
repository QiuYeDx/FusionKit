# 工作包 LINK-002：稳定任务身份与精确启动

## 基本信息

- 日期：2026-08-04
- 状态：已完成
- 对应执行计划工作包：LINK-002
- 目标平台/硬件：跨平台 TypeScript / Electron main；不依赖目标 GPU 或 Windows 环境

## 本次认领边界

- 包含：稳定 taskId、execution binding、队列/事件/main active identity 迁移、幂等 import ledger、批量精确启动、相关回归测试。
- 不包含：目录 capability、generated source/target ref、legacy path 删除、one-shot token 消费、三种本地转写后处理模式；这些继续归 LINK-003～LINK-008。

## 本次实现内容

- `SubtitleTranslatorTask`强制稳定taskId；普通页面、Agent和恢复任务统一通过受控factory创建，编辑接口无法换绑身份。
- Queue、Store、UI、token estimate、progress/failure/resolved事件、Electron main active controller/cancel与checkpoint全部改为按taskId定位；同名任务可以独立排队、取消和完成。
- 根级`apiKey/apiModel/endPoint`等字段收敛到`ready | needs_configuration` execution binding；renderer和main共同校验完整ready字段，所有启动入口在产生effect前拒绝待配置任务。
- 新增`startTasks(taskIds)`分区回执；RecoveryDialog的“添加并开始”只启动本次`addedTaskIds`，不再调用`startAllTasks()`。
- 新增内存`SubtitleTranslatorImportLedger`，原子提交handoff reservation与队列插入，支持partial add、同owner/snapshot跨receipt精确重放、冲突预检、任务删除后幂等和snapshot release。
- main拒绝非法taskId、无效ready binding和重复active identity；相同文件名任务的controller互不覆盖。
- 移除完整task对象与renderer事件调试日志，保留不含正文、密钥或路径的启动摘要。

## 修改文件

- 类型与工厂：`src/type/subtitle.ts`、`src/services/subtitle/subtitleTranslatorTaskFactory.ts`、`src/agent/task-model-config.ts`。
- Queue与导入：`src/services/subtitle/translatorQueueService.ts`、`src/services/subtitle/translatorImportLedger.ts`、`src/services/subtitle/subtitleTokenEstimateWorkerClient.ts`、`src/store/tools/subtitle/useSubtitleTranslatorStore.ts`。
- 生产者与UI：`src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`、`RecoveryDialog.tsx`、`src/agent/tool-executor.ts`。
- Renderer/main：`src/renderer/subtitle.ts`、`src/services/subtitle/translatorExecutionService.ts`、`electron/main/translation/{typing,translation-service,ipc,checkpoint}.ts`、`electron/main/translation/class/base-translator.ts`。
- 测试：task factory、queue、import ledger、Agent model binding及`test/translation/*`相关测试。

## 接口、状态或数据结构变化

- `SubtitleTranslatorTask.taskId`由可选展示语义提升为强制、稳定且不可编辑的任务身份。
- `SubtitleTranslatorTask.executionBinding`替代根级模型字段，状态为`ready | needs_configuration`。
- Store任务操作参数从fileName改为taskId；`addTask()`返回是否新增与taskId，`addRecoveredTasks()`返回`addedTaskIds`。
- 新增`startTasks(taskIds)`及started/waiting/not-started/start-failure不可变回执。
- main progress/failure/resolved事件和cancel IPC携带taskId；checkpoint直接复用稳定taskId。
- import ledger的公开receipt只包含不透明ID、展示名和稳定原因，不包含任务正文、密钥或路径。

## 安全、隐私与许可证检查

- 路径/capability：本包没有新增目录授权或把legacy path升级为capability；`originFileURL`、`targetFileURL`、`checkpointPath`按LINK-003～005顺序保留。
- 日志/持久化：import ledger仅驻留内存；receipt和启动摘要不含字幕正文、API Key、header、capability或raw path。任务队列仍不持久化。
- 第三方来源与许可：未新增第三方依赖或运行时资产。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/services/subtitle/translatorQueueService.test.ts src/services/subtitle/translatorImportLedger.test.ts src/services/subtitle/subtitleTranslatorTaskFactory.test.ts src/services/subtitle/generatedSubtitleImportCoordinator.test.ts src/agent/task-model-config.test.ts test/translation/translation-service-task-identity.test.ts test/translation/base-translator.test.ts test/translation/base-translator-runtime.test.ts
node_modules/.bin/vitest run src/services/subtitle src/store/tools/subtitle src/agent test/translation
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：聚焦8个测试文件/53项测试；扩大范围21个测试文件/127项测试；TypeScript；renderer/main/preload三段Vite test build；diff check。
- 未运行及原因：未运行Electron人工UX、目标GPU、packaged或Windows矩阵；本包只修改跨平台任务身份/队列合同，真实平台验证继续归QA。
- 真实硬件/packaged范围：无。

## 产生的证据

- 测试和构建输出仅在当前会话终端；未生成需要提交的截图、模型或runtime资产。
- 未启动Vite/Electron常驻服务。

## 未完成事项与风险

- legacy raw path、恢复三字段去重和checkpoint path仍存在；不得在LINK-003～005全消费者迁移前删除。
- import ledger尚未消费LINK-006 one-shot token，也未持有target handle；完整candidate/receipt/release所有权闭环属于LINK-007B。
- `startTasks`当前回执表示执行请求被队列接受；后续API/解析/写入失败继续进入既有任务失败状态。

## 下一步建议

- 实施LINK-003：建立translator-owned目录capability、generated/legacy互斥任务引用、main-only target解析与同task原子重授权，同时继续保留legacy adapter和`outputURL`。
- LINK-003完成后进入LINK-007B，接通one-shot token、main-private candidate、target handle、完整import receipt与release cleanup。
