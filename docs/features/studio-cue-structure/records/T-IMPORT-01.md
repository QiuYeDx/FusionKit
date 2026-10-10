# 实施记录：T-IMPORT-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-IMPORT-01 |
| 日期 | 2026-10-11 |
| 验证版本 | f869d2e + 本会话未提交改动（studio-cue-structure 工作树） |
| 环境 | Windows 11，Node 20.19.4（vitest 2.1.9），Electron（Playwright 1.58.2） |
| 任务指纹 | 5c28a1e7364e682f2e3d7a049953ad5a4524e19557c9a43ef6afda4969c654f5 |

## 实际结果

- `interpretBilingualImport`：导入时对推荐的文本字幕直接按现有 `applyBilingual` 拆分；两种语言恰有一种为中文时中文一侧为译文，否则第一行一侧为原文；异常时原样导入。所有入口（打开、拖入、Agent 按路径导入）都经 `importSelections`。
- 对用户原文件的实测（只读）：151 个时间戳全部配对（日 → 中，2 对建议核对），推荐成立。
- `canRevertBilingual` 与 `BilingualService.revert`：识别后未编辑（配对字幕第 2 版原文、其余第 1 版、未改时间、无删除、仅一条未改动的导入轨道）时，用原始文本重建单语文档；新 IPC `revertBilingual`（契约、preload、渠道策略、主进程处理器）；摘要新增 `bilingualRevertible`。
- `electron/main/subtitle-studio/index.ts` 组合变更已按项目流程在 `current-integration-audits.v1.json` 记录审阅（LF）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-IMPORT-01-1 | 通过 | file:records/import-01-unit.log |
| V-IMPORT-01-2 | 通过 | file:records/import-01-provenance.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-IMPORT-01-1 | 通过 | V-IMPORT-01-1 |
| AC-IMPORT-01-2 | 通过 | V-IMPORT-01-1 |
| AC-IMPORT-01-3 | 通过 | V-IMPORT-01-1 |
| AC-IMPORT-01-4 | 通过 | V-IMPORT-01-1 |
| AC-IMPORT-02-2 | 通过 | V-IMPORT-01-1 |

## 风险与未执行项

语言判断沿用 `bilingual.ts`：只用汉字书写的日文行判为中文，仅影响“建议核对”计数。已编辑文档的事后识别不在本次范围。
