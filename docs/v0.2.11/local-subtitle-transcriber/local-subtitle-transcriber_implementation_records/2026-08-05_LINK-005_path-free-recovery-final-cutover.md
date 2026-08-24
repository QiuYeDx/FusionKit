# 工作包 LINK-005：无路径恢复与最终切换

## 基本信息

- 日期：2026-08-05
- 状态：已完成
- 对应执行计划工作包：`LINK-005`
- 目标平台/硬件：跨平台 TypeScript / Electron main + preload + renderer；不依赖真实模型、GPU 或 Windows 环境

## 本次认领边界

- 包含：path-free checkpoint v2、历史 v1 main-only compatibility reader、恢复 scan/ref capability、RecoveryDialog、Agent recovery、renderer event、旧 path/Store 清理、恢复及最终输出原子写入。
- 不包含：Electron 人工 picker、窄窗口、键盘、cancel race、packaged 与真实 Windows/macOS 目标机矩阵；这些继续归 `QA-002` 及对应发布 QA。

## 本次实现内容

- checkpoint 升级为显式 v2，只持久化 task 元数据、翻译 options 与 `manifest_fragments`；不写 source/target/checkpoint path、capability/token、API Key 或模型凭据。
- `toCurrentManifest()` 对 v1/v2 均按顶层、options 与 fragment 白名单重建，历史路径和未知扩展字段不会进入新 checkpoint；未知 schema version 明确拒绝。
- manifest、completed/remaining/error artifact 与最终字幕使用同目录 unique temporary、`0600`、`fsync`、close、rename。新恢复 artifact 使用稳定 taskId hash 命名空间，同名任务不会互相覆盖；成功后删除含正文的 resume manifest，只保留 path-free `*.fusionkit.completed.json`。
- 成功清理按 artifact 独立执行已知 Windows 临时锁错误的有界重试；失败只记录 artifact 类型和错误码，不删除或否定已经提交的最终译文。
- 用户删除任务时，main 先复核 task-bound 目录并逐项清理 resume/completed/remaining/error/summary；全部成功后才释放 task/checkpoint authority，失败保留 authority 供 renderer 有界重试，最终字幕文件不属于清理目标。
- main 新增 owner/document-session-bound、短 TTL 的 `recoveryScanId` / `checkpointRef` registry。目录扫描与单 manifest 导入均只能经 fixed native picker，renderer 只收到展示名、进度和脱敏摘要。
- prepare 前重验 manifest file identity、size、mtime 与自包含结构；批量恢复任务必须重新选择 target 目录，跨 owner、过期、重放、文件变化和 target 换绑均 fail closed。
- checkpoint 原子 rename 会改变文件身份；失败/取消收口在最终 checkpoint 写入后重新签发 ref，使同 owner retry 始终绑定最新 manifest，而不是首次写入的旧 inode。
- RecoveryDialog 与 Agent recovery 已迁移到 fixed directory/manifest picker、opaque scan/ref 与 main batch preparation；Agent schema/prompt 不再接受 roots、checkpoint paths 或 Store `outputURL`。
- RecoveryDialog prepare 失败会有界撤销未消费的 output directory draft；prepare 已产生 task authority 而队列提交失败时按 taskId 进入统一释放重试。
- Agent tool result 使用显式 task-free batch 摘要；内部 prepared task、目录 token、checkpoint path 和字幕正文不会进入 Agent 日志或返回值。
- renderer progress/failure event 只携带 `checkpointRef`，resolved event 只携带 `outputFileName`；source/checkpoint/final output reveal 都走 owner-bound fixed API。
- `SubtitleTranslatorTask` renderer 类型移除 `originFileURL`、`targetFileURL`、`checkpointPath`；main 仅在执行边界根据 task reference 物化私有运行时路径。
- 旧 `legacy_path_v1` 新建入口和公开恢复 IPC 已删除。安全配置 Store 先完成目标写入与 exact readback，再删除旧 envelope 和独立 `outputURL` key；删除 readback 失败保持 migration blocked。

