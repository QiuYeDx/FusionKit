# 字幕工作台与翻译资料弹窗尺寸过渡

## 内容与文档流的补充修复

首版的外框逐帧测试未覆盖内部内容和后续控件的位置，因此不能证明内容过渡完整。用户反馈后补查到 Radix 在开合时临时禁用 Content 节点的 CSS transition，导致放在同一节点的 grid 折叠过渡被打断；部分调用侧还在收起时直接卸载子树。

- 折叠动画移至 Radix Content 内独立的原生 Motion 节点，以自然内层测量真实高度，使用 `animate={{ height }}` 改变文档流占位，同时补间内层透明度。下方控件由真实高度变化连续推移。
- 条件字段、错误/状态提示、分页内容和持久 Tab 面板采用同一局部高度机制。重列表首次展开后保留，避免丢失退出画面和表单草稿。
- 可选内容的间距放进动画 stage 内部；稳定分组消除 `gap` 和 `:last-child` 在挂载、卸载时带来的末帧跳动。空字符串不再创建只含 padding 的假内容。
- 普通折叠不额外叠加 sibling layout 动画。列表增删仍使用 `layout="position"` 和 presence，但列表本身也保留真实高度过渡，避免下面的按钮瞬移。
- 父区域及弹窗跟随已经插值的子高度，不每帧重启弹簧；本层主动开合优先，支持嵌套开合和中途反转。退出树不计入活跃文档流。
- 内容退出与高度回收到零均完成后才清理 wrapper，保留立即 inert/aria-hidden 及实时减少动态效果偏好。
- 新增 `test/dialog-content-motion.electron.test.ts`：同时采集实际内容高度、透明度、下方元素相对正文的位置、外壳跟随关系，并捕获运动中途的原生截图。该项补充了首版只看外框几何的验收缺口。

## 实现

- 两页的全部 `ScrollableDialog` 入口启用可选的 `animateSize`。共享默认行为保持不变；导览通过同名选项单独启用。
- 参考 Motion recipes 的 measured auto-height case：隐藏宽度标尺解析响应式目标宽度，正文自然层和固定头尾单独测量，外框用 `animate` 插值实际宽高。测量不读取正在插值的外框高度，也不缩放文字。
- 外框高度限制与正文 ScrollArea 保持独立，保留固定头尾。正文达到高度上限后，内容变化仍会更新滚动渐变提示。
- 设置/检查/结果、异步预览、错误提示、资料分页等按语义 key 保留短暂的内容进出过渡。清理列表和批量粘贴行使用稳定 ID、退出动画和位置补间。
- 知识编辑器的标签面板保持挂载。非活动面板立即 inert/aria-hidden，淡出后 display:none，不丢原始多行草稿，也不撑高滚动区域。
- 关闭立即结束业务授权，视觉内容保留到命名 `closed` 动画完成后卸载。退出树不可点击或聚焦；错误焦点只定位当前有效提示。
- 减少动态效果偏好通过 `useSyncExternalStore` 实时订阅，关闭尺寸、位移和内容动画。

## 关键兼容处理

- Radix `Content asChild` 内由原生 `motion.div` 持有 DOM ref，避免 `motion.create(DialogContent)` 经 Slot 重新组合 ref 后中断退出。
- 外框显式禁用 CSS animation 和 transition，防止既有 zoom-out 和 `duration-200` 的默认 `transition-property: all` 与 Motion 叠加。
- 卸载回调检查命名动画阶段，尺寸补间的完成事件不会提前结束关闭动画。
- 退出阶段显式保留最后一次测量的宽高，避免从结果尺寸退回 CSS 默认尺寸；测试同时断言退出内容与尺寸不变。
- 空的内容过渡 wrapper 在退出完成后移除，保留 `gap`、`space-y` 和 `:last-child` 原有间距语义。

## 验证入口

`test/dialog-motion.electron.test.ts` 使用临时 profile 和真实 SRT/资料文件，逐 requestAnimationFrame 采集尺寸、transform、头尾、滚动区域和退出状态；证据输出到 `test-results/dialog-motion`。

覆盖连续展开/收起、中途反转、嵌套预览、结果宽高变化、退出内容保留、窄窗深色滚动、减少动态效果、标签切换保留草稿，以及知识导览步骤与关闭。另运行原有导出、结果反馈、知识资料及合集维护流程，检查业务行为与焦点不回归。

## 首版验证结果

- 完整 TypeScript、根 Vite renderer/main/preload 构建、preload 外部模块检查通过。
- 工作台依赖边界检查：513 个文件、零错误；新增响应式媒体查询 hook 仅依赖 React 与浏览器 API，按精确路径加入基础设施审计。
- 四语种 i18n 完整性与源码 key 检查通过；未新增文案或依赖。
- 六套 Electron 流程通过：`dialog-motion`、`experience-export-ui`、`result-feedback-ui`、知识页 `electron`、`collection-maintenance-electron`、`formal-electron`。
- 新逐帧测试确认尺寸存在多帧中间值，文本无缩放，减少动态效果时尺寸直接到达目标；结果退出的所有已挂载帧始终保持 420×240。
- 人工审阅浅色编辑表单、深色窄窗正文滚动及五步导览截图，头尾与内容无溢出。
- 旧测试的最终布局等待改为连续 rAF 几何稳定；原生文件拖入等待退出 DOM 与交互锁释放，测试定位排除退出层，业务断言保持。
- 本轮临时 Electron 与构建进程已退出；启动于任务之前、使用真实用户配置的开发实例保持原状。

## 内容修复后的验证结果

- 新的内容运动 Electron 测试通过，保存 14 组逐帧轨迹：展开/收起、快速反转、嵌套预览、父级在子级运动时关闭、连续资料折叠、条件字段及末尾间距、减少动态效果，以及删除中间粘贴行后下方按钮的位移。
- 对实际内容高度、透明度、后继元素相对正文的位置分别断言多帧中间值；条件字段包含间距的收尾位移也连续。列表保留行的文字不缩放、输入值不串行，退出行不可交互。
- 外框跟随测试允许 ResizeObserver/Motion 最多两个绘制帧的传播，随后不再有独立弹簧追赶；去掉外框观察器多余的 rAF 调度。
- 既有六套流程重新验证：`dialog-motion`、`experience-export-ui`、`result-feedback-ui`、知识页 `electron`、`collection-maintenance-electron`、`formal-electron` 均通过。导出测试更新了预览首次展开后保持挂载、收起后完全隐藏的验收，保留原有实际文件内容与导出结果断言。
- TypeScript、Vite renderer/main/preload 构建、preload 检查、513 文件依赖边界、四语种 i18n 与源码 key、`git diff --check` 通过。
- 人工审阅内容运动中途、嵌套预览、资料折叠、删除中间行后的表单及深色窄窗截图；帧数据和截图位于 `test-results/dialog-content-motion`，外框与草稿截图位于 `test-results/dialog-motion`。
- 本轮测试、构建进程已退出，保留 01:39–01:40 启动的原有用户开发实例。记录 FK-PIT-0172，避免以后再次只验证外框而遗漏文档流。
