# 字幕工作台与翻译资料折叠控件统一

## 改动

- 两页及其弹窗中的原生 `details/summary` 全部迁移到既有 shadcn/ui Accordion，移除浏览器三角标记及各处单独维护的箭头旋转样式。
- 工作台的文档检查、已选文档、翻译计划、导出详情/嵌套预览、操作结果和三处高级设置使用 `StudioDisclosure`。
- 执行记录中的资料说明、资料条目和技术详情复用翻译资料已有的 `KnowledgeDisclosure`。
- 资料集归档/删除影响行使用同一个 Accordion primitive，保留原有 hover 留白、相邻分隔线和默认展开状态；历史清理使用 `KnowledgeDisclosure`。
- 箭头、hover、键盘焦点与减少动态效果设置由共享 Accordion 提供；保留文档卡片、紧凑配置行等原有布局语义。

## 状态与行为

- 表单保持挂载，关闭时同时使用 `inert`、`aria-hidden` 和布局/可见性收起，保留输入但不留下可聚焦的隐藏控件。
- 导出检查和操作结果保留原有按需渲染策略；嵌套预览独立展开/收起。
- 既有 Electron 测试定位改为 Accordion trigger / `aria-expanded`；弹窗主标题精确到二级标题，避免新增的折叠标题被误认为弹窗标题。
- 焦点样式验证使用真实 Tab 导航，避免鼠标操作后的程序化 `.focus()` 仍处于指针模态。

## 验证

- TypeScript 检查、根 Vite renderer/main/preload 构建、preload 外部模块检查通过。
- Subtitle Studio 边界检查：510 个文件，无错误。
- 四语种 i18n parity / 源码 key 检查通过；未改文案和依赖。
- 五套相关 Electron 流程通过：`translation-knowledge/electron`、`collection-maintenance-electron`、`formal-electron`、`subtitle-studio/experience-export-ui`、`result-feedback-ui`。覆盖 Enter/Space、隐藏内容、配置值保留、嵌套预览、深浅主题、长名称及窄窗口。
- 额外运行旧 `workspace-ui.test.ts`，在本次改动之前就存在的“复制字幕”按钮定位处超时，未执行到文档检查步骤。本轮没有修改复制入口；改用隔离 Electron 定向验证文档检查、转写高级设置原始多行草稿保留、减少动态效果及无原生折叠残余，全部通过。
- 截图证据位于忽略目录 `test-results/translation-knowledge*`、`test-results/studio-i5-export/run-TZ5mch`、`test-results/studio-i7-results` 和 `test-results/accordion-smoke`；已人工审阅相关展开、收起和焦点状态。

验收使用 Windows Electron 临时配置，不修改用户的资料库，也不调用真实翻译服务。
