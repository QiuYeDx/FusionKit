# 工作包 MD-004：Markdown 执行协议与结果映射

## 基本信息

- 日期：2026-06-24
- 状态：已完成
- 对应执行计划工作包：`MD-004`

## 本次实现内容

- 在正式 `translation-response-protocol.ts` 中新增 Markdown 动态边界协议：
  - target-only：`unitId -> translatedText`
  - bilingual：`blockId -> translatedMarkdown`
- 新增 Markdown target-only / bilingual prompt builder、response formatter 和 parser，协议不依赖 `response_format`、tool calling 或厂商私有结构化输出能力。
- 新增 expected id 校验，缺失、重复、未知、乱序均抛出可诊断的 `TranslationProtocolError`。
- 复用 `validateProtectedPlaceholders()` 对每个 unit/block 的 protected placeholder 做完整性校验，缺失、重复、未知、乱序均触发 `placeholder_mismatch` 和重试提示。
- 新增 sequential Markdown parser，先解析既有 sequential translation / memory patch 边界，再解析 translation section 内的 Markdown unit/block 协议，避免译文区域与 `memoryPatch` 相互污染。
- 新增 Markdown 协议单测覆盖成功解析、sequential 共存、边界非法、id mismatch、placeholder mismatch 和 prompt marker 一致性。

## 修改文件

- `electron/main/text-translation/model/translation-response-protocol.ts`
- `test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_markdown-e2e-gap.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-24_MD-004_markdown-response-protocol-mapping.md`

## 接口或数据结构变化

- 新增 Markdown 协议 markers：
  - `<<<FUSIONKIT_MARKDOWN_TARGET_ONLY:{protocolId}>>>`
  - `<<<FUSIONKIT_MARKDOWN_BILINGUAL:{protocolId}>>>`
  - `<<<FUSIONKIT_MD_UNIT:{protocolId}:{unitId}>>>`
  - `<<<FUSIONKIT_MD_BLOCK:{protocolId}:{blockId}>>>`
  - `<<<FUSIONKIT_MARKDOWN_END:{protocolId}>>>`
- 新增 parser / formatter / prompt builder：
  - `parseMarkdownTargetOnlyTranslationResponse()`
  - `parseMarkdownBilingualTranslationResponse()`
  - `parseSequentialMarkdownTargetOnlyTranslationResponse()`
  - `parseSequentialMarkdownBilingualTranslationResponse()`
  - `formatMarkdownTargetOnlyTranslationResponse()`
  - `formatMarkdownBilingualTranslationResponse()`
  - `buildMarkdownTargetOnlyTranslationPrompt()`
  - `buildMarkdownBilingualTranslationPrompt()`
- `TranslationProtocolErrorCode` 新增：
  - `markdown_boundary_invalid`
  - `markdown_id_mismatch`
  - `placeholder_mismatch`
- `TranslationProtocolError` 新增可选 `retryInstruction` 字段，用于 placeholder mismatch 的加强重试提示。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts
pnpm exec tsc --noEmit
pnpm exec vitest run test/text-translation/protocol test/text-translation/parsing/markdownParser.test.ts test/text-translation/output/markdownOutputAssembler.test.ts
pnpm exec vitest run test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/output/markdownOutputAssembler.test.ts
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts`：1 file / 7 tests passed。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vitest run test/text-translation/protocol test/text-translation/parsing/markdownParser.test.ts test/text-translation/output/markdownOutputAssembler.test.ts`：新 Markdown 协议、Markdown parser、Markdown output 用例通过；旧 `modelResponseProtocolProbe.test.ts` 中 3 个 fake server transport 用例在沙箱内因 `listen EPERM: operation not permitted 127.0.0.1` 失败。按权限规则尝试提升权限重跑同一命令，但 Codex 自动审批因当前使用额度限制拒绝。
- `pnpm exec vitest run test/text-translation/protocol/markdownTranslationResponseProtocol.test.ts test/text-translation/parsing/markdownParser.test.ts test/text-translation/output/markdownOutputAssembler.test.ts`：3 files / 23 tests passed。
- `git diff --check`：通过。

## 未完成事项

- `MD-004` 不接入主进程执行链路；`.md` 文件仍不能端到端创建任务、prepare、翻译和输出。
- `test/text-translation/protocol` 完整目录内的旧 fake server transport 用例需要在允许本地监听 `127.0.0.1` 的环境中复跑。

## 下一步建议

- 下一包优先认领 `MD-005`：将 Markdown parser、MD-004 协议解析和 Markdown output assembler 接入 `TextTranslationService` 的 parallel 执行链路。
- `MD-005` 至少完成 single `.md` parallel target-only / bilingual fake-server E2E 后，再开放 Renderer `.md` 文件入口。
