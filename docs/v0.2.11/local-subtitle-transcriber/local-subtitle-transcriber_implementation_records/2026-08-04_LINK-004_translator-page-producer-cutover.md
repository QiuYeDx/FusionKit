# 工作包 LINK-004：普通页面与 Agent 新任务生产者无路径切换

## 基本信息

- 日期：2026-08-04～2026-08-05
- 状态：已完成
- 对应执行计划工作包：LINK-004
- 目标平台/硬件：跨平台 TypeScript / Electron main + preload + renderer；不依赖目标 GPU 或 Windows 环境

## 本次认领边界

- 包含：SubtitleTranslator 普通页面和 Agent 新建任务的 input/output capability、main-owned selection receipt、path-free task reference、main-only正文读取与执行路径解析、source reveal、删除清理、Agent schema/prompt及相关测试。
- 不包含：convert/extract 工具扩权、RecoveryDialog/checkpoint/Agent recovery 消费者迁移、legacy path/`outputURL` 删除；这些恢复边界继续归 LINK-005。

## 本次实现内容

- 新增严格 `authorized_task_v1`：source 仅含 owner-bound `authorized_file` token 与展示名，target 仅含 task-bound `authorized_directory` token 与展示 label，不携带 raw path。
- preload 的固定 `authorizeInputFile(File)` 在私有闭包中通过 `webUtils.getPathForFile()` 提取真实路径；synthetic File 或空路径 fail closed，受保护 channel 仍不进入 legacy generic invoke。
- main 授权输入时冻结 canonical file identity 及其 parent directory identity，拒绝非普通文件、symlink、非法 leaf、跨 owner 与过期 token。
- main 在授权 identity 前后复核之间读取有界非空 UTF-8 正文，renderer 不再通过 `File.text()` 与后续授权形成竞态，也不会得到 source path。
- `registerAuthorizedTask` 把 input token、taskId、输入展示名、output leaf 和 source/custom target authority 原子绑定；source 模式派生已冻结父目录 proof，custom 模式复用当前 translator draft，但每个任务取得独立 target handle。
- 普通页面新建任务的兼容 `originFileURL` / `targetFileURL` 为空；执行 service 剥离全部兼容 path 字段，只把 opaque reference 交给 main。main 按 sender/task authority 恢复运行时 source/target path，并在开始及写入边界复核。
- 队列卡片的 source reveal 改为 owner-bound fixed API；target 详情只显示目录 label。删除、清空和已完成批量移除统一释放所有 path-free task authority并沿用最多 5 次有界重试。
- 页面 custom picker 改用 translator-owned directory capability；不再读取或写入 legacy `outputURL` 来创建新任务。`outputURL` 仍原样保留给 LINK-005 前的恢复兼容。
- Agent `queue_subtitle_translate` 改为直接打开固定原生多文件 picker；main 对真实选择签发 owner-bound、短 TTL `subtitleSelectionRef` 和逐项 opaque `itemRef`，renderer/Agent 消息不接收 path。
- Agent 正文读取和任务注册都要求同一 selection/item binding；跨 owner、过期、重放、重复文件、非 SRT/LRC/VTT 文件和展示名换绑均 fail closed。
- Agent 工具 schema、description 和 system prompt 不再允许翻译工具使用 `filePaths`、`scanId` 或 raw `outputDir`；executor 另有运行时字段存在性检查，绕过 schema 也会在 picker 前拒绝。
- Agent custom 输出只调用 fixed directory picker。未消费 selection 与 custom directory draft 在 `finally` 中进入保留 opaque handle 的有界撤销重试；已注册任务持有独立 source/target authority，不被 draft cleanup 撤销。

## 修改文件

- Shared contract：`src/type/subtitleTranslationIpc.ts`、`src/type/subtitle.ts`。
- Preload/main：`electron/preload/subtitle-translation-api.ts`、`electron/preload/index.ts`、`electron/main/translation/directory-capability.ts`、`electron/main/translation/ipc.ts`。
- Renderer/Agent：`src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`、`src/services/subtitle/generatedSubtitleImportCoordinator.ts`、`translatorExecutionService.ts`、`src/store/tools/subtitle/useSubtitleTranslatorStore.ts`、`src/agent/{tool-executor,tool-schemas,tools,orchestrator}.ts`。
- Tests：`test/translation/subtitle-translation-{reference-schema,preload,directory-capability,ipc-service}.test.ts`、`src/services/subtitle/translatorExecutionService.test.ts`、`src/agent/{tool-executor-translation,tool-schemas}.test.ts`。

