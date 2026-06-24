# 通用长文本文件翻译工具 Execution Plan

> 日期：2026-06-23
> Feature Slug：`long_text_translator`
> 对应设计文档：`docs/v0.2.10/text-translator/long_text_translator_final_design.md`
> 范围：把长文本翻译 Final Design 拆分为可跨会话实施、验证和交接的工作包。
> 当前状态：M0 技术验证、BE 主进程最小闭环（CORE-001/002、BE-001 至 BE-007）、`FE-001` 至 `FE-004` 文本翻译 UI、`REL-001` 至 `REL-003` 可靠恢复能力、`MEM-001` 至 `MEM-004` 串行语义记忆能力、`PROJ-001`/`PROJ-002` 有序项目能力、`OUT-001` TXT 块级双语输出、`MD-001` 至 `MD-003` Markdown 解析/输出组装能力、`DOC-001` README/发布说明和 `DOC-002` 工作区清理与兼容策略已完成；所有非测试工作包已完成，后续进入 `QA-001` 至 `QA-003` 验收收口。

---

## 1. 每次开发会话的使用方式

每次实现会话开始前，Agent 必须按顺序完成：

1. 完整阅读 `docs/v0.2.10/text-translator/long_text_translator_final_design.md`。
2. 完整阅读本执行计划。
3. 检查第 5 节进度台账，确认依赖已满足。
4. 认领一个最小可闭环工作包；如需同时认领强耦合工作包，必须在会话开始时说明原因。
5. 检查工作区现有改动，保留用户未提交内容，不覆盖无关文件。
6. 在编辑前明确本次预期输出、验证命令和不涉及的范围。

每次实现会话结束前必须：

1. 运行该工作包要求的验证，或准确记录无法运行的原因。
2. 更新第 5 节进度台账。
3. 在 `docs/v0.2.10/text-translator/long_text_translator_implementation_records/` 新增或更新实施记录。
4. 只有实现、测试、文档和验证均符合验收口径时，才标记为 `已完成`。
5. 如果实现证明 Final Design 的假设不成立，先更新 Final Design 或创建 `feat/` / `fix/` 文档，不能静默偏离。
6. 写明下一次最适合认领的工作包、遗留风险和验证缺口。

当前仓库正在进行文档归档重组：

- 本功能文档位于 `docs/v0.2.10/text-translator/`。
- 既有历史文档位于 `docs/archrive/`。
- 实现会话不得擅自恢复、撤销或重新移动这些归档文件。

---

## 2. 状态规则

工作包状态只允许使用：

- `未开始`
- `进行中`
- `已完成`
- `阻塞`
- `废弃`

状态解释：

- `未开始`：尚未认领，或只做过不影响代码的阅读。
- `进行中`：已经产生实现或验证工作，但尚未满足完整验收口径。
- `已完成`：代码、测试、文档、台账和验证均已闭环。
- `阻塞`：存在明确外部阻塞，且当前会话无法继续推进。
- `废弃`：经设计更新明确不再实施，必须记录替代方案或原因。

不能因为“主要代码已经写完”就提前标记完成。真实模型手工验证未完成时，可以在对应 QA 工作包中保留，不需要阻止纯逻辑工作包完成，但必须写明验证边界。

---

## 3. 总体推进原则

### 3.1 依赖优先级

按以下顺序推进：

1. 先完成高风险技术验证，固定第三方依赖和协议。
2. 再关闭“单个 TXT、仅译文、快速并发”的最小端到端路径。
3. 再补任务恢复、部分完成、取消和全局公平调度。
4. 再实现串行语义记忆和有序小说项目。
5. 再实现 Markdown 结构保护和双语输出。
6. 最后完成高级 UI、性能验收、清理策略和发布文档。

### 3.2 最小端到端路径

第一个可运行垂直切片必须具备：

```text
选择一个 TXT 文件
  -> 主进程自动识别编码
  -> 解析并按 token 分片
  -> 使用任务模型快速并发翻译
  -> 增量写工作区
  -> 组装仅译文 UTF-8 输出
  -> Renderer 展示进度和结果路径
```

该闭环不要求先实现：

- 串行语义记忆。
- 多文件有序项目。
- Markdown。
- 双语输出。
- 完整历史恢复管理 UI。

但是最小闭环的数据模型、工作区和 IPC 不得阻断这些后续能力。

### 3.3 工作包粒度

每个工作包应能在一个专注会话中完成。以下情况可以拆分：

- 变更文件超过预期且跨越多个模块。
- 单元测试需要大规模 fixture。
- 技术验证推翻了原依赖选择。
- 工作包同时包含主进程核心逻辑和复杂页面交互。

拆分时必须先更新本计划，再实施新增工作包。

---

## 4. 阶段与里程碑

| 里程碑 | 达成条件 |
| --- | --- |
| M0 技术方案冻结 | `PRE-001` 至 `PRE-004` 完成，依赖、协议、性能保护和工作区策略有验证记录 |
| M1 TXT 最小闭环 | 单个 TXT 可准备、快速并发翻译、输出仅译文并在 UI 展示结果 |
| M2 可靠并发任务 | 全局调度、失败分类、部分完成、暂停/取消、断点恢复可用 |
| M3 小说连贯模式 | 串行语义记忆、快照、压缩、跨文件有序项目可用 |
| M4 Markdown 与双语 | Markdown 保护、仅译文、引用块双语及 TXT 双语可用 |
| M5 发布候选 | 自动化测试、性能门槛、手工验收、i18n、README 和清理策略完成 |

---

## 5. 进度台账

