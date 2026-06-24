# 工作包 MD-006：Markdown 串行记忆、恢复与 stale 接入

## 基本信息

- 日期：2026-06-24
- 状态：已完成
- 对应执行计划工作包：`MD-006`

## 本次实现内容

- 移除 Markdown `sequential_context` 的 `not_implemented` 限制。
- 串行 executor 按 segment 所属文件格式分派：
  - TXT 继续使用原 sequential translation / memory patch 协议。
  - Markdown 使用 nested protocol：外层 sequential translation / memory patch，translation section 内为 Markdown unit/block 协议。
- Markdown target-only 和 bilingual 串行结果继续使用 `MD-005` 的结构化 JSON 增量持久化格式。
- 每个 segment 在可信译文解析成功后才应用 `memoryPatch`；Markdown protocol/placeholder 失败时最多加强约束重试一次，失败响应中的 patch 不会写入稳定记忆。
- memory patch 缺失或非法时保留可信译文，并为当前 segment 写入同版本 periodic memory snapshot，保证后续 retranslate 可以恢复稳定记忆。
- 串行恢复从第一个未完成 Markdown segment 继续，已完成结果不会重复请求。
- `retranslateFromSegment()` 复用现有 stale event 和 memory snapshot 机制，Markdown 后续结果不会进入输出，重新执行成功后 stale 清空。
- 最近上下文可从 TXT、Markdown target-only 或 Markdown bilingual 结构化结果生成文本摘要。
- ordered project 明确支持 TXT/Markdown 混合格式，严格按文件顺序共享同一语义记忆链。

## 修改文件

- `electron/main/text-translation/text-translation-service.ts`
- `test/text-translation/service/textTranslationService.e2e.test.ts`
- `docs/v0.2.10/text-translator/fix/2026-06-24_long_text_translator_markdown-e2e-gap.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-24_MD-006_markdown-sequential-recovery-stale.md`

## 接口或数据结构变化

- `translateSegmentsSequential()` 统一返回 `RuntimeTranslationSegmentResult[]`，可同时承载 TXT 和 Markdown 结果。
- 新增内部 `SequentialSegmentTranslation`，统一表达：
  - 可信 segment 结果。
  - 用于近期上下文的译文摘要。
  - 可选 `memoryPatch`。
  - memory warnings。
  - usage。
- 新增内部 `translateSequentialSegment()`，按文件格式构建和解析串行请求。
- 新增 `summarizeTranslationResult()`，为 TXT、Markdown target-only、Markdown bilingual 生成近期译文上下文。
- 未新增 Renderer/IPC 公共类型；现有创建、恢复和 retranslate IPC 直接获得 Markdown 串行能力。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts
pnpm exec vitest run test/text-translation
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- Service E2E：1 file / 13 tests passed，新增覆盖：
  - 两个 Markdown segment 严格串行。
  - partial task 重启后 resume，不重复请求已完成 segment。
  - Markdown 中间重翻、后续 stale、重新执行后 stale 清空。
  - placeholder mismatch 首次响应的 memory patch 不提交，加强约束重试成功后才推进版本。
  - ordered project 中 TXT -> Markdown 混合格式共享记忆。
- 全部 `test/text-translation`：16 files / 134 tests passed。
- 共享类型、IPC、Renderer execution service：3 files / 15 tests passed。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：通过；保留项目既有动态/静态 import、chunk size 和未签名 macOS 打包警告，DMG/ZIP 及 block map 正常生成。
- `git diff --check`：通过。

说明：

- fake OpenAI Compatible server 需要监听 `127.0.0.1`，service E2E 和完整文本翻译回归均已通过提升权限执行。

## 未完成事项

- Renderer 文件选择、拖拽和提示仍只开放 TXT，由 `FE-005` 补齐。
- Markdown 完整自动化验收和复杂 fixture 收口由 `QA-MD-001` 完成。
- README/CHANGELOG 中的 Markdown 未开放限制需在 UI 验收后由 `DOC-MD-001` 更新。

## 下一步建议

- 下一包认领 `FE-005`：开放 `.md/.markdown` 输入，并同步多选、ordered project、Beta 和资源限制文案。
- UI 开放后再执行 `QA-MD-001`，确认用户可见入口与主进程能力一致。
