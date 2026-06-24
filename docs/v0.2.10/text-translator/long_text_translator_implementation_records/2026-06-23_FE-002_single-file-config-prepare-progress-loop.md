# 工作包 FE-002：单文件配置、准备与进度闭环

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：FE-002

## 本次实现内容

- 将 `TextTranslator` 页面从静态骨架升级为单 TXT 手动闭环页面。
- 支持选择或拖入单个 `.txt` 文件；Renderer 只读取文件路径、名称、大小和修改时间，不读取源文件正文。
- 支持配置源语言/目标语言、分片 token、并发数、输出目录模式、输出目录和冲突策略。
- 新增 `useTextTranslatorStore`，仅持久化用户偏好和 `activeTaskId`；不持久化源文件全文、segment source、译文或 API Key。
- 页面通过 `src/services/text/textTranslatorExecutionService.ts` 调用 create / prepare / start / cancel / delete / reveal 接口，不直接手写 IPC channel。
- prepare 后展示主进程探测到的编码、置信度、文件大小、segment 数和估算输入 token / 费用。
- start 后订阅 task/progress/file/task completed/failed 事件，更新进度条、segment 完成数和输出路径。
- 支持打开输出文件位置和任务工作区。
- 支持页面重新进入时根据持久化 `activeTaskId` 查询主进程 task detail。
- 主进程 `TextTranslationService` 增加 Renderer 事件 sink，向主窗口发送 task updated / progress / file completed / task completed / task failed 事件。
- `TextTranslationFileRef` 增加可选 `detectedEncoding` 和 `encodingConfidence` 摘要字段，用于 Renderer 展示，不包含正文。

## 修改文件

- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/store/tools/text/useTextTranslatorStore.ts`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `electron/main/text-translation/text-translation-service.ts`
- `electron/main/index.ts`
- `src/type/textTranslation.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `TextTranslationServiceOptions` 新增 `eventSink`，用于将主进程运行事件发送给 Renderer。
- `TextTranslationFileRef` 新增可选字段：
  - `detectedEncoding?: string`
  - `encodingConfidence?: number`
- `TextTranslationProgress.estimatedInputTokens` 在 prepare 阶段由 segment token 汇总填充，供前端展示输入 token 和费用估算。
- Renderer 新增持久化 key `fusionkit-text-translator`，只保存偏好和 `activeTaskId`。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/service/textTranslationService.e2e.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 869 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`：4 个测试文件、16 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 当前 UI 和 service 仍限定单 TXT、parallel、target-only。
- 并发模式的单 segment 失败仍会让任务进入失败路径，尚未形成 `partially_completed` 的可靠状态语义。
- 恢复扫描、继续执行、重启和恢复 UI 由 REL-002 / REL-003 完成。
- 串行语义记忆、多文件项目、Markdown 和双语输出仍由后续 MEM/PROJ/MD/OUT 工作包完成。

## 下一步建议

- 继续认领 `REL-001：任务状态机、部分完成与生命周期控制`。
- REL-001 应先收口状态转换守卫、并发部分完成、取消语义和失败分类，再让 REL-002 依赖稳定状态做恢复扫描。
