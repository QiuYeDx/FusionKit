# 工作包 MD-005：主进程 Markdown parallel 端到端接入

## 基本信息

- 日期：2026-06-24
- 状态：已完成
- 对应执行计划工作包：`MD-005`

## 本次实现内容

- `createTask()` 放开 `.md` / `.markdown` parallel 任务；Markdown `sequential_context` 仍明确返回 `not_implemented`，留给 `MD-006`。
- `prepareTask()` 按文件格式分派 TXT 或 Markdown：
  - target-only 使用 Markdown translation units 规划 segment。
  - bilingual 使用冻结的 top-level Markdown blocks 规划 segment。
- 为 Markdown 工作区新增三类原子持久化数据：
  - `sources/<fileId>.txt`：规范化完整 Markdown source。
  - `segments/source/<segmentId>.json`：placeholder-safe unit/block payload。
  - `results/<segmentId>.json`：结构化 unit/block 翻译结果。
- Markdown parallel executor 接入 `MD-004` prompt/parser：
  - target-only 解析 `unitId -> translatedText`。
  - bilingual 解析 `blockId -> translatedMarkdown`。
  - protocol/placeholder 校验失败时最多执行一次加强约束重试，不写入不可信结果。
- 恢复扫描和 runtime record 重建按文件格式读取 TXT 文本结果或 Markdown JSON payload/result。
- 最终输出按文件格式分派：
  - target-only 使用冻结 source、持久化 units 和 unit results 做源码范围替换。
  - bilingual 使用冻结 source、冻结 blocks 和 block translations 插入 blockquote。
- source 文件变化或删除后，Markdown partial task 可继续使用 workspace 冻结数据恢复并完成输出。
- 修复 `MD-004` parser 对 unit 译文使用 `.trim()` 导致 Markdown 文本节点边界空格丢失的问题；现在只移除协议 marker 自身带来的一个换行。

## 修改文件

- `electron/main/text-translation/text-translation-service.ts`
- `electron/main/text-translation/persistence/workspace-repository.ts`
- `electron/main/text-translation/output/markdown-output-assembler.ts`
- `electron/main/text-translation/model/translation-response-protocol.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `test/text-translation/persistence/workspaceRepository.test.ts`
- `test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_markdown-e2e-gap.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-24_MD-005_markdown-parallel-e2e.md`

## 接口或数据结构变化

- `TextTranslationWorkspacePaths` 新增 `fileSourcesDir`。
- `TextTranslationWorkspaceRepository` 新增：
  - `writeFileSourceSnapshot()` / `readFileSourceSnapshot()`
  - `writeSegmentSourcePayload()` / `readSegmentSourcePayload()`
  - `writeSegmentResultPayload()` / `readSegmentResultPayload()`
- Markdown segment source/result 使用 `schemaVersion: 1` 和以下 kind：
  - `markdown_target_only`
  - `markdown_bilingual`
- `assembleMarkdownBilingualContent()` 可直接消费冻结的 `MarkdownBilingualBlock[]`，避免恢复输出时重新生成 block plan。
- 新增 `writeMarkdownBilingualOutput()`。
- TXT segment source/result 仍沿用原 `.txt` 文件，旧工作区读取路径不变。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/output/markdownOutputAssembler.test.ts
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run test/text-translation
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- Repository/protocol/parser/output 定向回归：4 files / 30 tests passed。
- Markdown 协议空格保真修复后 protocol/output 回归：2 files / 17 tests passed。
- Service E2E：1 file / 10 tests passed，包含：
  - Markdown parallel target-only。
  - Markdown parallel bilingual blockquote。
  - source 删除后的 partial resume。
  - 原有 TXT、串行记忆、ordered project 回归。
- 全部 `test/text-translation`：16 files / 131 tests passed。
- 共享类型、IPC、Renderer execution service：3 files / 15 tests passed。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：通过；保留项目既有动态/静态 import、chunk size 和未签名 macOS 打包警告，DMG/ZIP 及 block map 正常生成。
- `git diff --check`：通过。

说明：

- fake OpenAI Compatible server 需要监听 `127.0.0.1`，沙箱内会报 `listen EPERM`；service E2E 和完整文本翻译回归均已通过提升权限成功执行。

## 未完成事项

- Markdown `sequential_context` 仍未开放；创建该类任务会返回 `not_implemented`。
- Markdown memoryVersion、严格串行、resume、retranslate stale 和 placeholder mismatch 不推进稳定记忆版本由 `MD-006` 实现。
- Renderer 文件选择仍只开放 TXT，由 `FE-005` 补齐。

## 下一步建议

- 下一包认领 `MD-006`：复用 `parseSequentialMarkdownTargetOnlyTranslationResponse()` / `parseSequentialMarkdownBilingualTranslationResponse()` 接入语义记忆、恢复和 stale。
- `MD-006` 需明确 ordered project 中 TXT/Markdown 混合格式的 sequential 行为；如不能安全支持，应在创建任务时显式拒绝并记录原因。
