# 实施记录：T-STRUCTURE-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-STRUCTURE-01 |
| 日期 | 2026-10-11 |
| 验证版本 | f869d2e + 本会话未提交改动（studio-cue-structure 工作树） |
| 环境 | Windows 11，Node 20.19.4（vitest 2.1.9），Electron（Playwright 1.58.2） |
| 任务指纹 | 2d8b55f47666139acb1213eb2bd1873567906ef8c9fe74d903d9a7d89dcb683d |

## 实际结果

- 编辑契约新增 `timing`（多条开始/结束，撤销为旧值）、`merge`（连续 2–50 条并为第一条：首开始、末结束，原文/译文按规则，撤销为一层 batch）与 `batch`（一个事务内依次应用，撤销逆序展开）；服务内部按需重建字幕位置索引。
- `cue-structure.ts`：`mergeTexts`（重复、互含 ≥50%、重新起句视为重复；CJK 直接相连，其余空格）、`mergeOperation`、`mergedTiming`、`consecutive`、`parseStudioTime`。
- 转写文档：`timingRevision > 1` 的字幕只要求在媒体时长内；合并保留第一条的片段。导出：任一字幕改过时间时同格式 VTT/ASS/SSA 改为重新生成。
- 用户样本中的重复合并后为 00:00:26.780 开始、原文「先輩みたいに朝から眠そうにしてる方、」、译文「像前辈这样一大早就犯困的，」，导出双语 LRC 只出现一次；撤销后字幕、条目、节点、双语标记全部恢复。
- 来源审计测试中“转写字幕 timingRevision=2 无效”的断言随 R-STRUCTURE-03 改为有效（仍判为与生产者输出不一致）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-STRUCTURE-01-1 | 通过 | file:records/structure-01-unit.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-STRUCTURE-01-1 | 通过 | V-STRUCTURE-01-1 |
| AC-STRUCTURE-01-2 | 通过 | V-STRUCTURE-01-1 |
| AC-STRUCTURE-01-3 | 通过 | V-STRUCTURE-01-1 |
| AC-STRUCTURE-01-4 | 通过 | V-STRUCTURE-01-1 |
| AC-STRUCTURE-02-3 | 通过 | V-STRUCTURE-01-1 |
| AC-STRUCTURE-03-1 | 通过 | V-STRUCTURE-01-1 |
| AC-STRUCTURE-03-2 | 通过 | V-STRUCTURE-01-1 |
| AC-STRUCTURE-03-3 | 通过 | V-STRUCTURE-01-1 |

## 风险与未执行项

拆分、插入、调整顺序不在范围。
