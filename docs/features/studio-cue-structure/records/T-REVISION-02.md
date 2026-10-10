# 实施记录：T-REVISION-02

| 字段 | 值 |
| --- | --- |
| 任务 | T-REVISION-02 |
| 日期 | 2026-10-11 |
| 验证版本 | f869d2e + 本会话未提交改动（studio-cue-structure 工作树） |
| 环境 | Windows 11，Node 20.19.4（vitest 2.1.9），Electron（Playwright 1.58.2） |
| 任务指纹 | 5f23bd616ae80619ddd06f3e52d26ca74179aef696c84db9aa06f380633bed9d |

## 实际结果

- 提示词：默认每条保持为一条、时间由应用负责；仅当请求涉及重复识别、断句或噪声行时可返回 `merge`（相邻 id、合并后的原文/译文）与 `delete`。
- 解析：未知、不相邻、重复使用、超过 20 处的建议与不能保存的文字计入“未采用”；被合并或删除的条目不再单独改字。服务按文档取时间与当前文字生成结构提案，删除会清空文档时丢弃全部删除建议。
- Electron：脚本模型返回合并与删除，预览分两行显示，应用后条数与文字正确，撤销恢复。截图已审阅：screenshots/studio-cue-structure-revision--02。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-REVISION-02-1 | 通过 | file:records/revision-02-unit.log |
| V-REVISION-02-2 | 通过 | file:records/final-electron.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-REVISION-02-1 | 通过 | V-REVISION-02-1, V-REVISION-02-2 |
| AC-REVISION-02-2 | 通过 | V-REVISION-02-1 |
| AC-REVISION-02-3 | 通过 | V-REVISION-02-1 |

## 风险与未执行项

真实模型何时提出合并/删除取决于模型，需用户试用；跨块（40 条）边界的相邻条目不能由模型合并（相邻重复检查不受此限）。
