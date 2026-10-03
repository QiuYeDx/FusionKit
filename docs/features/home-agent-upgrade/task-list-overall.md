<!-- spec-driven-ai-coding:generated:v2; DO NOT EDIT -->
# home-agent-upgrade 任务总览

由各模块 tasks.md 生成；它不是第二份任务状态来源。

规模：L；风险：medium；当前批次：I1。

| 任务 | 模块 | 标题 | 状态 | 批次 | 需求 | 依赖 | 负责人 | 实施记录 | 集成版本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-RUNTIME-01 | RUNTIME | 建立可取消隔离的运行循环与完整工具历史 | 已完成 | I1 | R-RUNTIME-01 | - | audit_runtime | records/T-RUNTIME-01.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |
| T-TOOLS-01 | TOOLS | 实现正式能力目录与会话绑定准备执行 | 已完成 | I1 | R-TOOLS-01 | - | audit_tools | records/T-TOOLS-01.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |
| T-WORKSPACE-01 | WORKSPACE | 计划、精确队列与会话 | 已完成 | I1 | R-WORKSPACE-01 | - | root | records/T-WORKSPACE-01.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |
| T-WORKSPACE-02 | WORKSPACE | 计划与能力UI | 已完成 | I1 | R-WORKSPACE-01 | - | audit_ui | records/T-WORKSPACE-02.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |

## 批次与批准

| 批次 | 名称 | 状态 | 范围批准 | 整体验收 |
| --- | --- | --- | --- | --- |
| I1 | HomeAgent 可靠规划与正式工具升级 | verifying | delegated | pending |
