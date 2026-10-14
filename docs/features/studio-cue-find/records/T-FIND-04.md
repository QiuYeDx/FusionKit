# 实施记录：T-FIND-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-FIND-04 |
| 日期 | 2026-10-14 |
| 验证版本 | snapshot-sha256:c132f5c0fb9f7a51de9c4e8307407ba24c7f8b8719d6576fce1b550a38d9f86c（基线 c0a9dcd + 未提交工作树） |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet），MCP 官方 SDK 客户端（external-agent 测试），临时用户数据与临时目录，无网络服务 |
| 任务指纹 | 9e73da853266cfe791aab7828cb289850d2229f26ead915ecae33d5c65f96a98 |

## 实际结果

`cue-find-query.ts`（无依赖）提供共享的查找词规则、选项与自包含匹配函数 `matchCueText`（字面 / 正则、区分大小写、全词：拉丁等文字检查两端词边界，汉字 / 假名 / 泰文端不检查，用 Script_Extensions 覆盖长音符 ー）与替换展开 `expandCueReplacement`（$1…$99、$<名称>、$&、$$）。`cue-find.ts` 的查找与替换改用它；`searchCues` 与 `replace` 增加可选 `wholeWord` / `regex`。正则在一次性 worker 线程中执行（`cue-find-worker.ts`，源码由 `matchCueText.toString()` 生成），3 秒未完成即终止并返回 `pattern_too_slow`；无效表达式返回新错误码 `invalid_pattern`。替换的正则匹配在事务前于 worker 中求得，事务内只按匹配展开。组合审计已更新。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-FIND-04-1 | 通过 | file:records/i2-unit.log |
| V-FIND-04-2 | 通过 | file:records/i2-interface.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-FIND-04-1 | 通过 | V-FIND-04-1 |
| AC-FIND-04-2 | 通过 | V-FIND-04-1 |
| AC-FIND-04-3 | 通过 | V-FIND-04-1 |
| AC-FIND-04-4 | 通过 | V-FIND-04-1 |

## 风险与未执行项

正则的 i 标志与字面模式的 toLocaleLowerCase 在少数字符上不同（以正则语义为准）。worker 每次查找新建，耗时约数十毫秒。
