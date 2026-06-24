# 工作包 BE-002：文件检查、编码探测与解码

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：BE-002

## 本次实现内容

- 将 PRE-001 的编码探测 spike 落地为正式模块 `encoding-detector.ts`。
- 固定首版支持编码：UTF-8、UTF-16 LE/BE、GB18030、Big5、Shift-JIS、EUC-JP、EUC-KR、Windows-1252。
- 保留 PRE-001 阈值：探测置信度不低于 `0.55`、质量分不低于 `0.82`、最佳与次佳探测差至少 `0.15`，高置信度 `0.90` 可免差值要求。
- 新增 `file-reader.ts`，负责扩展名识别、`fs.stat`、文件大小软警告/硬限制、fileId 生成、fingerprint、读取、编码探测/手动覆盖和换行规范化。
- 低置信度、空文件、非法扩展名、缺失文件和手动覆盖质量不足均抛出 `TextTranslationInputFileError`，携带稳定 error code 与 phase。
- 扩展 `TextTranslationErrorCode`，为输入模块补充 `file_not_found`、`path_is_not_file`、`file_read_failed`、`empty_file`、`encoding_detection_failed`、`manual_encoding_quality_failed`。
- 新增输入模块测试，覆盖全部 PRE-001 encoding fixture、UTF-8 fingerprint、Windows-1252 手动覆盖、二进制低置信度拒绝、非法扩展名和缺失文件。

## 修改文件

- `electron/main/text-translation/input/encoding-detector.ts`
- `electron/main/text-translation/input/file-reader.ts`
- `src/type/textTranslation.ts`
- `test/text-translation/input/textInputFileReader.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`

## 接口或数据结构变化

- 新增 `SupportedTextEncoding`、`EncodingDecisionSource`、`EncodingDetectionResult`、`EncodingCandidateScore`。
- 新增 `detectTextEncoding`、`decodeTextBuffer`、`normalizeTextEncodingName`、`calculateTextQuality`。
- 新增 `ReadTextTranslationInputFileRequest`、`TextTranslationEncodingSummary`、`TextTranslationDecodedInputFile`、`TextTranslationInputFileInspection`。
- 新增 `inspectTextTranslationInputFile`、`readAndDecodeTextTranslationInputFile`、`detectTextTranslationFileFormat`、`createTextTranslationFileId`。
- `TextTranslationDecodedInputFile.text` 是主进程内部使用的规范化文本，不应通过 IPC 发送给 Renderer。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/input/textInputFileReader.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts
pnpm exec tsc --noEmit
git diff --check
```

结果：

- `pnpm exec vitest run test/text-translation/input/textInputFileReader.test.ts`：1 个测试文件、14 个测试通过。
- `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts`：5 个测试文件、34 个测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `git diff --check`：通过。

## 未完成事项

- 本包只负责输入检查与解码，不负责 TXT unit/segment 规划；BE-003 继续处理规范化文本。
- 正式 service 尚未调用 `readAndDecodeTextTranslationInputFile`；BE-007 接入任务生命周期时需要把错误映射到 `detecting_encoding` / `inspecting_files` 阶段。

## 下一步建议

- 继续认领 `BE-003：TXT Parser、Unit 与 Segment Planner`。
- BE-003 应以 `TextTranslationDecodedInputFile.text` 为输入，生成稳定 `unitId`、`segmentId`、`globalIndex` 和 source snapshots。
- TXT parser 首版只处理 `.txt`，不要提前引入 Markdown AST 分支，避免和 MD-001 的保护占位符契约交叉。
