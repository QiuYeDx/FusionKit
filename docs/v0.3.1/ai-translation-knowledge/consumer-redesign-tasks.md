# C 端流程重构执行台账

权威设计与 AC：[consumer-redesign.md](consumer-redesign.md)。用户已授权先设计后连续实施；不涉及发布、真实资料迁移或外部模型付费调用。基线 `d1cc07e`，共享工作树由主代理协调，禁止重复写共享文件。

| 任务 | 负责人 / 写集 | 验收 | 状态 |
| --- | --- | --- | --- |
| RD1 资料集主页、简洁录入与批量粘贴 | knowledge_tour：`src/pages/TranslationKnowledge/`（QuickTermDialog 除外）、四语言 `knowledge.json`、资料页单元测试 | AC1–3 | 完成 |
| RD2 工作台统一翻译配置、显式复用与方案、自动资料选择 | tour_validation：StudioTranslation/KnowledgeTrial/KnowledgeBatch/AutomaticKnowledge 及新增选择组件、四语言 `studio.json`、相关 controller | AC4–5 | 完成 |
| RD3 执行规则修正与旧版本兼容 | rules_audit：领域 execution / 策略兼容 / service 与相关领域测试；不写页面和 locales | AC2、AC7 | 完成 |
| RD4 就地保存译法、集成与原生验证 | 主代理：`QuickTermDialog.tsx`、Studio index/字幕行操作、独立 `materials.json` namespace、原生测试、docs 与最终集成 | AC6、AC8 | 完成 |

业务代码实施前设计审查：资料与工作台均有布局/主次操作；持久化与旧版本边界明确；API 继续复用现有保存/计划/创建能力；真实 Electron 验证已可用。主要风险是执行策略升级、计划过期、跨文档授权与批量部分失败，按对应 AC 回归。不同写集可并行；i18n、构建和原生测试由主代理串行协调，避免同产物竞争。

## 验证记录

验证日期：2026-09-18。使用已安装的 Node 工具；为避免覆盖用户开发实例的 `dist`，把最终源码复制到本轮拥有的临时工作目录构建，链接原 `node_modules`。所有原生测试使用独立 Electron profile、本机 HTTP fixture 与合成密钥，不调用外部模型。

### 类型、领域与边界

| 检查 | 实际结果 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| `node scripts/check-i18n.mjs`、`node scripts/check-i18n-usage.mjs` | 四语言结构及源码引用通过；保留原有相同文案提醒，无缺失 key |
| `node node_modules/vitest/vitest.mjs run test/translation-knowledge/{execution,service,automatic-snapshot,automatic-service,maintenance,task-maintenance,snapshot}.test.ts test/subtitle-studio/{knowledge-translation,knowledge-trial}.test.ts` | 9 个文件、240 项通过；覆盖 v1/v2 冻结恢复、同维度要求共存、真实术语冲突及审批依赖 |
| `node node_modules/vitest/vitest.mjs run test/translation-knowledge/{ui-model,term-paste,labels}.test.ts src/services/subtitle-studio/translation-session.test.ts` | 4 个文件、30 项通过；覆盖录入、解析、语言/范围摘要、计划所有权、过期及显式复用 |
| `node scripts/subtitle-studio/check-boundaries.mjs` | 500 个源文件，0 错误；仅精确审计共用译法弹窗及展示依赖 |
| `node scripts/subtitle-studio-provenance/copy.mjs --check`、`node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check` | 120 个冻结源文件、1 个执行器及其 26 个依赖通过 |
| `node scripts/translation-knowledge/build-artifacts.mjs --check` | 3 个 FK-TK/1 协议产物通过 |
| 隔离目录中 `node node_modules/vite/bin/vite.js build --mode=test` 与 `node scripts/check-preload-bundle.mjs` | renderer/main/preload 三段构建及沙盒 preload 检查通过；仅既有 chunk 提醒 |

### 原生行为验收

