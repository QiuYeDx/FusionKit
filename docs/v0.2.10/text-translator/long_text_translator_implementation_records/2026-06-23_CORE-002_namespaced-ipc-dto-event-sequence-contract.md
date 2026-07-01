# 工作包 CORE-002：Namespaced IPC DTO 与事件序列契约

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：CORE-002

## 本次实现内容

- 新增 `text-translation:*` IPC channel 与事件 channel 常量，覆盖创建、准备、启动、暂停、取消、恢复、重启、删除、可恢复任务查询、详情查询、打开输出目录和打开工作区。
- 新增 IPC 请求/响应 DTO、结构化错误 envelope、`taskId` 控制请求、事件 DTO 和事件 channel 映射。
- 新增创建任务请求运行时校验，确保请求只携带文件路径、配置和运行时模型凭据，并拒绝 `content` / `sourceText` / `rawText` 等全文 payload。
- 新增主进程 `setupTextTranslationIPC` 注册层，统一执行参数校验、service 调用和异常转结构化错误。
- 新增占位 `TextTranslationService`，所有真实业务方法暂时返回 `not_implemented`，后续 BE 工作包可替换内部实现而不改 IPC 契约。
- 新增 Renderer `textTranslatorExecutionService`，集中封装 channel 调用，并提供 `TextTranslationEventSequenceGuard` 与订阅函数，用于忽略重复或旧 sequence 事件。
- 在 Electron 主进程启动时注册长文本翻译 IPC。

## 修改文件

- `src/type/textTranslationIpc.ts`
- `src/type/textTranslationIpc.test.ts`
- `electron/main/text-translation/ipc.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `src/services/text/textTranslatorExecutionService.ts`
- `src/services/text/textTranslatorExecutionService.test.ts`
- `electron/main/index.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `TEXT_TRANSLATION_IPC_CHANNELS` 与 `TEXT_TRANSLATION_EVENT_CHANNELS`，所有 channel 均使用 `text-translation:` 命名空间，不复用字幕翻译的 `update-progress` / `task-failed` 等全局事件。
- 新增 `TextTranslationIpcResult<T>`：成功返回 `{ ok: true, data }`，失败返回 `{ ok: false, error }`。
- 新增 IPC 错误码：`invalid_ipc_request`、`missing_task_id`、`full_text_payload_not_allowed`、`not_implemented`、`internal_error`。
- 新增事件基础字段契约：所有主进程事件必须携带 `taskId`、`sequence`、`occurredAt`。
- 新增 Renderer sequence guard：同一 `taskId` 下只接受严格递增的 `sequence`。

## 验证结果

执行命令：

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm install --frozen-lockfile --ignore-scripts`：完成依赖链接。说明：工作区起初没有 `node_modules`；首次 `pnpm install --frozen-lockfile` 在 Electron postinstall 长时间无输出后被中断，因此使用 `--ignore-scripts` 完成本阶段验证所需依赖安装。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts`：3 个测试文件、15 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- 真实主进程 service 方法尚未实现，本阶段按计划只固定 IPC 薄层和 Renderer 事件消费契约。
- 未运行 `pnpm build`；本包不涉及页面/路由/构建配置，且 Electron postinstall 未完成。后续涉及构建或打包验证的工作包应先补齐 Electron postinstall。

## 下一步建议

- 继续认领 `BE-001：工作区 Repository 与事件日志`。
- BE-001 应复用本阶段的 `TextTranslationIpcResult` 和事件 DTO，避免另起一套错误 envelope 或事件 channel。
- Repository 实现时优先覆盖路径规范化、taskId 目录逃逸防护、原子 JSON 写入、NDJSON append/read 和事件重放恢复。
