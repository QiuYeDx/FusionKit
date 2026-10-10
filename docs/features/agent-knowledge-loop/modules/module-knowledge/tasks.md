# knowledge 任务

这里的每个任务块是唯一任务台账。不要再手写状态汇总表；总览由脚本生成。
元数据引用需求与 AC；不要复制 AC 文本。负责人可连续完成多个任务，但同一时刻只领一个。

### T-KNOWLEDGE-01 原子批量保存 saveRecords

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-KNOWLEDGE-01 |
| 验收 | AC-KNOWLEDGE-01-1, AC-KNOWLEDGE-01-2, AC-KNOWLEDGE-01-3, AC-KNOWLEDGE-01-4, AC-KNOWLEDGE-01-5 |
| 依赖 | - |
| 写集 | electron/main/translation-knowledge/service.ts, electron/main/translation-knowledge/ipc.ts, electron/main/translation-knowledge/index.ts, electron/preload/translation-knowledge-api.ts, src/translation-knowledge/ipc-contract.ts, test/translation-knowledge/service.test.ts, test/translation-knowledge/ipc.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i1/T-KNOWLEDGE-01.md |
| 集成版本 | 45a88e0 + 未提交工作树（I1） |

#### 实现要点

按 [设计·saveRecords](design.md) 抽出共用的单项保存函数，`saveRecord` 改为调用它；新增 `saveRecords`、IPC schema、渠道常量、preload 方法与 API 接口类型。诊断路径加 `/items/<i>` 前缀。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-KNOWLEDGE-01-1 | unit | required | node node_modules/vitest/vitest.mjs run test/translation-knowledge/service.test.ts test/translation-knowledge/ipc.test.ts --maxWorkers=1 | - |
| V-KNOWLEDGE-01-2 | unit | required | node node_modules/vitest/vitest.mjs run test/translation-knowledge --maxWorkers=1（排除 *-electron 与 layout，回归现有资料测试） | - |

### T-KNOWLEDGE-02 资料变更提案构造与预检

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-KNOWLEDGE-02 |
| 验收 | AC-KNOWLEDGE-02-1, AC-KNOWLEDGE-02-2, AC-KNOWLEDGE-02-3, AC-KNOWLEDGE-02-4, AC-KNOWLEDGE-02-5, AC-KNOWLEDGE-02-6 |
| 依赖 | T-KNOWLEDGE-01 |
| 写集 | src/translation-knowledge/proposal.ts, test/translation-knowledge/proposal.test.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | T-KNOWLEDGE-01：同一工作树 45a88e0+I1，service/ipc 测试通过后开发 |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i1/T-KNOWLEDGE-02.md |
| 集成版本 | 45a88e0 + 未提交工作树（I1） |

#### 实现要点

按 [设计·提案构造](design.md) 实现纯函数与类型；id 种子映射保证确认时重建得到相同 id；预检复用 `validatePackage`；语言规范化与 exists/冲突判断。依赖 T-KNOWLEDGE-01 的 `SaveRecordsRequest` 类型。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-KNOWLEDGE-02-1 | unit | required | node node_modules/vitest/vitest.mjs run test/translation-knowledge/proposal.test.ts | - |
| V-KNOWLEDGE-02-2 | integration | required | 在同一测试文件中把提案生成的请求交给临时目录中的真实 KnowledgeService.saveRecords，断言保存结果与启用/待审核状态 | - |

### T-KNOWLEDGE-03 翻译资料页 Agent 上下文与定位

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-KNOWLEDGE-03 |
| 验收 | AC-KNOWLEDGE-03-1, AC-KNOWLEDGE-03-2 |
| 依赖 | - |
| 写集 | src/pages/TranslationKnowledge/agent-context.ts, src/pages/TranslationKnowledge/agent-context.test.ts, src/pages/TranslationKnowledge/index.tsx, src/translation-knowledge/library-events.ts |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i1/T-KNOWLEDGE-03.md |
| 集成版本 | 45a88e0 + 未提交工作树（I1） |

#### 实现要点

纯函数生成快照与解析定位（`knowledgePageContext`、`focusedCollection`），页面注册并在首次快照后应用 `knowledgeFocus` 再清除导航状态；监听资料变更广播（`library-events.ts`）。无新视觉元素；定位后的资料页即现有资料视图。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-KNOWLEDGE-03-1 | unit | required | node node_modules/vitest/vitest.mjs run src/pages/TranslationKnowledge/agent-context.test.ts | - |
| V-KNOWLEDGE-03-2 | browser | required | Electron：从卡片回执点击「在翻译资料中查看」（T-AGENT-04 场景内），截图确认资料页选中目标资料集且无错误；再以不存在的资料集 id 导航，确认停留在全部资料 | - |

### T-KNOWLEDGE-04 批量记入对话框

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-KNOWLEDGE-04 |
| 验收 | AC-KNOWLEDGE-04-1, AC-KNOWLEDGE-04-2, AC-KNOWLEDGE-04-3, AC-KNOWLEDGE-04-4 |
| 依赖 | - |
| 写集 | src/pages/TranslationKnowledge/KnowledgeCaptureDialog.tsx, src/pages/TranslationKnowledge/capture.ts, test/translation-knowledge/capture.test.ts, src/locales/zh/materials.json, src/locales/en/materials.json, src/locales/ja/materials.json, src/locales/zh-Hant/materials.json |
| 负责人 | Claude（当前会话） |
| 依赖确认 | - |
| 完成日期 | 2026-10-10 |
| 实施记录 | records/i2/T-KNOWLEDGE-04.md |
| 集成版本 | 45a88e0 + 未提交工作树（I2） |

#### 实现要点

按 [设计·批量记入对话框](design.md)。行状态与提案输入由纯函数 `capture.ts` 生成，组件只负责表单与保存流程；视觉复用快捷记录对话框。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-KNOWLEDGE-04-1 | unit | required | node node_modules/vitest/vitest.mjs run test/translation-knowledge/capture.test.ts（含临时目录真实服务保存与失败不写入） | - |
| V-KNOWLEDGE-04-2 | browser | required | 在 T-STUDIO-02 的 Electron 场景中打开对话框：截图审阅行状态、新建资料集、按钮禁用条件，1280×860 浅/深色 | - |