| ID | 状态 | 完成日期 | 标题 | 关键变更文件 | 验证 | 实施记录 | 未决问题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PRE-001 | 已完成 | 2026-06-23 | 编码探测与解码依赖验证 | `package.json`、`pnpm-lock.yaml`、`test/text-translation/encoding/*`、Final Design | `pnpm exec vitest run test/text-translation/encoding/encodingProbe.test.ts`（16 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check`；Electron Node/ICU capability probe | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-001_encoding-detection-dependency-validation.md` | 无；正式模块由 BE-002 落地 |
| PRE-002 | 已完成 | 2026-06-23 | Markdown AST 与双语输出验证 | `package.json`、`pnpm-lock.yaml`、`test/text-translation/markdown/*`、Final Design | `pnpm exec vitest run test/text-translation/markdown/markdownAstProbe.test.ts`（7 tests passed）；`pnpm exec vitest run test/text-translation`；`pnpm exec tsc --noEmit`；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-002_markdown-ast-bilingual-validation.md` | 无；正式模块由 MD-001/002/003 落地 |
| PRE-003 | 已完成 | 2026-06-23 | 模型响应协议与 Fake Server 验证 | `test/text-translation/protocol/*`、Final Design | `pnpm exec vitest run test/text-translation/protocol/modelResponseProtocolProbe.test.ts`（11 tests passed）；`pnpm exec vitest run test/text-translation`（34 tests passed）；`pnpm exec tsc --noEmit`；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-003_model-response-protocol-validation.md` | 无；正式客户端与记忆合并由 BE-004、MEM-002 落地 |
| PRE-004 | 已完成 | 2026-06-23 | 小说级资源与工作区策略验证 | `test/text-translation/resource/*`、Final Design | `node --expose-gc test/text-translation/resource/resourceBenchmark.mjs`；`pnpm exec vitest run test/text-translation/resource/workspaceStrategyProbe.test.ts`（6 tests passed）；`pnpm exec vitest run test/text-translation/resource/workspaceStrategyProbe.test.ts test/text-translation/encoding/encodingProbe.test.ts test/text-translation/markdown/markdownAstProbe.test.ts`（29 tests passed）；`pnpm exec tsc --noEmit`；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-004_resource-workspace-strategy-validation.md` | 无；M0 技术方案冻结已达成 |
| CORE-001 | 已完成 | 2026-06-23 | 共享领域类型、默认值与校验 | `src/type/textTranslation.ts`、`src/type/textTranslation.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts`（8 tests passed）；`pnpm exec vitest run src/type/textTranslation.test.ts test/text-translation/resource/workspaceStrategyProbe.test.ts test/text-translation/encoding/encodingProbe.test.ts test/text-translation/markdown/markdownAstProbe.test.ts`（37 tests passed）；`pnpm exec tsc --noEmit`；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_CORE-001_shared-domain-types-defaults-validation.md` | 无；正式 IPC 由 CORE-002 落地 |
| CORE-002 | 已完成 | 2026-06-23 | Namespaced IPC DTO 与事件序列契约 | `src/type/textTranslationIpc.ts`、`electron/main/text-translation/ipc.ts`、`electron/main/text-translation/text-translation-service.ts`、`src/services/text/textTranslatorExecutionService.ts`、`electron/main/index.ts`、`src/type/textTranslationIpc.test.ts`、`src/services/text/textTranslatorExecutionService.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts`（15 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_CORE-002_namespaced-ipc-dto-event-sequence-contract.md` | 无；真实主进程 service 由 BE-001/BE-007 接入 |
| BE-001 | 已完成 | 2026-06-23 | 工作区 Repository 与事件日志 | `electron/main/text-translation/persistence/workspace-repository.ts`、`electron/main/text-translation/persistence/event-log.ts`、`test/text-translation/persistence/workspaceRepository.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts`（20 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_BE-001_workspace-repository-event-log.md` | 无；恢复扫描由 REL-002 接入 |
| BE-002 | 已完成 | 2026-06-23 | 文件检查、编码探测与解码 | `electron/main/text-translation/input/encoding-detector.ts`、`electron/main/text-translation/input/file-reader.ts`、`src/type/textTranslation.ts`、`test/text-translation/input/textInputFileReader.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts`（34 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_BE-002_file-inspection-encoding-decoding.md` | 无；正式 service 接入由 BE-007 完成 |
| BE-003 | 已完成 | 2026-06-23 | TXT Parser、Unit 与 Segment Planner | `electron/main/text-translation/types.ts`、`electron/main/text-translation/parsing/text-parser.ts`、`electron/main/text-translation/planning/token-counter.ts`、`electron/main/text-translation/planning/segment-planner.ts`、`test/text-translation/planning/textParserSegmentPlanner.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts`（39 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_BE-003_txt-parser-unit-segment-planner.md` | 无；source snapshot 写入由 BE-007 接入 Repository |
| BE-004 | 已完成 | 2026-06-23 | 通用模型客户端与重试策略 | `electron/main/ai/openai-compatible-client.ts`、`test/text-translation/model/openAICompatibleClient.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts`（46 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_BE-004_openai-compatible-client-retry-policy.md` | 字幕客户端暂未迁移，保持本期非阻塞 |
| BE-005 | 已完成 | 2026-06-23 | 全局公平请求调度器 | `electron/main/text-translation/request-scheduler.ts`、`test/text-translation/scheduler/requestScheduler.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts`（51 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_BE-005_global-fair-request-scheduler.md` | 无；BE-007 接入时需在 retry 等待期间释放槽位 |
| BE-006 | 已完成 | 2026-06-23 | TXT 仅译文输出组装器 | `electron/main/text-translation/output/text-output-assembler.ts`、`test/text-translation/output/textOutputAssembler.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts`（55 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_BE-006_txt-target-only-output-assembler.md` | 无；BE-007 接入真实 segment results |
| BE-007 | 已完成 | 2026-06-23 | 单文件并发执行垂直切片 | `electron/main/text-translation/text-translation-service.ts`、`test/text-translation/service/textTranslationService.e2e.test.ts` | `pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`（56 tests passed）；`pnpm exec tsc --noEmit`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_BE-007_single-file-parallel-vertical-slice.md` | 首版仅支持单 TXT、parallel、target-only；FE/REL 后续扩展 |
| FE-001 | 已完成 | 2026-06-23 | 工具入口与页面骨架 | `src/App.tsx`、`src/pages/Tools/_shared/toolMeta.ts`、`src/pages/Tools/index.tsx`、`src/pages/Tools/Text/TextTranslator/index.tsx`、`src/i18n/constants.ts`、`src/i18n/resources.ts`、`src/locales/*/tools.json`、`src/locales/*/text.json`、`src/index.css`、`vite.config.ts` | `pnpm run i18n:check`（8 namespaces / 800 keys passed）；`pnpm exec tsc --noEmit`；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_FE-001_tool-entry-page-skeleton.md` | 无；FE-002 接入真实单文件执行交互 |
| FE-002 | 已完成 | 2026-06-23 | 单文件配置、准备与进度闭环 | `src/pages/Tools/Text/TextTranslator/index.tsx`、`src/store/tools/text/useTextTranslatorStore.ts`、`src/locales/*/text.json`、`electron/main/text-translation/text-translation-service.ts`、`electron/main/index.ts`、`src/type/textTranslation.ts` | `pnpm run i18n:check`（8 namespaces / 869 keys passed）；`pnpm exec tsc --noEmit`；`pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`（16 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_FE-002_single-file-config-prepare-progress-loop.md` | 首版 UI 仍限定单 TXT、parallel、target-only；部分完成/恢复由 REL 工作包继续 |
| REL-001 | 已完成 | 2026-06-23 | 任务状态机、部分完成与生命周期控制 | `electron/main/text-translation/text-translation-service.ts`、`test/text-translation/service/textTranslationService.e2e.test.ts` | `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`（3 tests passed）；`pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`（58 tests passed）；`pnpm exec tsc --noEmit`；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_REL-001_task-state-machine-partial-lifecycle.md` | 暂停采用立即 abort 并保留工作区；继续执行由 REL-002 实现 |
| REL-002 | 已完成 | 2026-06-23 | 恢复扫描、校验与继续执行 | `electron/main/text-translation/persistence/workspace-repository.ts`、`electron/main/text-translation/text-translation-service.ts`、`src/type/textTranslation.ts`、`src/type/textTranslationIpc.ts`、`test/text-translation/service/textTranslationService.e2e.test.ts` | `pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`（3 tests passed）；`pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/persistence/workspaceRepository.test.ts test/text-translation/input/textInputFileReader.test.ts test/text-translation/planning/textParserSegmentPlanner.test.ts test/text-translation/model/openAICompatibleClient.test.ts test/text-translation/scheduler/requestScheduler.test.ts test/text-translation/output/textOutputAssembler.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`（58 tests passed）；`pnpm exec tsc --noEmit`；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_REL-002_recovery-scan-validate-resume.md` | UI 操作入口由 REL-003 完成 |
| REL-003 | 已完成 | 2026-06-23 | 恢复与错误管理 UI | `src/pages/Tools/Text/TextTranslator/index.tsx`、`src/locales/*/text.json` | `pnpm run i18n:check`（8 namespaces / 887 keys passed）；`pnpm exec tsc --noEmit`；`pnpm exec vitest run src/type/textTranslation.test.ts src/type/textTranslationIpc.test.ts src/services/text/textTranslatorExecutionService.test.ts test/text-translation/service/textTranslationService.e2e.test.ts`（18 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_REL-003_recovery-error-management-ui.md` | 未做手工点击验证；自动化覆盖 i18n/type/build/后端恢复路径 |
| MEM-001 | 已完成 | 2026-06-23 | 语义记忆模型、预算与快照 | `electron/main/text-translation/memory/semantic-memory.ts`、`electron/main/text-translation/memory/memory-budget.ts`、`electron/main/text-translation/memory/semantic-memory-manager.ts`、`electron/main/text-translation/persistence/workspace-repository.ts`、`test/text-translation/memory/semanticMemoryManager.test.ts` | `pnpm exec tsc --noEmit`；`pnpm exec vitest run test/text-translation/memory/semanticMemoryManager.test.ts`（5 tests passed）；核心文本翻译回归（11 files / 63 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_MEM-001_semantic-memory-budget-snapshots.md` | 用户术语和显式风格规则在本地裁剪中保留；模型 patch 合并与冲突 warning 由 MEM-002 落地 |
| MEM-002 | 已完成 | 2026-06-23 | 记忆 Patch 协议、合并与压缩 | `electron/main/text-translation/memory/memory-patch.ts`、`electron/main/text-translation/memory/semantic-memory-manager.ts`、`test/text-translation/memory/semanticMemoryPatch.test.ts` | `pnpm exec tsc --noEmit`；`pnpm exec vitest run test/text-translation/memory/semanticMemoryManager.test.ts test/text-translation/memory/semanticMemoryPatch.test.ts`（10 tests passed）；核心文本翻译回归（12 files / 68 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_MEM-002_memory-patch-merge-compression.md` | 串行 executor 尚未接入；压缩器通过注入函数预留给后续模型请求实现 |
| MEM-003 | 已完成 | 2026-06-23 | 连贯串行 Executor 与恢复 | `electron/main/text-translation/model/translation-response-protocol.ts`、`electron/main/text-translation/text-translation-service.ts`、`electron/main/text-translation/persistence/event-log.ts`、`test/text-translation/service/textTranslationService.e2e.test.ts` | `pnpm exec tsc --noEmit`；`pnpm exec vitest run test/text-translation/service/textTranslationService.e2e.test.ts`（5 tests passed）；核心文本翻译回归（12 files / 70 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_MEM-003_sequential-context-executor-recovery.md` | 首版串行 executor 仅接入单 TXT、target-only；中间重翻与 stale 由 MEM-004 落地 |
| MEM-004 | 已完成 | 2026-06-23 | 中间重翻与后续 stale 契约 | `src/type/textTranslationIpc.ts`、`src/services/text/textTranslatorExecutionService.ts`、`electron/main/text-translation/ipc.ts`、`electron/main/text-translation/text-translation-service.ts`、`electron/main/text-translation/persistence/event-log.ts`、`src/pages/Tools/Text/TextTranslator/index.tsx`、`src/locales/*/text.json`、`test/text-translation/service/textTranslationService.e2e.test.ts` | `pnpm run i18n:check`（8 namespaces / 888 keys passed）；`pnpm exec tsc --noEmit`；核心文本翻译回归（12 files / 70 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_MEM-004_retranslate-stale-contract.md` | 分片级 UI 操作入口暂未开放；恢复弹窗展示 staleFromSegmentId 影响提示 |
| PROJ-001 | 已完成 | 2026-06-23 | 有序多文件项目与跨文件记忆 | `src/type/textTranslation.ts`、`src/type/textTranslationIpc.ts`、`electron/main/text-translation/text-translation-service.ts`、`test/text-translation/service/textTranslationService.e2e.test.ts` | `pnpm run i18n:check`（8 namespaces / 888 keys passed）；`pnpm exec tsc --noEmit`；核心文本翻译回归（12 files / 72 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PROJ-001_ordered-project-cross-file-memory.md` | Ordered project 已支持多 TXT 主进程闭环；排序确认 UI 由 PROJ-002 完成 |
| PROJ-002 | 已完成 | 2026-06-23 | 项目排序与高级小说配置 UI | `src/store/tools/text/useTextTranslatorStore.ts`、`src/pages/Tools/Text/TextTranslator/index.tsx`、`src/locales/*/text.json` | `pnpm run i18n:check`（8 namespaces / 909 keys passed）；`pnpm exec tsc --noEmit`；核心文本翻译回归（12 files / 72 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PROJ-002_project-order-advanced-ui.md` | 使用上/下移动完成显式排序确认，未引入拖拽依赖；后续可替换为 DnD |
| OUT-001 | 已完成 | 2026-06-23 | TXT 块级双语输出 | `src/type/textTranslation.ts`、`src/type/textTranslationIpc.ts`、`electron/main/text-translation/output/text-output-assembler.ts`、`electron/main/text-translation/text-translation-service.ts`、`src/store/tools/text/useTextTranslatorStore.ts`、`src/pages/Tools/Text/TextTranslator/index.tsx`、`src/locales/*/text.json`、`test/text-translation/output/textOutputAssembler.test.ts` | `pnpm run i18n:check`（8 namespaces / 915 keys passed）；`pnpm exec tsc --noEmit`；核心文本翻译回归（12 files / 77 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_OUT-001_txt-bilingual-output.md` | TXT 已支持仅译文/双语简洁/双语标签输出；Markdown 输出由 MD-001/002/003 继续 |
| MD-001 | 已完成 | 2026-06-23 | Markdown Parser 与保护占位符 | `electron/main/text-translation/parsing/markdown-parser.ts`、`electron/main/text-translation/parsing/protected-placeholders.ts`、`test/text-translation/parsing/markdownParser.test.ts` | `pnpm run i18n:check`（8 namespaces / 915 keys passed）；`pnpm exec tsc --noEmit`；`pnpm exec vitest run test/text-translation/parsing/markdownParser.test.ts`（7 tests passed）；核心文本翻译回归（13 files / 84 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_MD-001_markdown-parser-protected-placeholders.md` | Parser/placeholder 已可供 MD-002/003 复用；service 暂未接入 Markdown 执行 |
| MD-002 | 已完成 | 2026-06-23 | Markdown 仅译文输出 | `electron/main/text-translation/output/markdown-output-assembler.ts`、`test/text-translation/output/markdownOutputAssembler.test.ts` | `pnpm run i18n:check`（8 namespaces / 915 keys passed）；`pnpm exec tsc --noEmit`；`pnpm exec vitest run test/text-translation/output/markdownOutputAssembler.test.ts`（5 tests passed）；核心文本翻译回归（14 files / 89 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_MD-002_markdown-target-only-output.md` | Markdown target-only assembler 已完成；service 暂未接入 Markdown 执行 |
| MD-003 | 已完成 | 2026-06-23 | Markdown 引用块双语输出 | `electron/main/text-translation/output/markdown-output-assembler.ts`、`test/text-translation/output/markdownOutputAssembler.test.ts` | `pnpm run i18n:check`（8 namespaces / 915 keys passed）；`pnpm exec tsc --noEmit`；`pnpm exec vitest run test/text-translation/output/markdownOutputAssembler.test.ts`（9 tests passed）；核心文本翻译回归（14 files / 93 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_MD-003_markdown-bilingual-blockquote-output.md` | Markdown 双语 blockquote assembler 已完成；service 暂未接入 Markdown 执行 |
| FE-003 | 已完成 | 2026-06-23 | 完整模式与高级配置 UI | `src/pages/Tools/Text/TextTranslator/index.tsx`、`src/locales/*/text.json` | `pnpm run i18n:check`（8 namespaces / 924 keys passed）；`pnpm exec tsc --noEmit`；核心文本翻译回归（14 files / 93 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_FE-003_complete-mode-advanced-config-ui.md` | UI 新增模式说明与动态上下文预算校验；Markdown 端到端执行仍未开放 |
| FE-004 | 已完成 | 2026-06-23 | 批量独立文件任务与队列体验 | `src/store/tools/text/useTextTranslatorStore.ts`、`src/pages/Tools/Text/TextTranslator/index.tsx`、`src/locales/*/text.json` | `pnpm run i18n:check`（8 namespaces / 927 keys passed）；`pnpm exec tsc --noEmit`；核心文本翻译回归（14 files / 93 tests passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_FE-004_batch-independent-file-queue.md` | 多文件可选择 independent_files 创建多个单文件 task；队列可视化依赖事件更新，未做浏览器点击验证 |
| QA-001 | 未开始 | — | 核心自动化测试与 Fixture 收口 | `test/text-translation/*`、相关单测 | 单元+集成套件稳定通过；fake server 不访问真实网络 | — | 无 |
| QA-002 | 未开始 | — | 小说级性能与资源验收 | benchmark/performance tests、记录 | 1/10/50 MB、数千 segment 恢复、写放大、Renderer payload | — | 根据结果确定硬限制 |
| QA-003 | 未开始 | — | 跨平台手工验收与真实模型验证 | 验收记录 | TXT/MD、编码、并发/串行、项目、恢复、取消、输出 | — | 真实供应商组合 |
| DOC-001 | 已完成 | 2026-06-23 | README、i18n、隐私与发布说明 | `README.md`、`CHANGELOG.md` | `pnpm run i18n:check`（8 namespaces / 927 keys passed）；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_DOC-001_readme-i18n-privacy-release-notes.md` | README/CHANGELOG 已说明 Beta 范围、隐私、费用与 Markdown 未开放限制 |
| DOC-002 | 已完成 | 2026-06-23 | 工作区清理与兼容策略收口 | `electron/main/text-translation/persistence/workspace-repository.ts`、`test/text-translation/persistence/workspaceRepository.test.ts`、Final Design、Execution Plan | `pnpm exec vitest run test/text-translation/persistence/workspaceRepository.test.ts`（7 tests passed）；`pnpm exec tsc --noEmit`；核心文本翻译回归（12 files / 85 tests passed）；`pnpm run i18n:check`（8 namespaces / 927 keys passed）；`pnpm build`；`git diff --check` | `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_DOC-002_workspace-cleanup-compatibility-strategy.md` | 清理能力落在 repository 计划/执行 API；自动触发 UI 暂不开放，避免静默删除用户数据 |

---

## 6. 工作包详情

### PRE-001：编码探测与解码依赖验证

目标：在写正式输入模块前，选择可维护的编码探测和解码组合。

实施范围：

- 比较候选依赖的 Electron/Node 兼容性、包体积、维护状态和许可证。
- 建立 UTF-8/BOM、UTF-16 LE/BE、GB18030、Big5、Shift-JIS、EUC-JP、EUC-KR、Windows-1252 fixture。
- 验证“BOM → 严格 UTF-8 → 候选探测 → 质量评分 → 完整解码”流程。
- 记录低置信度阈值和手动覆盖接口所需字段。
- 只做 spike 和决策，不提前实现完整业务模块。

验收口径：

- Final Design 列出的主要编码均有 fixture 结果。
- 明确最终依赖和 fallback。
- 不可靠结果会被拒绝，不把乱码当成功。
- 依赖决策写入实施记录；如需改变设计，先更新 Final Design。

### PRE-002：Markdown AST 与双语输出验证

目标：验证源码位置替换和引用块双语契约可以稳定实现。

实施范围：

- 比较支持 GFM、frontmatter、source position 的解析器组合。
- 对标题、段落、列表、嵌套列表、引用、嵌套引用、表格、链接、图片、代码块、HTML 建立 fixture。
- 验证 AST 不完整重序列化，只使用源码位置做替换/插入。
- 验证“原块 + 译文 blockquote”，尤其是列表和表格整体译文引用块。
- 记录无法安全支持的结构和警告策略。

验收口径：

- 可获得稳定源码偏移。
- 未翻译范围不会因 AST 序列化发生格式漂移。
- Markdown 双语 fixture 在应用使用的 Markdown 渲染器中可接受。
- 明确首版保护节点和可翻译节点。

### PRE-003：模型响应协议与 Fake Server 验证

目标：固定普通翻译响应和串行 `memoryPatch` 的可解析协议。

实施范围：

- 构建本地 fake OpenAI Compatible server/test adapter。
- 比较结构化 JSON 响应与边界标记文本协议。
- 覆盖 DeepSeek/OpenAI Compatible 常见返回形态、think 标签、usage 缺失、finish reason。
- 验证非法 memory patch 时“译文成功、记忆未更新”的降级边界。
- 固定占位符校验和加强约束重试协议。

验收口径：

- 协议不依赖单一厂商私有字段。
- 普通翻译和串行记忆均可稳定解析。
- 非法结构不会污染稳定语义记忆。
- Fake server 可被后续集成测试复用。

### PRE-004：小说级资源与工作区策略验证

目标：在正式实现前验证大文件内存、磁盘和工作区布局。

实施范围：

- 测量 1 MB、10 MB、50 MB TXT 的读取、解码、token 化和分片峰值内存。
- 使用代表性大型 Markdown 测量 AST 解析峰值内存。
- 验证 NDJSON、独立 source/result 文件和原子 JSON 的写入模型。
- 调研跨平台剩余磁盘空间检查。
- 验证成功任务保留 7 天的清理实现成本。

验收口径：

- 给出首版软警告和硬限制建议。
- 证明单片完成不会重写整个小说 manifest。
- 明确工作区路径、磁盘预估和清理策略实现方式。
- 性能数据写入实施记录。

### CORE-001：共享领域类型、默认值与校验

目标：建立 Renderer 与主进程可共享的稳定领域契约。

实施范围：

- 新增任务、文件、选项、状态、阶段、进度、错误、恢复 DTO。
- 提供默认配置和纯函数校验。
- 使用 `taskId` / `fileId`，禁止 `fileName` 作为任务唯一键。
- 定义不含敏感凭据的 persisted types。
- 固化 `partially_completed` 和错误阶段表达。

验收口径：

- 默认值与 Final Design 一致。
- 配置预算错误有稳定 error code。
- persisted types 不包含 API Key。
- 类型可在 Renderer 与 Electron 主进程使用，且 `tsc` 通过。

### CORE-002：Namespaced IPC DTO 与事件序列契约

目标：建立不传全文的 IPC 薄层。

实施范围：

- 注册 `text-translation:*` channels。
- 创建 task、准备、启动、暂停、取消、恢复、重启、删除、详情查询。
- 主进程事件全部带 `taskId`、`sequence`、`occurredAt`。
- Renderer execution service 集中管理 channel 字符串。
- 事件消费端忽略重复和旧 sequence。

验收口径：

- 创建请求只传路径、配置和运行期模型凭据。
- 敏感凭据不会进入持久化 DTO。
- IPC 参数错误返回结构化错误。
- 不复用字幕的全局 `update-progress` / `task-failed` 事件。

### BE-001：工作区 Repository 与事件日志

目标：提供小说级增量持久化基础。

实施范围：

- 受控创建 `<userData>/text-translation/tasks/<taskId>/`。
- 实现 task JSON 原子写、NDJSON append/read、source/result 独立文件、memory snapshots。
- 实现路径规范化和 taskId 目录逃逸防护。
- 实现事件重放和最小状态重建。
- API Key、完整正文日志禁止写入。

验收口径：

- 异常中断不会留下被当作成功结果的半文件。
- 数千事件可稳定重放。
- 删除只能作用于受控 task workspace。
- 原子写和损坏文件场景有测试。

### BE-002：文件检查、编码探测与解码

目标：实现用户无感的输入读取。

实施范围：

- 根据路径检查扩展名、大小、mtime、可读性和 fingerprint。
- 落地 PRE-001 的编码流程和质量评分。
- 记录编码、BOM、置信度和手动覆盖信息。
- 低置信度进入 `failed` + `detecting_encoding`，不发模型请求。
- 输出规范化文本供 parser 使用，并避免保留多份全文副本。

验收口径：

- 主要编码 fixtures 正确。
- 空文件和损坏文件有稳定行为。
- 低置信度不会静默输出乱码。
- Renderer 只获得摘要和警告。

### BE-003：TXT Parser、Unit 与 Segment Planner

目标：把 TXT 稳定转换为冻结的 units 和 segments。

实施范围：

- 空行段落、内部换行、章节标题提示。
- 超长段落按句子、标点、软换行和最终硬切降级。
- token 计数与请求预算联动。
- 生成稳定 unitId/segmentId/globalIndex。
- 将不可变索引和 source snapshots 写入工作区。

验收口径：

- 普通段落不被无故拆分。
- segment 不超过预算；硬切有标记。
- 同样输入与配置产生稳定顺序。
- 恢复直接使用冻结 segment，不重新规划。

### BE-004：通用模型客户端与重试策略

目标：提供可被长文本执行器复用的 OpenAI Compatible 请求层。

实施范围：

- endpoint、Authorization、proxy、AbortSignal、timeout。
- think 标签清理、usage、finish reason、错误脱敏。
- 指数退避、抖动、`Retry-After`。
- 可重试与不可重试错误分类。
- 空响应、长度截断和占位符协议错误的上层可诊断错误。

验收口径：

- Fake server 覆盖正常、408/429/5xx、401/403、timeout、abort。
- 不记录 API Key 或完整正文。
- 取消不会继续重试。
- 本包不强制迁移字幕翻译，但不复制另一套散落 axios 逻辑。

### BE-005：全局公平请求调度器

目标：避免多任务乘法并发。

实施范围：

- 全局默认上限 5。
- 并发任务默认单任务最多 3。
- 串行任务同时最多 1。
- 任务间轮转或等价公平策略。
- 取消等待、释放槽位和异常安全。

验收口径：

- 压力测试中并发峰值不超过限制。
- 大任务不会永久饿死后加入的小任务。
- 429 重试等待不长期占有执行槽位。
- task 取消后不再获得新槽位。

### BE-006：TXT 仅译文输出组装器

目标：从 unit 和可信 segment 结果生成正式 TXT。

实施范围：

- 段内硬切结果无额外空行拼接。
- 恢复自然段与保护文本。
- 输出 UTF-8 无 BOM。
- 输出命名、源目录/自定义目录、overwrite/index。
- 临时文件原子替换，默认永不覆盖源文件。

验收口径：

- 分片边界不出现在最终文件中。
- 同名冲突符合配置。
- 写入失败不留下正式半文件。
- 同名不同路径文件互不冲突。

### BE-007：单文件并发执行垂直切片

目标：关闭首个主进程端到端闭环。

实施范围：

- 任务创建、准备、并发执行、工作区增量写、进度事件和输出组装。
- 每片成功立即原子写 result 并追加事件。
- 失败分类与任务摘要。
- 实际 usage 累积。
- 主进程 registry 使用 `taskId` 管理 AbortController。

验收口径：

- 单个 TXT 可通过 Fake server 生成仅译文输出。
- 完成的 segment 不只存在内存。
- 进度含文件/segment 数量、active ids 和 token。
- Renderer IPC payload 不包含全文。

### FE-001：工具入口与页面骨架

目标：让工具稳定可访问。

实施范围：

- 新增文本工具分类、metadata、图标、路由和页面。
- 增加中英日繁 `text` namespace。
- 空状态、未配置任务模型状态和 Beta 提示。
- 不在本包堆入完整执行交互。

验收口径：

- 工具卡和路由可访问。
- 既有字幕/名称工具入口不受影响。
- i18n key 四语言一致。
- 页面在窄宽度和默认窗口尺寸可用。

### FE-002：单文件配置、准备与进度闭环

目标：把 BE-007 接到可使用的手动页面。

实施范围：

- 添加 `.txt` 文件、输出路径、语言、分片 token、并发数、仅译文配置。
- 调用准备并显示编码、大小、分片、费用预估。
- 启动、进度、完成、失败和输出路径。
- Store 只持久化偏好，不保存全文或完整 segment。

验收口径：

- 用户能完成单文件快速并发仅译文流程。
- 同名文件使用 taskId 隔离。
- 刷新/重新进入页面能从主进程查询运行任务摘要。
- 错误信息可定位阶段。

### REL-001：任务状态机、部分完成与生命周期控制

目标：完成并发任务的可靠状态语义。

实施范围：

- 状态转换守卫。
- 暂停、取消、失败、部分完成。
- 并发模式单片失败后继续其它独立片。
- 串行模式预留失败即停止语义。
- 文件完整后可先输出；项目后续失败不撤销。

验收口径：

- 非法状态转换被拒绝。
- 取消保留工作区。
- 并发部分失败最终为 `partially_completed` 或 `failed`，规则固定并测试。
- 暂停不会继续启动新请求。

### REL-002：恢复扫描、校验与继续执行

目标：应用重启后不重复翻译已完成内容。

实施范围：

- 扫描 task workspaces。
- 校验 schema、源 snapshots、result 和事件日志。
- 源文件 matched/changed/missing 状态。
- 源文件缺失时从冻结 source segments 继续。
- 恢复使用当前任务模型凭据。

验收口径：

- 已完成 segment 不再次请求模型。
- 损坏 result 不被当作完成。
- source changed/missing 有明确警告。
- 不从磁盘恢复 API Key。

### REL-003：恢复与错误管理 UI

目标：让用户可操作恢复能力。

实施范围：

- 可恢复任务列表。
- 继续、从头开始、删除工作区。
- 打开输出目录/工作区。
- 编码低置信度手动覆盖入口。
- 结构化错误详情和恢复阻塞原因。

验收口径：

- 用户可理解哪些任务可恢复。
- 删除需要确认且只删除目标 task workspace。
- 从头开始不会混用旧结果。
- 敏感正文默认不显示在错误日志。

### MEM-001：语义记忆模型、预算与快照

目标：建立串行执行的稳定状态基础。

实施范围：

- SemanticMemory、version 和 user/model terminology origin。
- 长期、章节/场景、近期三级上下文。
- 8192 默认上限和 effective budget。
- 优先级裁剪与安全边距。
- latest、文件边界、每 10 片和压缩前快照。

验收口径：

- 用户术语永不被模型覆盖。
- 超预算时按设计优先级裁剪。
- 快照原子写并可恢复。
- memoryVersion 单调递增。

### MEM-002：记忆 Patch 协议、合并与压缩

目标：把模型返回安全转化为新记忆。

实施范围：

- 落地 PRE-003 协议。
- patch schema 校验和冲突过滤。
- 本地合并。
- 90% 阈值压缩。
- 压缩失败保留旧稳定记忆并缩短近期窗口。

验收口径：

- 非法 patch 不污染 latest。
- 用户术语冲突产生 warning。
- 压缩前有快照。
- 压缩请求失败不丢失恢复能力。

### MEM-003：连贯串行 Executor 与恢复

目标：实现小说级顺序翻译。

实施范围：

- 文件内严格 segment 顺序。
- 每片输入 memoryVersion、输出新 version。
- 最近原文/译文窗口。
- 当前片失败后停止后续。
- 恢复从第一个未完成片及其对应稳定记忆继续。

验收口径：

- 并发峰值始终为 1。
- 后片不会在前片稳定提交前启动。
- 应用退出后恢复使用正确 memoryVersion。
- memory patch 降级行为符合 PRE-003 决策。

### MEM-004：中间重翻与后续 stale 契约

目标：避免用户重翻中间片后继续误用旧依赖链。

实施范围：

- 从指定 segment 重新翻译。
- 标记之后所有 segment stale。
- 从最近可用快照重建。
- UI 明确“后续将重新翻译”的影响范围。

验收口径：

- stale 结果不能进入最终正式输出。
- 不能只替换中间片后把旧后片标为有效。
- 取消重翻时原依赖链可保持不变。

### PROJ-001：有序多文件项目与跨文件记忆

目标：支持拆分为章节文件的小说。

实施范围：

- 冻结 file order。
- 全局 segment 顺序。
- 文件结束记忆快照。
- 指定文件前重置语义记忆。
- 每个文件独立生成输出并保持相对目录。

验收口径：

- 项目顺序不可在运行中静默改变。
- 人名/术语可跨文件持续。
- 重置点后使用新记忆链。
- 一个文件完成后可先生成正式输出。

### PROJ-002：项目排序与高级小说配置 UI

目标：让用户确认小说项目契约。

实施范围：

- 独立文件 / 有序项目切换。
- 文件名自然排序、拖拽排序和显式顺序确认。
- 记忆重置点。
- 文档背景、翻译要求、风格、术语表。
- 预计串行 token 费用区间。

验收口径：

- 项目启动前顺序清晰可见。
- 配置变更只影响未冻结任务。
- 术语编辑有基本校验。
- 串行额外费用提示明确。

### OUT-001：TXT 块级双语输出

目标：提供 TXT 双语对照。

实施范围：

- 简洁模式。
- `[Original]` / `[Translation]` 标签模式。
- 按自然 unit 输出，不按 segment 输出。
- 保留块间稳定空白。

验收口径：

- 原文与译文相邻。
- 超长段落被多 segment 翻译后仍只形成一个自然块。
- 空/保护 unit 不产生无意义译文标签。

### MD-001：Markdown Parser 与保护占位符

目标：把 Markdown 转换为安全 units。

实施范围：

- GFM、frontmatter、source positions。
- heading、paragraph、list item、blockquote、table。
- link label/image alt 可翻译，目标地址保护。
- code、inline code、URL、HTML、math、分隔线保护。
- 任务内唯一占位符和完整性校验。

验收口径：

- 保护内容不会发送为可翻译文本。
- 占位符缺失、重复、未知会触发重试/失败。
- 不完整重序列化 Markdown。
- 复杂结构有 fixture。

### MD-002：Markdown 仅译文输出

目标：在不重写全文件的前提下替换可翻译范围。

实施范围：

- 从后向前应用 replacement。
- 还原占位符。
- 保护节点和非翻译字符保持不变。
- 处理 link label、alt、列表和表格单元格。

验收口径：

- URL、代码、frontmatter、HTML 不变。
- 列表缩进和用户空白尽量保持。
- replacement 不发生 offset 漂移。
- 输出仍可被 Markdown 解析器解析。

### MD-003：Markdown 引用块双语输出

目标：实现用户确认的 Markdown 双语格式。

实施范围：

- 原始块后插入译文 blockquote。
- 标题不重复生成标题锚点。
- 列表内安全插入或脱离列表。
- 嵌套引用增加正确层级。
- 表格保留原表格，在后面追加包含译文表格的 blockquote。

验收口径：

- 原始块逐字保留。
- 译文不污染目录和列表编号。
- fixture 在应用渲染器中表现可接受。
- 无法安全插入的结构保留原样并 warning。

### FE-003：完整模式与高级配置 UI

目标：开放 Final Design 中的主要配置。

实施范围：

- 快速并发 / 连贯串行。
- 仅译文 / 双语。
- TXT 双语格式。
- 分片、语义记忆、模型上下文、输出预留和并发。
- 文档背景、风格、指令、术语表。
- 动态预算校验和说明。

验收口径：

- 默认值正确。
- 无效预算不能启动。
- 模式切换说明速度、质量和费用差异。
- 已冻结任务不被全局偏好静默修改。

### FE-004：批量独立文件任务与队列体验

目标：支持多个互不相关文本文件的批量翻译。

实施范围：

- 多选 TXT/MD。
- 独立文件分别创建 task。
- 文件/任务队列、等待、运行、完成和失败。
- 同名不同路径可同时存在。
- 全局公平调度状态可见。

验收口径：

- 多任务并发不突破主进程全局上限。
- 删除/取消按 taskId 生效。
- 一个任务失败不影响其它独立任务。
- Renderer 不保存全文。

### QA-001：核心自动化测试与 Fixture 收口

目标：形成不依赖真实网络的稳定回归套件。

实施范围：

- 汇总编码、TXT、Markdown、小说项目、恢复 workspace fixtures。
- Fake server 集成测试。
- IPC、状态机、调度、恢复、记忆和输出测试。
- 清理重复临时 spike，保留可维护 fixture。

验收口径：

- `test/text-translation` 和模块单测稳定通过。
- 测试不访问真实模型或公网。
- 关键失败路径有覆盖。
- 临时工作区测试结束后清理。

### QA-002：小说级性能与资源验收

目标：确认实现符合整本小说规模。

实施范围：

- 1/10/50 MB TXT 准备耗时和峰值内存。
- 大型 Markdown AST 资源。
- 数千 segment 工作区恢复。
- 单片完成写入量。
- Renderer IPC payload 大小。
- 多任务全局并发峰值。

验收口径：

- 给出实际软警告/硬限制。
- 每片完成写入量不随全文大小线性放大。
- Renderer 无全文 payload。
- 结果回填 Final Design 和 UI 限制文案。

### QA-003：跨平台手工验收与真实模型验证

目标：验证自动化测试无法完全覆盖的真实体验。

实施范围：

- macOS、Windows；Linux 若项目当前发布支持则纳入。
- OpenAI、DeepSeek 和至少一个自定义兼容端点。
- TXT/MD、主要编码、并发/串行、项目、恢复、取消、部分失败。
- 输出文件渲染和打开目录。
- 长时间任务防休眠是否需要复用现有能力。

验收口径：

- 手工验收记录包含版本、模型、文件规模和结果。
- 已知兼容性问题进入 fix 文档或发布说明。
- 不把真实用户小说正文提交到仓库。

### DOC-001：README、i18n、隐私与发布说明

目标：让功能可理解、可发布。

实施范围：

- README 功能、使用方式、两种模式和费用差异。
- CHANGELOG。
- 中英日繁文案。
- 文本发送到模型服务的隐私提示。
- Beta、Markdown 复杂结构和真实模型兼容说明。
- HomeAgent 后续备忘保持为非本期范围。

验收口径：

- i18n 检查通过。
- 文档链接指向 `docs/v0.2.10/text-translator/`。
- 文档与实际默认值一致。
- 不宣称尚未实现的能力。

### DOC-002：工作区清理与兼容策略收口

目标：完成长期运行后的数据生命周期。

实施范围：

- 成功、失败、取消任务清理策略。
- 用户删除与自动过期清理。
- schemaVersion 旧任务只读识别和可恢复判断。
- 无法迁移时导出已完成译文。
- 清理过程路径安全和失败报告。

验收口径：

- 默认保留期限与 PRE-004/用户文案一致。
- 不删除工作区之外文件。
- 旧 schema 不被静默删除。
- 清理失败可诊断且不影响应用启动。

实施状态：

- 已在 `TextTranslationWorkspaceRepository` 增加 `planWorkspaceCleanup` 与 `cleanupWorkspaces`。
- 成功任务默认 7 天后进入可删除计划；失败、取消和部分完成任务默认保留，30 天后进入人工复核。
- 缺失 `task.json`、不支持 `schemaVersion` 或无效 `updatedAt` 的工作区只进入 `review`，不会被自动删除。
- `cleanupWorkspaces` 只执行计划中 `delete` 的受控 task workspace，并复用 `deleteWorkspace` 的路径边界保护。
- 当前 UI 仍以用户显式删除任务为主，自动清理触发点保留给后续任务管理/设置页，避免 Beta 阶段静默删除用户敏感数据。

---

## 7. 依赖关系

主依赖链：

```text
PRE-001 ─┐
PRE-002 ─┼──> M0
PRE-003 ─┤
PRE-004 ─┘

M0
  -> CORE-001
  -> CORE-002
  -> BE-001
  -> BE-002
  -> BE-003
  -> BE-004
  -> BE-005
  -> BE-006
  -> BE-007
  -> FE-001
  -> FE-002
  -> M1

M1
  -> REL-001
  -> REL-002
  -> REL-003
  -> M2

M2
  -> MEM-001
  -> MEM-002
  -> MEM-003
  -> MEM-004
  -> PROJ-001
  -> PROJ-002
  -> M3

M1 + PRE-002
  -> OUT-001
  -> MD-001
  -> MD-002
  -> MD-003
  -> FE-003
  -> FE-004
  -> M4

M4
  -> QA-001
  -> QA-002
  -> QA-003
  -> DOC-001
  -> DOC-002
  -> M5
```

允许并行的分支：

- `FE-001` 可在 `CORE-001` 完成后与主进程基础并行。
- `BE-004` 与 `BE-002/BE-003` 可在 `CORE-001`、`PRE-003` 完成后并行。
- `BE-005` 可与 `BE-004` 并行。
- `OUT-001` 可在 TXT units/results 契约稳定后，与恢复工作并行。
- `MD-001` 可在 `PRE-002` 和 `CORE-001` 完成后提前实施，但 `MD-002/003` 应等待输出替换契约稳定。
- `QA-001` 应随工作包持续补测试，最终工作包负责收口而非一次补齐。

---

## 8. 不可违反的工程约束

来自 Final Design，所有工作包必须保持：

1. 长文本翻译是独立领域模块，不混用 `SubtitleTranslatorTask`。
2. 任务唯一标识是 `taskId`；同名文件不能冲突。
3. Renderer 不读取、持久化或通过 IPC 传递整本小说全文。
4. 分片计划在任务启动前冻结；恢复使用冻结 segment，不静默重新分片。
5. 串行模式的语义记忆必须持久化、版本化并可恢复。
6. 用户术语优先级最高，模型不得覆盖。
7. 中间重翻会使后续依赖结果 stale。
8. 工作区不保存 API Key、Authorization 或完整模型 profile。
9. 每个 segment 结果增量落盘；不能用单个大型 JSON 每片重写全文。
10. 正式输出原子写入；默认不覆盖源文件。
11. Markdown 不做全量 AST 重序列化。
12. Markdown 双语使用“原块 + 译文 blockquote”。
13. 代码、URL、frontmatter、HTML 等保护内容必须经过占位符完整性校验。
14. 全局调度限制“任务数 × 分片数”的乘法并发。
15. 串行模式严格顺序，当前片失败后不继续后片。
16. 源文件缺失时，允许使用冻结 source segments 恢复。
17. 日志不得默认记录完整正文或模型完整返回。
18. HomeAgent 不属于本期实现范围。
19. 归档目录重组属于用户改动，不在本功能工作包中处理。

---

## 9. 验证命令合同

### 9.1 每个工作包最低验证

优先运行与改动直接相关的测试：

```text
pnpm exec vitest run <相关测试文件>
pnpm exec tsc --noEmit
git diff --check
```

修改 i18n 时：

```text
pnpm run i18n:check
```

修改路由、页面或构建配置时：

```text
pnpm build
```

### 9.2 阶段回归

M1 后：

```text
pnpm exec vitest run test/text-translation electron/main/text-translation src/services/text src/store/tools/text
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
```

M3 后增加：

```text
pnpm exec vitest run test/text-translation/semantic-memory.test.ts test/text-translation/ordered-project.test.ts
```

M4 后增加：

```text
pnpm exec vitest run test/text-translation/markdown
```

发布候选：

```text
pnpm test
pnpm exec tsc --noEmit
pnpm run i18n:check
pnpm build
git diff --check
```

### 9.3 前端服务约束

如某工作包启动 `pnpm dev`、`vite`、`vite preview` 或其它前端服务：

1. 实施记录中写明启动命令和端口。
2. 验证结束后必须终止本会话启动的所有相关进程。
3. 最终回复前再次确认没有遗留前端服务。

---

## 10. 实施记录模板

每个实现会话在以下目录新增记录：

```text
docs/v0.2.10/text-translator/long_text_translator_implementation_records/
```

文件名：

```text
YYYY-MM-DD_<work-package-id>_<short-title>.md
```

模板：

````markdown
# 工作包 <ID>：<标题>

## 基本信息

- 日期：
- 状态：已完成 / 部分完成 / 阻塞
- 对应执行计划工作包：

## 本次实现内容

-

## 修改文件

-

## 接口或数据结构变化

-

## 验证结果

执行命令：

```text

```

结果：

-

## 未完成事项

-

## 下一步建议

-
````

如果一个会话实现多个强耦合工作包，可以共用一份记录，但第 5 节台账必须逐项更新。

---

## 11. Feat / Fix 文档规则

验收后出现需求新增或行为调整时，使用：

```text
docs/v0.2.10/text-translator/feat/
  YYYY-MM-DD_long_text_translator_<short-title>.md

docs/v0.2.10/text-translator/fix/
  YYYY-MM-DD_long_text_translator_<short-title>.md
```

如果 Feat/Fix 改变原始契约：

1. 更新 Final Design。
2. 更新本执行计划台账和工作包。
3. 再实施代码。

---

## 12. 当前推荐下一步

下一次实现会话优先认领：

```text
QA-001：核心自动化测试与 Fixture 收口
```

原因：

1. BE-007 已完成，单 TXT、parallel、target-only 主进程闭环已通过 fake server 验证，包含准备、分片、请求、结果落盘、事件日志、输出组装和 API Key 不持久化。
2. FE-001/FE-002 已完成工具入口、路由、四语言 `text` namespace、单 TXT 文件选择、配置、prepare/start、进度事件、输出/工作区打开和任务模型缺失状态。
3. REL-001 至 REL-003 已完成非法状态转换拒绝、暂停/取消、部分完成、工作区扫描、source 状态摘要、resume/restart/delete 和恢复 UI。
4. MEM-001 已完成 `SemanticMemory` 基础结构、默认/effective budget 解析、用户术语和显式风格规则保护、优先级裁剪、latest/snapshot 原子写入读取和 memoryVersion 单调递增。
5. MEM-002 已完成受限 `SemanticMemoryPatch` schema、非法 patch 不写 latest、用户术语冲突 warning、本地合并、90% 阈值压缩前快照、压缩成功提交和压缩失败保持 stable latest 的回退边界。
6. MEM-003 已完成单 TXT `sequential_context` 执行分支、动态边界响应解析、每片输入/输出 memoryVersion 事件、后片等待前片结果和记忆提交、当前片失败后停止后续，以及新 service 恢复时接续 event sequence 和 latest memory 的断点恢复。
7. MEM-004 已完成 `retranslateFromSegment` IPC/service 契约、目标片及后续 `segment_stale` 标记、event replay 剔除 stale result、从目标片前 snapshot 恢复 memory、重跑失败保持 stale、重跑完成后清空 stale 链，以及恢复弹窗的 staleFromSegmentId 影响提示。
8. PROJ-001 已支持 ordered_project 多 TXT 创建/准备、冻结 order、跨文件 global segment 顺序、串行跨文件共享 memory、文件结束 memory snapshot、指定 fileId/order 前重置 memory、每个文件独立输出并在 custom 输出目录下保留 relativePath 子目录。
9. PROJ-002 已把多 TXT 选择、自然排序、上/下移动顺序确认、parallel/sequential 与 independent/ordered 切换、语义记忆 token、背景/翻译要求/风格、术语表文本、重置文件序号和串行费用提示接入 Renderer。
10. OUT-001 已完成 TXT 仅译文/双语对照输出模式、简洁/标签格式、自然块级拼装、Renderer 配置、IPC 校验和输出写盘接入。
11. MD-001 已完成正式 Markdown parser、GFM/frontmatter/source offset 解析、link/image 目标保护、图片 alt 定位、占位符替换/校验/恢复和 parser 单测。
12. MD-002 已完成 Markdown 仅译文输出组装、unit source range 从后向前替换、占位符恢复、link label/image alt/列表/表格单元格替换和 Markdown 可重解析验证。
13. MD-003 已完成 Markdown 双语 blockquote 输出组装，覆盖标题、段落、列表、嵌套引用和表格整体译文引用块，并复用 PRE-002 fixture 做精确输出比对。
14. FE-003 已完成 Renderer 模式说明和动态上下文预算校验，页面可见并发/串行、输出内容、TXT 双语格式、分片/记忆/上下文/输出预留、背景/指令/风格和术语表配置。
15. FE-004 已完成批量 independent_files 准备流程、多个单文件 task 创建/准备/启动、队列状态可视化和 progress/taskUpdated 事件回填。
16. DOC-001 已更新 README 和 CHANGELOG，说明长文本翻译 Beta 范围、隐私边界、费用提示、Markdown 限制和当前未开放能力。
17. DOC-002 已完成工作区清理计划/执行 API、7 天成功任务保留、30 天非成功人工复核、旧 schema 只读复核和缺失/无效 metadata 保护。
18. 所有非测试工作包已完成；剩余 `QA-001` 至 `QA-003` 为测试、性能和真实环境验收收口。

DOC-002 完成后进入 `QA-001：核心自动化测试与 Fixture 收口`。
