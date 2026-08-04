# 工作包 LINK-004：普通字幕翻译页面生产者无路径切换

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：LINK-004
- 目标平台/硬件：跨平台 TypeScript / Electron main + preload + renderer；不依赖目标 GPU 或 Windows 环境

## 本次认领边界

- 包含：SubtitleTranslator 普通页面新任务的 input/output capability、path-free task reference、main-only正文读取与执行路径解析、source reveal、删除清理和相关测试。
- 不包含：Agent 新建任务的 main-owned selection receipt/用户确认扫描、RecoveryDialog/checkpoint 恢复消费者迁移、legacy path/`outputURL` 删除；LINK-004 因 Agent 子项尚未完成而保持进行中。

## 本次实现内容

- 新增严格 `authorized_task_v1`：source 仅含 owner-bound `authorized_file` token 与展示名，target 仅含 task-bound `authorized_directory` token 与展示 label，不携带 raw path。
- preload 的固定 `authorizeInputFile(File)` 在私有闭包中通过 `webUtils.getPathForFile()` 提取真实路径；synthetic File 或空路径 fail closed，受保护 channel 仍不进入 legacy generic invoke。
- main 授权输入时冻结 canonical file identity 及其 parent directory identity，拒绝非普通文件、symlink、非法 leaf、跨 owner 与过期 token。
- main 在授权 identity 前后复核之间读取有界非空 UTF-8 正文，renderer 不再通过 `File.text()` 与后续授权形成竞态，也不会得到 source path。
- `registerAuthorizedTask` 把 input token、taskId、输入展示名、output leaf 和 source/custom target authority 原子绑定；source 模式派生已冻结父目录 proof，custom 模式复用当前 translator draft，但每个任务取得独立 target handle。
- 普通页面新建任务的兼容 `originFileURL` / `targetFileURL` 为空；执行 service 剥离全部兼容 path 字段，只把 opaque reference 交给 main。main 按 sender/task authority 恢复运行时 source/target path，并在开始及写入边界复核。
- 队列卡片的 source reveal 改为 owner-bound fixed API；target 详情只显示目录 label。删除、清空和已完成批量移除统一释放所有 path-free task authority并沿用最多 5 次有界重试。
- 页面 custom picker 改用 translator-owned directory capability；不再读取或写入 legacy `outputURL` 来创建新任务。`outputURL` 仍原样保留给 LINK-005 前的恢复兼容。

## 修改文件

- Shared contract：`src/type/subtitleTranslationIpc.ts`、`src/type/subtitle.ts`。
- Preload/main：`electron/preload/subtitle-translation-api.ts`、`electron/preload/index.ts`、`electron/main/translation/directory-capability.ts`、`electron/main/translation/ipc.ts`。
- Renderer：`src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`、`src/services/subtitle/generatedSubtitleImportCoordinator.ts`、`translatorExecutionService.ts`、`src/store/tools/subtitle/useSubtitleTranslatorStore.ts`。
- Tests：`test/translation/subtitle-translation-{reference-schema,preload,directory-capability,ipc-service}.test.ts`、`src/services/subtitle/translatorExecutionService.test.ts`。

## 接口、状态或数据结构变化

- `SubtitleTranslationTaskReference` 新增 `authorized_task_v1`，和 `generated_task_v1` / `legacy_path_v1` 严格互斥。
- `subtitleTranslationApi` 新增 fixed `authorizeInputFile`、`readInputFile`、`revokeInputFile`、`registerAuthorizedTask` 与 `revealTaskSource`。
- Directory capability registry 新增 input draft、task-owned source authority、source/custom target 注册、identity-bound正文读取与 sender-bound source reveal。
- `SubtitleTranslatorTask.taskReference` 接受普通授权任务和生成任务；任一 path-free task 都通过 reference execution envelope，编辑接口仍不能换绑 reference。

## 安全、隐私与许可证检查

- 页面新任务、Store、执行 IPC、日志和持久化均不包含 source/target raw path；只保留文件正文、展示名、taskId 与 opaque ref。
- renderer 不能用 legacy `filePaths`、`outputURL` 或 synthetic File 换取 authority；main 复核 file/parent/target object identity 与 owner/session。
- Agent 现有 raw-path producer 尚未升级，也没有被静默包装成 capability；在 main-owned `subtitleSelectionRef` 完成前，LINK-004 不结项。
- 未新增第三方依赖、网络下载、二进制或许可证变化。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/translation/subtitle-translation-reference-schema.test.ts test/translation/subtitle-translation-preload.test.ts test/translation/subtitle-translation-directory-capability.test.ts test/translation/subtitle-translation-ipc-service.test.ts src/services/subtitle/translatorExecutionService.test.ts
node_modules/.bin/vitest run src/services/subtitle src/store/tools/subtitle src/agent test/translation
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 通过：聚焦 5 个测试文件 / 21 项测试；扩大范围 27 个测试文件 / 156 项测试；TypeScript；renderer/main/preload 三段 Vite test build；diff check。
- Vite 只有既有 chunk-size 与 `useModelStore` 动态/静态 import 提示，无新增构建失败。
- 未运行 Electron 人工文件 picker/拖放/窗口矩阵、packaged 或 Windows 目标机测试；本 checkpoint 使用固定 IPC、真实临时文件 identity 与构建验证覆盖代码合同。

## 产生的证据

- 测试和构建输出仅在当前会话终端；未生成需提交的截图、模型或 runtime 资产。
- 未启动 Vite/Electron 常驻服务。

## 未完成事项与风险

- `src/agent/tool-executor.ts` 的 `queue_subtitle_translate` 仍读取 renderer raw `filePaths` / `scanId` / `outputDir`；不能直接把这些值升级为 authority。
- Agent 需要 main fixed picker或用户确认扫描签发的 owner-bound `subtitleSelectionRef`，再由 fixed API读取正文并注册 task refs；工具 schema、prompt、confirmation 与测试需同步迁移。
- RecoveryDialog、Agent recovery、checkpointRef/v2 manifest、renderer recovery events 与历史 v1 reader仍归 LINK-005。
- legacy `outputURL`、`originFileURL`、`targetFileURL`、`checkpointPath` 继续保留，不能提前删除或关闭 legacy recovery adapter。

## 下一步建议

- 继续 LINK-004 Agent 子项：建立 main-owned `subtitleSelectionRef` 与用户确认扫描/固定 picker，迁移 `queue_subtitle_translate`，明确拒绝任意 renderer raw path 和 raw custom outputDir。
- Agent 新任务回归稳定后将 LINK-004 标为已完成，再进入 LINK-005 的 checkpoint/recovery 最终 cutover。
