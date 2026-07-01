# 工作包 OUT-001：TXT 块级双语输出

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：OUT-001

## 本次实现内容

- TXT 输出组装器新增 `assembleTxtBilingualContent`，支持简洁模式和 `[Original]` / `[Translation]` 标签模式。
- 双语输出按 `TranslationSegment` 的 `startsMidUnit` / `endsMidUnit` 聚合为自然块，避免超长段落被分片后暴露 segment 边界。
- 空原文且空译文的保护块会被跳过，不生成无意义双语标签。
- 新增共享 `writeTxtOutput`，按 `outputMode` 在仅译文与双语输出之间切换，并复用路径解析、冲突处理和 UTF-8 原子写入。
- 主进程 `TextTranslationService` 写盘阶段接入 `outputMode` 与 `bilingualLabelMode`。
- 共享类型新增可选 `bilingualLabelMode`，IPC 创建任务校验支持 `none` / `labels`。
- Renderer 偏好新增输出内容和双语格式配置；双语模式下可选择简洁模式或标签模式。
- 四语言 `text` namespace 新增输出内容、双语格式和范围说明文案。
- TXT 输出单测覆盖双语简洁模式、标签模式、多 segment 自然块、空保护块和 shared writer 写盘路径。

## 修改文件

- `src/type/textTranslation.ts`
- `src/type/textTranslationIpc.ts`
- `electron/main/text-translation/output/text-output-assembler.ts`
- `electron/main/text-translation/text-translation-service.ts`
- `src/store/tools/text/useTextTranslatorStore.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/locales/en/text.json`
- `src/locales/zh/text.json`
- `src/locales/ja/text.json`
- `src/locales/zh-Hant/text.json`
- `test/text-translation/output/textOutputAssembler.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- `TextTranslationOptions.outputMode` 已可实际驱动 TXT 输出：
  - `target_only`：保持原有仅译文输出。
  - `bilingual`：输出原文自然块与译文自然块相邻的双语 TXT。
- `TextTranslationOptions.bilingualLabelMode?: "none" | "labels"`：
  - `none`：简洁模式，块内输出 `原文\n译文`。
  - `labels`：标签模式，块内输出 `[Original]\n原文\n[Translation]\n译文`。
- 新字段为可选字段；旧任务或旧恢复记录没有该字段时默认按简洁模式处理。

## 验证结果

执行命令：

```text
pnpm run i18n:check
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/output/textOutputAssembler.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts
pnpm build
git diff --check
```

结果：

- `pnpm run i18n:check`：8 个 namespace、四语言共 915 个 key，全量通过。
- `pnpm exec tsc --noEmit`：通过。
- `test/text-translation/output/textOutputAssembler.test.ts`：9 个测试通过。
- 核心文本翻译回归：12 个测试文件、77 个测试通过。
- `pnpm build`：通过；Renderer、Electron main、preload 与 electron-builder 均完成。构建过程仍有既有 chunk size / dynamic import 提示，以及本机缺少 macOS Developer ID 导致签名跳过提示，不阻塞产物生成。
- `git diff --check`：通过。

## 未完成事项

- Markdown 文件仍不在正式执行链路内；Markdown parser、placeholder 和 Markdown 输出由 MD-001/MD-002/MD-003 继续实现。
- 未做浏览器级视觉截图验证；本包通过 i18n、类型、核心回归、输出写盘单测和 build 验证。

## 下一步建议

- 继续认领 `MD-001：Markdown Parser 与保护占位符`。
- MD-001 需要把 PRE-002 的 AST 与源码位置验证结论落成正式 parser/placeholder 模块，保护 frontmatter、代码、URL、HTML、link/image 目标等不可翻译范围，并为 MD-002/MD-003 提供稳定可替换的 Markdown unit。
