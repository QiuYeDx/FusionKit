# I2 / I3 集成结果

2026-10-10，基线 45a88e0 + 未提交工作树。任务记录：I2 见 `records/i2/T-*.md`，I3 见本目录 `T-*.md`。

## 用户能做什么

**I2 修订 ↔ 资料**

- 在翻译时选用过资料的文档里用 AI 修订译文：修订请求带上命中的术语与要求，对话框显示「参考资料：…」。
- 修订把一个名称统一成某种译法时，预览提示「应用后可将 N 条译法记入翻译资料」；应用后工作台出现「AI 修订中有 N 条译法可以记入翻译资料」→ 一个对话框里勾选、修改、选资料集、保存。已有相同译法不提示，关闭/撤销/换文档后不再追问。
- Agent 发起的修订被应用后，Agent 收到回报并询问一次是否记入。

**I3 术语一致性检查**

- 在字幕预览工具栏（当前文档）或文档列表（多选，最多 20 个）发起；可写重点。
- 结果按组列出：同一原文的不同译法、同一名称的不同原文写法、未按所选资料翻译的地方；给出推荐写法、出处并标出差异。
- 选定（或自定义）标准写法后一键统一，只做文字替换；当前文档可 Ctrl+Z，检查窗口内可撤销对所有文档的统一；统一后可把写法记入翻译资料；替换不了的行可一键转为 AI 修订。
- 也可让 Agent 检查（`studio_check_consistency`），由用户在窗口中统一。

## 合规与基础设施

- Studio 依赖边界：新增共享模块登记审计条目；Studio 页面经 `page-context` 中立事件出口向 Agent 上报事件，不引入 Agent 运行时依赖。
- Studio 来源审计：`electron/main/subtitle-studio/index.ts` 的组合变更按项目流程记录审阅（`current-integration-audits.v1.json`），保持 `eol=lf` 字节。
- 顺带修正：基线已失败的 i18n 用法检查（`StudioLibrary.tsx` 未定义键）与两个未登记的动态键。

## 验证摘要（最终代码）

| 范围 | 结果 |
| --- | --- |
| 全量 vitest | 5489 通过、83 跳过、1 失败 → 失败项为工具页复选框约定清单未登记新窗口，登记后 2/2 通过（file:records/i3/full-regression.log） |
| Studio 依赖边界 / 来源审计 | 0 错误；provenance 233 通过、3 跳过 |
| 类型检查 / i18n | 0 错误 / 全部键可解析 |
| Electron 集成（最终构建） | 资料卡片、修订↔资料、一致性检查、原有 AI 修订 ×2、悬浮面板：全部通过；`agent-handoff` 失败于面板滚动条断言——在未改动的 45a88e0 工作树上同样失败，为既有问题（已另开任务），见 file:records/i3/final-electron.log |

## 截图索引

| 文件 | 内容 |
| --- | --- |
| ../i2/screenshots/01-preview-materials-and-hint.png | 修订预览：参考资料行、可记入提示 |
| ../i2/screenshots/02-offer.png | 应用后的工作台提示条 |
| ../i2/screenshots/03-capture-dialog-light.png | 批量记入对话框（浅色） |
| ../i2/screenshots/05-capture-dialog-dark.png | 批量记入对话框（深色，冲突说明） |
| screenshots/01-result-two-documents.png | 两个文档的一致性检查结果与出处 |
| screenshots/02-keep-wording.png | 统一后记入资料（新建资料集） |
| screenshots/03-receipt.png | 统一回执与撤销 |
| screenshots/04-current-document-narrow-dark.png | 当前文档、窄窗口深色、自定义写法 |
| screenshots/05-source-spellings-dark.png | 用户测试反馈修复后：未翻译文档的原文写法组，重复报告已合并，组内单选统一方向 |

## 未覆盖与待用户验收

- 真实模型的约定识别质量与名称召回需用你的模型试用。
- ja / zh-Hant 未截图审阅；Agent 发起检查/修订后的跟进对话未做 Electron 端到端。
- 用户验收未签署（spec.json acceptance 为 pending）。
