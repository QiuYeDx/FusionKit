# 工作台任务

### T-WORKSPACE-03 完善状态、恢复入口及键盘日志体验

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-WORKSPACE-02 |
| 验收 | AC-WORKSPACE-02-1, AC-WORKSPACE-02-2, AC-WORKSPACE-02-3, AC-WORKSPACE-02-4 |
| 依赖 | - |
| 写集 | src/pages/HomeAgent/, src/locales/zh/home.json, src/locales/en/home.json, src/locales/ja/home.json, src/locales/zh-Hant/home.json, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/pages/Tools/Subtitle/SubtitleStudio/navigation.ts, src/pages/Tools/Subtitle/SubtitleStudio/navigation.test.ts |
| 负责人 | audit_ui |
| 依赖确认 | 同一161b109基线，准备回执与导出结果契约已对齐；QA脚本root单写，UI实现不触及执行门禁 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/i2/T-WORKSPACE-03.md |
| 集成版本 | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |

#### 实现要点
严格采用本模块 I2 实施前UI基准；有限任务数据投影，不能以历史卡片恢复确认权；只读进度检查不自动发模型请求。组件行为与数据排序用必要定向测试，真实Electron由集成任务验收。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-03-1 | unit | required | Vitest HomeAgent 与导航测试：历史不可授权、20终态2待办排序、receipt/阶段投影和受限view hint | - |
| V-WORKSPACE-03-2 | static | required | tsc、check-i18n.mjs、check-i18n-usage.mjs | - |
| V-WORKSPACE-03-3 | browser | required | 由root集成运行home-agent-qa.mjs，复核计划/动作、无模型恢复、键盘焦点、日志锚点及composer遮挡；复用T-WORKSPACE-04的最终截图与交互证据 | - |

### T-WORKSPACE-04 集成复验真实用户流程

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-WORKSPACE-02 |
| 验收 | AC-WORKSPACE-02-1, AC-WORKSPACE-02-2, AC-WORKSPACE-02-3, AC-WORKSPACE-02-4, AC-WORKSPACE-02-5 |
| 依赖 | T-RUNTIME-02, T-TOOLS-02, T-WORKSPACE-03 |
| 写集 | scripts/home-agent-qa.mjs |
| 负责人 | root |
| 依赖确认 | T-RUNTIME-02、T-TOOLS-02、T-WORKSPACE-03 已在161b109基线加 records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) 核验；分别见对应 records/i2/ 实施记录，最终类型/构建/相关回归与真实Electron共同验证，root单写文档证据与QA |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/i2/T-WORKSPACE-04.md |
| 集成版本 | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |

#### 实现要点
保留I1原证据，新增I2记录。根据复审基准扩充真实Electron隔离数据/原生文件对话框/mock模型；截图后自查修复，记录未覆盖真实供应商与跨平台限制。终态不会等同后台处理完成。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-WORKSPACE-04-1 | browser | required | build --mode=test后运行home-agent-qa.mjs：四语言、1280x860/786x660浅深色、无模型导入取消/非法/合法、准备取消/确认/混合失败、任务状态、日志阅读、键盘焦点、进度草稿及工作区导航；检查截图并清理进程 | - |
| V-WORKSPACE-04-2 | unit | required | Vitest运行src/agent src/store/agent src/pages/HomeAgent src/services/rename/nameTranslationPlanner.test.ts test/subtitle-studio和Studio导航；无新回归 | - |
| V-WORKSPACE-04-3 | static | required | tsc、i18n两检查、preload channel检查、正常git diff --check及spec done核对 | - |

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
