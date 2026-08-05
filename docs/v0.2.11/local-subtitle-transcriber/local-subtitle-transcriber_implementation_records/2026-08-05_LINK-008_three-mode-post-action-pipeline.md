# 工作包 LINK-008：三模式逐文件翻译后处理流水线

## 基本信息

- 日期：2026-08-05
- 状态：已完成
- 对应执行计划工作包：LINK-008，同时完成 FE-004 手动交接入口
- 目标平台/硬件：跨平台 TypeScript / Electron main + preload + renderer；不依赖 Windows、目标 GPU 或真实外部翻译 API

## 本次认领边界

- 包含：三模式 UI、SRT/LRC 输出与首选交接格式、翻译配置 prepare/确认/commit、逐文件自动交接、不可变回执、精确启动、手动新快照交接、取消/partial failure、任务删除后的恢复入口及四语言。
- 不包含：真实外部 API 调用、Electron 四语言/主题/宽窄窗口人工矩阵、packaged app、Windows/macOS 目标机、GPU、installer 或发布验收；这些继续归 QA-001～QA-005。

## 本次实现内容

- 两个依赖 Checkbox 严格映射 `export_only`、`enqueue_translation`、`enqueue_and_start_translation`，draft 默认保持 `export_only`，不存在“未入队但自动开始”状态。
- SRT/LRC 可组合选择且至少保留一种；交接格式为当前已启用格式中的单选。批次开始前由 translator-owned coordinator 冻结语言、输出、切片、profile/execution binding 与 handoff mode，并在 ScrollableDialog 中显示脱敏摘要。
- auto-start 模式明确提示可能产生外部 API 费用；enqueue-only 明确提示未启动任务只属于当前会话。prepare 失败直接展示配置/目录/profile原因，不静默降级或复用旧 snapshot。
- local enqueue request 必须携带 opaque `translationSnapshotId`；Job Manager 把它冻结在 main-private config，但 batch/task/session summary 不返回该 ID。production executor接受三种post-action config，只负责本地转写与产物生成。
- 新增 renderer-session singleton `LocalSubtitlePostActionService`。页面离开后，已提交批次仍通过共享 runtime 事件逐文件处理；注册晚于完成事件时会从当前 authoritative snapshot 追平。
- 自动交接只使用冻结的首选格式和已 committed artifact；首选格式失败时记录 skipped/failed，不以另一个成功格式替代。取消后产生的 partial commit 不自动交接，只保留本地产物和显式手动入口。
- coordinator 继续只调用 `startTasks(receipt.addedTaskIds)`，绝不调用 `startAllTasks()`；估算或 start 失败保留已加入的 translation taskId，只提供查看已有任务，不重复导入。
- `local-subtitle:complete-post-action` 是 fixed、owner-bound public IPC。main只允许 completed task/generation/mode/format匹配的终态回执写入一次；同值重放幂等，替换终态回执被拒绝，Session Registry同时阻止后续内部 mutation。
- 可重试的本地转写失败保留批次 translation snapshot；同 taskId 的新 generation 成功后继续自动交接。cancelled/removed/owner release收敛批次，snapshot release和回执发布都使用有界重试。
- 手动交接每次点击都创建新 snapshot。翻译任务被删除后，旧“查看翻译任务”入口隐藏，只对原首选产物开放显式新交接；存在的任务即使 start 失败也不会重新导入。

## 关键状态与接口变化

- enqueue translation post-action新增必填 `translationSnapshotId`，renderer summary只暴露`postActionMode`和`preferredHandoffFormat`。
- task初始自动状态为`pending/not_requested`；最终状态由实际 import receipt映射为queued/skipped/failed与started/waiting/failed。
- `GeneratedSubtitleImportCoordinator.hasTask()`查询当前会话五类translator队列，用于区分“任务仍存在”与“已删除后允许新交接”。
- automatic service ownership高于React页面生命周期；组件只持有确认dialog和手动操作的展示状态。

## 安全与生命周期检查

- snapshot ID保持opaque且不进入local batch/session summary；API Key、endpoint、raw path、file/directory token和artifact正文不进入本地持久化或日志。
- one-shot handoff、candidate ownership和translator task authority继续沿用LINK-006/007合同；release snapshot不会撤销已属于`addedTaskIds`的task handle。
- 页面卸载与enqueue竞态按commit结果处理：成功则把批次交给session singleton，失败则释放snapshot；未提交draft capability仍由既有cleanup queue回收。
- 按FusionKit pitfall guard复核了SPA capability清理、i18n source usage、跨工具typed handoff、session revision、runtime pin及draft-to-task authority规则。该流程直接促成了可重试失败保留snapshot、晚注册追平和结束前进程检查。

## 修改文件

- Shared/preload/main：`src/type/localSubtitleIpc.ts`、`electron/preload/local-subtitle-api.ts`、`electron/main/local-subtitle/{job-ipc,job-manager,session-registry,production-executor}.ts`。
- Renderer/coordinator：`src/services/local-subtitle/localSubtitlePostActionService.ts`、`src/services/subtitle/generatedSubtitleImportCoordinator.ts`。
- UI：`src/pages/Tools/Subtitle/LocalSubtitleTranscriber/{index,LocalSubtitleTaskQueue,LocalSubtitleTranslationConfirmDialog,localSubtitleTranscriberModel}.tsx/ts`。
- i18n/tests：四份`src/locales/*/subtitle.json`及IPC、preload、Job Manager、Executor、coordinator、page/model/post-action聚焦测试。

## 验证结果

执行命令：

```text
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vitest run <12个LINK-008聚焦测试文件> --reporter=dot
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：12个聚焦测试文件 / 251项测试；TypeScript；四语言各1740 keys且source usage全部解析；renderer/main/preload三段Vite test build；diff check。
- Vite只有既有chunk-size和`useModelStore`动态/静态import提示，无新增构建失败。
- 未运行全量Vitest、Electron人工矩阵、真实外部翻译 API、packaged或目标机测试；这些不是本工作包的代码闭环证明。
- 本轮没有启动Vite/Electron/frontend常驻服务。

## 未完成事项与下一步

- LINK-008与FE-004代码职责已完成，默认仍为`export_only`。
- 下一步进入QA-001扩大自动化与Audio/Subtitle/Agent回归；QA-002再做真实Electron交互、四语言、宽窄窗口、键盘、artifact expiry/copy failure和cancel/import竞态。
- MODEL-002/FE-002仍需真实大文件、Windows CUDA、unrestricted Metal和packaged产品证据，不因本次跨平台代码验证而改变状态。
