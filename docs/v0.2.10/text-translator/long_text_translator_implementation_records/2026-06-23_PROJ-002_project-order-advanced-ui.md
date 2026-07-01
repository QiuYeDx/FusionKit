# 工作包 PROJ-002：项目排序与高级小说配置 UI

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：PROJ-002

## 本次实现内容

- Renderer 文件选择从单 TXT 升级为多 TXT 文件数组。
- 选择文件后按 `relativePath/fileName` 自然排序，并为提交请求写入冻结 order。
- 页面展示项目文件顺序、文件大小和显式序号。
- 提供上移/下移按钮调整顺序；未引入拖拽依赖，后续可替换为 DnD。
- 配置面板新增执行模式、项目模式、语义记忆 token、记忆重置文件序号。
- 串行模式下展示文档背景、翻译要求、文风要求和术语表编辑区。
- 术语表文本按 `原文 => 译文 # 备注` 或 `原文,译文` 解析为 glossary entries。
- 准备任务时根据文件数量自动使用 `ordered_project`，并把高级配置传入主进程。
- 串行模式侧栏显示费用提示，说明语义记忆 token 会提高输入费用。
- 恢复已有 task 时可把多文件 files 还原到页面文件列表。

## 修改文件

- `src/store/tools/text/useTextTranslatorStore.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `TextTranslatorPreferences` 新增 executionMode、projectMode、semanticMemoryTokenLimit、documentBackground、translationInstructions、styleInstructions、glossaryText 和 memoryResetFileOrdersText。
- 无新增 IPC；页面复用 PROJ-001 已完成的主进程 ordered project 契约。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 909 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- 核心文本翻译回归：12 个测试文件、72 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- 文件排序使用上/下按钮而非真正拖拽；功能已满足显式顺序确认，后续若引入 DnD 可替换交互。
- 未做浏览器级视觉截图验证；当前通过 i18n、类型、核心回归和 build 验证。
- 串行 token 费用仍为提示与准备后估算，未实现完整三段区间计算。

## 下一步建议

- 继续认领 `OUT-001：TXT 块级双语输出`。
- OUT-001 应扩展输出 assembler、配置枚举和 UI output mode，让 TXT 可输出原文块 + 译文块的双语对照。
