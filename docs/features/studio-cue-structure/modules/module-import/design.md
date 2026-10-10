# import 设计

## 现状与约束

- 所有导入入口（打开文件、拖入、Agent 按路径导入）都经过 `electron/main/subtitle-studio/index.ts` 的 `importSelections` → `readSubtitleWithSource` → `repository.create`。
- 双语识别：`src/subtitle-studio/bilingual.ts` 的 `isBilingualRecommended`（≥3 对且 ≥80% 为无需核对、语言顺序一致的配对）与 `applyBilingual(doc, options, newId, sourceDigest)`；`bilingual-service.ts` 的 `assertUninterpreted` 要求无任务、无译文轨道、无编辑。
- 语言判断 `language()`：含假名 → ja，含谚文 → ko，含汉字 → zh，否则 en/und。用户样本中有 2 行只有汉字的日文被判为 zh，属于“建议核对”，仍会配对。
- 渲染端 `StudioBilingual.tsx` 仅在单文件导入后自动打开对话框；`summarizeDocument` 提供 `bilingualAvailable`/`bilingualRecommended`。

## 方案与取舍

### 导入时识别（主进程）

- 新函数 `interpretBilingualImport(doc)`（`src/subtitle-studio/bilingual.ts`）：`schemaVersion === 1 && capabilities.translate && isBilingualRecommended(doc)` 时，用 `analyzeBilingual(doc, { sourceSide: 'first', splitInline: false, overrides: [] })` 得到首/次语言；若恰有一侧为 `zh`，该侧为译文（`sourceSide` 取另一侧），否则 `first`；再 `applyBilingual`。任何异常返回原文档。
- `importSelections` 在 `repository.create` 之前调用；`summarizeDocument` 已带 `bilingualImport`，结果项据此显示。
- 取舍：不再弹对话框确认——推荐阈值本身较严（≥80% 无需核对），且提供一键恢复；对话框仍可用于不明显的文件。

### 恢复原样导入

- `BilingualService.revert(documentId, revision)`：在事务中检查“识别后未编辑”：无任务；`bilingualImport` 存在；所有字幕 `sourceRevision === 1 && timingRevision === 1`；无 `removedNodeIds`；只有一条 `origin: imported` 轨道，且其条目全部 `origin: imported`、未审阅、`sourceRevision === 1`。满足则以 `importSubtitleText(preservation.rawText, origin, randomUUID, bom)` 重建文档，保留原 `id`，其余不满足返回 `revision_conflict`。
- 新 IPC `revertBilingual { documentId, revision }`（`ipc-contract.ts`、preload `subtitle-studio-api.ts`、channel-policy、`index.ts` 处理器），返回新的摘要。
- `summarizeDocument` 增加 `bilingualRevertible?: boolean`（同上判定，纯函数 `canRevertBilingual`）。

### UI

- 参照：文档标题区已有的格式/编码/「仅原文」标签行（`StudioDocumentHeader` 区域）与 `cueNotice` 提示条。
- 导入后：标签行显示「双语 · 日语 → 中文」；刚导入的文档在字幕区上方显示一条提示（与删除提示同样式）：「已识别为双语字幕（日语 → 中文），共 N 条：前者作为原文，后者作为译文。」+「按原样导入」+ 关闭。多文件导入的结果详情为该文件注明「已识别为双语：日语 → 中文」。
  - 取舍：需核对的配对在拆分后无法在对话框中逐条预览；提示只给方向与条数和「按原样导入」，避免引入新视图。需核对的 2 对在样本中实际正确。
  - 语言名：识别只区分中文与其他语言，不区分简繁，标签用「中文」而非译文语言列表中的「简体中文」。
- 「按原样导入」位于提示条与文档菜单（标题区按钮组旁的「双语」按钮在已识别时变为恢复入口）；不可用时禁用并在悬停说明原因。
- 窄屏：提示条换行，按钮右对齐；文案四语言。

## 实施中确定（2026-10-11）

- 原「单文件导入后自动打开双语整理」路径不再可能触发（推荐的文件在导入时已拆分），删除 `autoOpen` 与 `importedId`；对话框只用于未自动拆分的文件，测试 `bilingual-ui`、`export-ui` 相应改为先「按原样导入」再手动整理、或直接断言已拆分。
- 结果详情（`StudioOperationResult`）新增 `note`，成功项也可显示（原 `detail` 只在失败/跳过时显示）。
- 标题区按钮：已识别且可恢复时显示「按原样导入」按钮（`Columns2`），打开确认对话框；提示条上的同名按钮直接执行。

## 代码落点

- `src/subtitle-studio/bilingual.ts`（`interpretBilingualImport`、`canRevertBilingual`）
- `electron/main/subtitle-studio/index.ts`（导入时调用、`revertBilingual` 处理器）、`electron/main/subtitle-studio/bilingual-service.ts`（`revert`）
- `src/subtitle-studio/ipc-contract.ts`、`electron/preload/subtitle-studio-api.ts`、`electron/preload/subtitle-studio-channel-policy.ts`
- `src/pages/Tools/Subtitle/SubtitleStudio/StudioBilingual.tsx`、`index.tsx`（提示条）
- `src/locales/{zh,en,ja,zh-Hant}/studio.json`
- 测试：`test/subtitle-studio/bilingual-import.test.ts`（新）、`test/subtitle-studio/bilingual-import-ui.test.ts`（Electron，新）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-IMPORT-01 | `interpretBilingualImport`、`importSelections` 调用、标签与提示条 |
| R-IMPORT-02 | `canRevertBilingual`、`BilingualService.revert`、`revertBilingual` IPC、提示条与按钮 |

## 验证与风险

- 单元：用户样本结构（151×2 行，含 2 行纯汉字日文）、中文在前样本、单语与低比例样本、带编辑后的恢复拒绝；`importSelections` 经 IPC 测试覆盖多文件。
- Electron：页面多文件导入双语 + 单语文件，截图标签与提示条；「按原样导入」后 302 条原文；浅色 1280×860 与深色 786×660。
- 风险：语言判断对纯汉字日文行的误判只影响“建议核对”计数；中文侧判定对中英、中韩同样适用，日英等无中文的组合取第一行为原文。