## 接口、状态或数据结构变化

- `SubtitleTranslationTaskReference` 新增 `authorized_task_v1`，和 `generated_task_v1` / `legacy_path_v1` 严格互斥。
- `subtitleTranslationApi` 新增 fixed `authorizeInputFile`、`readInputFile`、`revokeInputFile`、`registerAuthorizedTask` 与 `revealTaskSource`。
- Directory capability registry 新增 input draft、task-owned source authority、source/custom target 注册、identity-bound正文读取与 sender-bound source reveal。
- `subtitleTranslationApi` 新增 fixed `selectAgentInputFiles`、`readAgentInputFile`、`registerAgentAuthorizedTask` 与 `revokeAgentInputSelection`；main registry新增selection/item binding和最多100项边界。
- `SubtitleTranslatorTask.taskReference` 接受普通授权任务和生成任务；任一 path-free task 都通过 reference execution envelope，编辑接口仍不能换绑 reference。

## 安全、隐私与许可证检查

- 页面新任务、Store、执行 IPC、日志和持久化均不包含 source/target raw path；只保留文件正文、展示名、taskId 与 opaque ref。
- renderer 不能用 legacy `filePaths`、`outputURL` 或 synthetic File 换取 authority；main 复核 file/parent/target object identity 与 owner/session。
- Agent raw-path producer 已关闭；旧 `filePaths`、`scanId`、raw custom `outputDir` 不能通过 schema 或 executor 换取 capability。选择回执和目录 token 不进入 tool result、会话日志或持久化。
- 未新增第三方依赖、网络下载、二进制或许可证变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/agent/tool-executor-translation.test.ts src/agent/tool-schemas.test.ts test/translation/subtitle-translation-directory-capability.test.ts test/translation/subtitle-translation-ipc-service.test.ts test/translation/subtitle-translation-preload.test.ts
node_modules/.bin/vitest run src/services/subtitle src/store/tools/subtitle src/agent test/translation
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：最终聚焦 5 个测试文件 / 32 项测试；扩大范围 28 个测试文件 / 166 项测试；TypeScript；renderer/main/preload 三段 Vite test build；diff check。
- Vite 只有既有 chunk-size 与 `useModelStore` 动态/静态 import 提示，无新增构建失败。
- Agent executor 测试在无浏览器持久化 storage 的 Node 环境有 Zustand storage unavailable 提示，断言全部通过且未影响构建。
- 未运行 Electron 人工文件 picker/拖放/窗口矩阵、packaged 或 Windows 目标机测试；本 checkpoint 使用固定 IPC、真实临时文件 identity 与构建验证覆盖代码合同。

## 产生的证据

- 测试和构建输出仅在当前会话终端；未生成需提交的截图、模型或 runtime 资产。
- 未启动 Vite/Electron 常驻服务。

## 未完成事项与风险

- RecoveryDialog、Agent recovery、checkpointRef/v2 manifest、renderer recovery events 与历史 v1 reader仍归 LINK-005。
- legacy `outputURL`、`originFileURL`、`targetFileURL`、`checkpointPath` 继续保留，不能提前删除或关闭 legacy recovery adapter。
- 未做真实 Electron picker 的人工点击矩阵；固定 preload/main API、真实临时文件 identity、focused regression 与三段构建已覆盖代码合同，人工 UX 仍归 QA-002。

## 下一步建议

- 进入 LINK-005：建立 v2 path-free checkpoint、`checkpointRef`/`recoveryScanId`、RecoveryDialog 与 Agent recovery fixed flow，并保留历史 v1 main-only compatibility reader。
- 只有 LINK-005 全消费者、双 import order 与回滚矩阵通过后，才删除 legacy `outputURL` 并关闭新建任务的 legacy adapter。
