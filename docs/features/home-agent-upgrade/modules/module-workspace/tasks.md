# 工作台任务

### T-WORKSPACE-01 计划、精确队列与会话

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-01 |
| 验收 | AC-WORKSPACE-01-1, AC-WORKSPACE-01-2, AC-WORKSPACE-01-3 |
| 依赖 | - |
| 写集 | src/agent/types.ts, src/agent/plan.ts, src/agent/plan.test.ts, src/agent/planning-tools.ts, src/agent/tools.ts, src/agent/tool-executor.ts, src/agent/tool-executor-translation.test.ts, src/agent/tool-executor-scope.test.ts, src/agent/name-plan-confirmation.ts, src/agent/name-plan-confirmation.test.ts, src/agent/session-io.ts, src/agent/session-schema.ts, src/agent/session-schema.test.ts, src/store/agent/ |
| 负责人 | root |
| 依赖确认 | 基线aab39c9a共享工作树，按总体设计契约集成 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/T-WORKSPACE-01.md |
| 集成版本 | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |

#### 实现要点
按总体设计建立计划、明确任务范围、统一重命名claim、校验导入；先落实公共类型。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/agent src/store/agent | - |
| V-WORKSPACE-01-2 | static | required | node node_modules/typescript/bin/tsc --noEmit | - |

### T-WORKSPACE-02 计划与能力UI

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-WORKSPACE-01 |
| 验收 | AC-WORKSPACE-01-1, AC-WORKSPACE-01-2, AC-WORKSPACE-01-4 |
| 依赖 | - |
| 写集 | src/pages/HomeAgent/, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json, scripts/home-agent-qa.mjs |
| 负责人 | audit_ui |
| 依赖确认 | 基线aab39c9a共享工作树；按总体设计plan/actions契约消费，root最终集成 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/T-WORKSPACE-02.md |
| 集成版本 | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |

#### 实现要点
先按本模块design进行UI设计审查，再实现独立计划/能力/动作组件；修正调用状态映射，补四语言；隔离Electron自检与修复。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-02-1 | static | required | node scripts/check-i18n.mjs 与 node scripts/check-i18n-usage.mjs | - |
| V-WORKSPACE-02-2 | browser | required | 隔离Electron首页1280x860/786x660浅深色及四语言，长计划/阻塞/待确认/能力目录，截图审查和键盘交互并清理进程 | - |
| V-WORKSPACE-02-3 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/HomeAgent/widget-actions.test.ts；历史/模型卡片不授予确认权，当前真实卡片绑定会话及动作身份 | - |
