# HomeAgent 正式工具接入任务

### T-TOOLS-02 保留批量回执并校验准确转写范围

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TOOLS-02 |
| 验收 | AC-TOOLS-02-1, AC-TOOLS-02-2, AC-TOOLS-02-3 |
| 依赖 | - |
| 写集 | src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/prepared-actions.ts, src/agent/prepared-actions.test.ts, src/services/subtitle-studio/transcription-controller.ts, test/subtitle-studio/transcription-controller.test.ts |
| 负责人 | audit_tools |
| 依赖确认 | 同一161b109基线，receipt契约已记录design并交接UI；controller仅此任务写 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/i2/T-TOOLS-02.md |
| 集成版本 | 161b109 + records/i2/source-snapshot.json (432f739d9aaad6c65a05c15e505a22fa14ecc77832273bd15cb1c729ee5c8495) |

#### 实现要点
按本模块 I2 design 完整保留失败 data 与有限逐项回执；准确范围检查紧邻真实入队，默认工作台不变；三类资料分别分页。

#### 验证计划
| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-02-1 | unit | required | Vitest modern-tools/prepared-actions/transcription-controller：部分及全失败、过期与多余草稿零提交、分页二页完整性 | - |
| V-TOOLS-02-2 | static | required | tsc --noEmit 与 git diff --check | - |

### T-TOOLS-01 实现正式能力目录与会话绑定准备执行

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-TOOLS-01 |
| 验收 | AC-TOOLS-01-1, AC-TOOLS-01-2, AC-TOOLS-01-3, AC-TOOLS-01-4, AC-TOOLS-01-5, AC-TOOLS-01-6, AC-TOOLS-01-7 |
| 依赖 | - |
| 写集 | src/agent/capability-catalog.ts, src/agent/capability-catalog.test.ts, src/agent/modern-tools.ts, src/agent/modern-tools.test.ts, src/agent/prepared-actions.ts, src/agent/prepared-actions.test.ts |
| 负责人 | audit_tools |
| 依赖确认 | 基于已有固定 API；共享 registry 与 UI 由集成负责人组合 |
| 完成日期 | 2026-10-03 |
| 实施记录 | records/T-TOOLS-01.md |
| 集成版本 | aab39c9a + records/source-snapshot.json (b701227f99f70eb31954f65f4abea45a5f5461030d9a955d4fd3e6bc1021e725) |

#### 实现要点

按 design.md 正式目录、现代工具和准备动作契约实施。回调仅内存保留，统一会话检查和同步 claim。复用 fixed API、Schema、转写 controller、翻译 overview，不增加 preload/main 权限。经典转写保留真实 File 选择，资料只读投影。导出 modernAgentTools 与 usePreparedActionsStore；写集外必要变更先协调。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TOOLS-01-1 | unit | required | `node_modules/.bin/vitest run src/agent/capability-catalog.test.ts src/agent/modern-tools.test.ts src/agent/prepared-actions.test.ts`；正式范围、分页/参数、固定授权、执行模式、并发/会话/清理及敏感投影 | - |
| V-TOOLS-01-2 | static | required | `node_modules/.bin/tsc --noEmit` 和 `git diff --check`；其他模块失败记录归属，最终集成重跑 | - |
| V-TOOLS-01-3 | interface | required | 固定 API mock 验证 picker 取消、非 ok、reject、缺 API、旧草稿/配置改变、未知提交和 revision 过期不误报成功或重复提交 | - |