运行 `FUSIONKIT_KNOWLEDGE_E2E=1 node node_modules/vitest/vitest.mjs run test/translation-knowledge/{consumer-ux-electron,electron,formal-electron,batch-electron,trial-electron,automatic-electron}.test.ts --maxWorkers=1 --minWorkers=1`，六个文件分别验证通过，维护与首次流程已在最终构建重复验证。

- 首次流程从空库创建资料集、直接录入、更正已应用译法、批量预览开始。重复原词让一行成功一行失败，修正失败行后继续保存；最终数量与批准记录没有重复。无资料直接启动的请求没有资料字段；选择资料后仅匹配字幕收到译法，未选资料集不进入请求。
- 维护流程覆盖原生导入、外部候选确认、修订、导出、备份恢复及归档/清理。原有受限条目通过高级设置维护，未抹去使用条件。
- 全文、批量、片段试译与转写后自动翻译保留真实 IPC、冻结数据及任务记录。检查不产生模型请求；自动翻译旧关闭偏好不会启用残留选择。片段试译不改正式轨道。
- 工作台字幕行就地保存固定译法，要求用户明确缩小原词边界并选择资料集；保存不修改已生成轨道。经典字幕翻译器无资料控件或导航，导入仍进入自己的队列。
- `FUSIONKIT_STUDIO_I6_COPY_UI=1 node node_modules/vitest/vitest.mjs run test/subtitle-studio/interaction-copy-ui.test.ts --maxWorkers=1 --minWorkers=1` 通过：复制原文/译文/双语及时间、键盘操作、剪贴板拒绝、批量摘要、默认折叠详情均保留；过期译文不会预填为新固定译法，关闭录入不改剪贴板。测试结束已恢复原剪贴板。

### 视觉审阅及二次修复

已实际打开中/英、浅/深、1280×860 与 820×700 的 Electron 截图，检查资料集、直接录入、粘贴预览/部分失败、无资料与已选择资料的统一面板、检查结果、窄窗「记住译法」和五步 Tour。

审查修复了语言代码不友好、适用范围遗漏确认条件、批量重复原词错误地建议重新预览，以及普通批量检查详情未默认折叠的问题。Tour 采用实际布局连续稳定后截图，避免把 Motion 中间帧的文字裁切和高亮偏移当成最终效果；装饰箭头单独保留，不靠裁剪根元素掩盖溢出。

代表证据在本地忽略目录 `test-results/translation-knowledge-consumer-ux/`：`redesign-collection-zh-light.png`、`redesign-paste-partial-recovery.png`、`redesign-materials-selection.png`、`redesign-translation-selected-narrow.png`、`redesign-remember-term-narrow.png`、`redesign-tour-en-dark-step-2.png`。资料维护截图在 `test-results/translation-knowledge/`。

### 边界与实现取舍

- 无数据库格式迁移。新执行策略使用 v2；已有 v1 自动准备按保留的 v1 解析器执行，已冻结请求按原记录恢复；未知策略继续拒绝。
- 普通资料集归类不生成使用条件；纯展示编辑不使条目确认失效，归档仍影响可用性。跨文档或源修订变化清空逐句授权；同会话记忆不持久化凭据和计划。
- 全文检查展示公开 API 实际返回的数量和原因，具体条目通过片段检查/执行记录查看；「纳入」不等于「模型遵循」。未将 AI 自动提取、表达/参考译文执行或自动学习包装成已实现能力。
- 新发现已沉淀到 FK-PIT-0161 和 FK-PIT-0163：空选择语义、试译主题投影、会话独占取消、配置身份校验、过期结果拒绝和任务已接收回执。

### 清理与交付

本轮没有启动 Vite 开发服务。已逐项确认原生测试进程退出、fixture HTTP 服务关闭、独立 profile 删除，并核对进程表没有本轮临时目录的 Electron/Vitest 遗留；保留用户自己的开发实例。截图与验证日志不进提交；`package.json` 与 `pnpm-lock.yaml` 未修改。用户提供的未跟踪 `refference/` 原文保持原样且不代为提交。

AC1–8 完成；270 项领域/组件行为检查及 7 项原生流程通过，最终 TypeScript、i18n、依赖边界与构建通过。提交包含设计、实现、必要回归和避坑记录。
