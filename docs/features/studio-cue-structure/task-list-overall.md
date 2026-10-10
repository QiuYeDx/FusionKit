<!-- spec-driven-ai-coding:generated:v2; DO NOT EDIT -->
# studio-cue-structure 任务总览

由各模块 tasks.md 生成；它不是第二份任务状态来源。

规模：L；风险：medium；当前批次：I3。

| 任务 | 模块 | 标题 | 状态 | 批次 | 需求 | 依赖 | 负责人 | 实施记录 | 集成版本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-IMPORT-01 | IMPORT | 导入时识别与恢复原样（主进程与契约） | 已完成 | I1 | R-IMPORT-01, R-IMPORT-02 | - | Claude（当前会话） | records/T-IMPORT-01.md | f869d2e + 未提交工作树（studio-cue-structure） |
| T-IMPORT-02 | IMPORT | 识别提示与「按原样导入」 | 已完成 | I1 | R-IMPORT-01, R-IMPORT-02 | T-IMPORT-01 | Claude（当前会话） | records/T-IMPORT-02.md | f869d2e + 未提交工作树（studio-cue-structure） |
| T-REVISION-01 | REVISION | 相邻重复检测与结构提案预览 | 已完成 | I3 | R-REVISION-01 | T-STRUCTURE-01 | Claude（当前会话） | records/T-REVISION-01.md | f869d2e + 未提交工作树（studio-cue-structure） |
| T-REVISION-02 | REVISION | AI 修订的合并与删除 | 已完成 | I3 | R-REVISION-02 | T-REVISION-01 | Claude（当前会话） | records/T-REVISION-02.md | f869d2e + 未提交工作树（studio-cue-structure） |
| T-REVISION-03 | REVISION | Agent 准备结构修复 | 已完成 | I3 | R-REVISION-03 | T-REVISION-02 | Claude（当前会话） | records/T-REVISION-03.md | f869d2e + 未提交工作树（studio-cue-structure） |
| T-STRUCTURE-01 | STRUCTURE | 结构编辑操作、校验与导出 | 已完成 | I2 | R-STRUCTURE-01, R-STRUCTURE-02, R-STRUCTURE-03 | - | Claude（当前会话） | records/T-STRUCTURE-01.md | f869d2e + 未提交工作树（studio-cue-structure） |
| T-STRUCTURE-02 | STRUCTURE | 合并、时间编辑与平移的界面 | 已完成 | I2 | R-STRUCTURE-01, R-STRUCTURE-02, R-STRUCTURE-03 | T-STRUCTURE-01 | Claude（当前会话） | records/T-STRUCTURE-02.md | f869d2e + 未提交工作树（studio-cue-structure） |

## 批次与批准

| 批次 | 名称 | 状态 | 范围批准 | 整体验收 |
| --- | --- | --- | --- | --- |
| I1 | 双语字幕导入即识别 | verifying | delegated | pending |
| I2 | 合并相邻字幕与调整时间 | verifying | delegated | pending |
| I3 | 重复检测、AI 修订与 Agent 结构修复 | verifying | delegated | pending |
