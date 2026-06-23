# RV-005 实施记录：快路径独立单元测试

> 日期：2026-06-22
> 对应执行计划：`docs/batch-name-translation-tool/2026-06-22_perf-optimization-review-fixes_execution_plan.md`

## 变更文件

| 文件 | 操作 |
| --- | --- |
| `src/services/rename/nameTranslationFastPath.test.ts` | 新增 |

## 实施内容

### 新增测试文件

为 `nameTranslationFastPath.ts` 创建独立单元测试，覆盖以下分类（共 76 个测试用例）：

| 分类 | 正例数 | 反例数 | 说明 |
| --- | --- | --- | --- |
| empty | 3 | — | 空字符串、纯空格、制表符 |
| no_natural_language | 8 | 5 | 纯符号（无字母和数字）的字符串 |
| numeric | 7+7 | 4 | 纯数字及分隔符序列，含 date-like 字符串 |
| date | 5+2 | — | 文档化：DATE_PATTERN 被 NUMERIC_PATTERN 覆盖，不可达 |
| episode_code | 12 | 6 | S01E02、Episode.12、ep_001 等季集编号格式 |
| technical_only | 10 | 3+2 | 技术标记（1080p、x264 等），含 preserveTechnicalTokens=false 场景 |
| priority order | 4 | — | 验证检查顺序（empty > symbol > numeric > date > episode > technical） |
| return value | 3 | — | 返回结构正确性、需翻译 stem 返回 null |

### 发现：DATE_PATTERN 不可达

测试中确认 `DATE_PATTERN` 匹配的所有字符串同样被 `NUMERIC_PATTERN` 匹配（两者结构均为数字+分隔符序列）。由于 `getFastPathReason()` 中 numeric 检查在 date 之前执行，`"date"` 原因实际不可达。

测试中通过专门的 `"date (subsumed by numeric)"` describe block 文档化此行为，验证 date-like 字符串（如 `"2024-01-01"`）正确返回 `fast_path:numeric`。

## 验证

```
pnpm exec vitest run src/services/rename/nameTranslationFastPath.test.ts
# 76 tests passed
```