## 修改文件

- Main/checkpoint：`electron/main/translation/{checkpoint,recovery-artifacts,recovery-discovery,recovery-capability,directory-capability,ipc,typing}.ts`、`electron/main/translation/class/base-translator.ts`。
- Preload/shared contract：`electron/preload/subtitle-translation-api.ts`、`src/type/{subtitle,subtitleTranslationIpc}.ts`。
- Renderer/Agent/Store：`RecoveryDialog.tsx`、`SubtitleTranslator/index.tsx`、`src/renderer/subtitle.ts`、`src/services/subtitle/*`、`src/store/tools/subtitle/*`、`src/agent/{tool-executor,tool-schemas,tools,orchestrator}.ts`。
- Tests：Agent schema/executor、subtitle services/Store 与 `test/translation` capability/IPC/preload/translator 回归。

## 安全、隐私与迁移检查

- 新 checkpoint 和完成摘要不含绝对路径、token、capability 或模型密钥；历史 v1 raw path 只在 Electron main compatibility reader 内读取。
- recovery scan error 文本在返回 renderer 前脱敏；不返回扫描 root、checkpoint path 或字幕 fragment。
- target authority 不从 v1 `outputDir`、旧 Store 或展示 label 升级，恢复任务始终要求用户重新授权。
- owner release、scan revoke/TTL、任务删除与成功终态释放内存 authority；任务删除先完成磁盘恢复产物清理，失败/取消保留同 owner retry authority。
- 未新增依赖、网络下载、native artifact 或许可证变化；未调用 package manager，`pnpm-lock.yaml` 保持 lockfile v6。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/agent/tool-executor-translation.test.ts src/agent/tool-schemas.test.ts src/services/subtitle/generatedSubtitleImportCoordinator.test.ts src/services/subtitle/subtitleTranslatorTaskFactory.test.ts src/services/subtitle/translatorExecutionService.test.ts src/services/subtitle/translatorImportLedger.test.ts src/services/subtitle/translatorQueueService.test.ts src/store/tools/subtitle/subtitleTranslatorConfigBootstrap.test.ts src/store/tools/subtitle/useSubtitleTranslatorConfigStore.test.ts test/translation/base-translator.test.ts test/translation/subtitle-translation-directory-capability.test.ts test/translation/subtitle-translation-ipc-service.test.ts test/translation/subtitle-translation-preload.test.ts test/translation/subtitle-translation-reference-schema.test.ts test/translation/subtitle-translation-recovery-capability.test.ts
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：15 个测试文件 / 112 项测试；TypeScript；renderer/main/preload 三段 Vite test build；diff check。
- Vite 只有既有 chunk-size 与 `useModelStore` 动态/静态 import 提示，无新增构建失败。
- Agent executor 的 Node 测试有既有 Zustand storage unavailable 提示，断言全部通过。
- 未启动 Vite/Electron 常驻服务；未执行 Electron 人工 picker/窗口或真实模型/目标机矩阵。

## 未完成事项与风险

- Electron 文件/目录 picker 的人工交互、RecoveryDialog 窄窗口与键盘、取消竞态继续由 `QA-002` 验收。
- 本记录不证明 Windows/macOS packaged、真实模型或 GPU 路径；这些不属于 LINK-005 的恢复合同职责。
- 历史 v1 manifest 仍可能含 raw path，但只能由 main-only reader 在用户重新选择后读取，不会返回 renderer 或继续写入 v2。

## 下一步建议

- 继续 `LINK-008`，把 FE-004 的手动“送入字幕翻译”入口接到已经完成的 LINK-006/LINK-007 one-shot import coordinator。
- 随后按执行台账进入 `QA-001` / `QA-002`，集中处理回归与 Electron 产品交互矩阵。
