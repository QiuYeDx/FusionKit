<!-- spec-driven-ai-coding:generated:v2; DO NOT EDIT -->
# home-agent-upgrade 任务总览

由各模块 tasks.md 生成；它不是第二份任务状态来源。

规模：L；风险：medium；当前批次：I4。

| 任务 | 模块 | 标题 | 状态 | 批次 | 需求 | 依赖 | 负责人 | 实施记录 | 集成版本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-RUNTIME-01 | RUNTIME | 建立可取消隔离的运行循环与完整工具历史 | 已完成 | I1 | R-RUNTIME-01 | - | audit_runtime | records/T-RUNTIME-01.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |
| T-RUNTIME-02 | RUNTIME | 修复停止、确认上下文与归档协议 | 已完成 | I2 | R-RUNTIME-02 | - | audit_runtime | records/i2/T-RUNTIME-02.md | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |
| T-RUNTIME-03 | RUNTIME | 页面上下文注册表与每轮注入 | 已完成 | I3 | R-RUNTIME-03 | - | root | records/i3/T-RUNTIME-03.md | df64e8f + 本会话未提交改动 |
| T-RUNTIME-04 | RUNTIME | Agent 页面导航工具 | 已完成 | I4 | R-RUNTIME-04 | - | root | records/i4/T-RUNTIME-04.md | df64e8f + 本会话未提交改动 |
| T-TOOLS-01 | TOOLS | 实现正式能力目录与会话绑定准备执行 | 已完成 | I1 | R-TOOLS-01 | - | audit_tools | records/T-TOOLS-01.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |
| T-TOOLS-02 | TOOLS | 保留批量回执并校验准确转写范围 | 已完成 | I2 | R-TOOLS-02 | - | audit_tools | records/i2/T-TOOLS-02.md | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |
| T-TOOLS-03 | TOOLS | 字幕工作台页面上下文与修订工具 | 已完成 | I3 | R-TOOLS-03 | T-RUNTIME-03 | root | records/i3/T-TOOLS-03.md | df64e8f + 本会话未提交改动 |
| T-TOOLS-04 | TOOLS | 经典工具页面上下文 | 已完成 | I4 | R-TOOLS-04 | T-TOOLS-05 | root | records/i4/T-TOOLS-04.md | df64e8f + 本会话未提交改动 |
| T-TOOLS-05 | TOOLS | 未指定设置跟随工具页 | 已完成 | I4 | R-TOOLS-05 | - | audit_runtime | records/i4/T-TOOLS-05.md | df64e8f + 本会话未提交改动 |
| T-WORKSPACE-01 | WORKSPACE | 计划、精确队列与会话 | 已完成 | I1 | R-WORKSPACE-01 | - | root | records/T-WORKSPACE-01.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |
| T-WORKSPACE-02 | WORKSPACE | 计划与能力UI | 已完成 | I1 | R-WORKSPACE-01 | - | audit_ui | records/T-WORKSPACE-02.md | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |
| T-WORKSPACE-03 | WORKSPACE | 完善状态、恢复入口及键盘日志体验 | 已完成 | I2 | R-WORKSPACE-02 | - | audit_ui | records/i2/T-WORKSPACE-03.md | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |
| T-WORKSPACE-04 | WORKSPACE | 集成复验真实用户流程 | 已完成 | I2 | R-WORKSPACE-02 | T-RUNTIME-02, T-TOOLS-02, T-WORKSPACE-03 | root | records/i2/T-WORKSPACE-04.md | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |
| T-WORKSPACE-05 | WORKSPACE | 全局悬浮 Agent 面板 | 已完成 | I3 | R-WORKSPACE-03 | T-RUNTIME-03 | root | records/i3/T-WORKSPACE-05.md | df64e8f + 本会话未提交改动 |
| T-WORKSPACE-06 | WORKSPACE | 集成验收：悬浮面板与工作台修订链路 | 已完成 | I3 | R-WORKSPACE-03, R-RUNTIME-03, R-TOOLS-03 | T-RUNTIME-03, T-TOOLS-03, T-WORKSPACE-05 | root | records/i3/T-WORKSPACE-06.md | df64e8f + 本会话未提交改动 |
| T-WORKSPACE-07 | WORKSPACE | 首页与悬浮面板的连贯过渡 | 已完成 | I4 | R-WORKSPACE-04 | T-RUNTIME-04 | root | records/i4/T-WORKSPACE-07.md | df64e8f + 本会话未提交改动 |
| T-WORKSPACE-08 | WORKSPACE | 集成验收：经典页面、设置跟随、导航与过渡 | 已完成 | I4 | R-WORKSPACE-04, R-TOOLS-04, R-TOOLS-05, R-RUNTIME-04 | T-RUNTIME-04, T-TOOLS-04, T-TOOLS-05, T-WORKSPACE-07 | root | records/i4/T-WORKSPACE-08.md | df64e8f + 本会话未提交改动 |

## 批次与批准

| 批次 | 名称 | 状态 | 范围批准 | 整体验收 |
| --- | --- | --- | --- | --- |
| I4 | 经典页面上下文、设置跟随、页面导航与连贯过渡 | verifying | delegated | pending |
| I3 | 全局悬浮 Agent 与页面上下文 | verifying | delegated | pending |
| I2 | 真实流程复审与确认结果闭环 | verifying | delegated | pending |
| I1 | HomeAgent 可靠规划与正式工具升级 | verifying | delegated | pending |
