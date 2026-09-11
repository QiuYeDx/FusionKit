# 组件与视觉约定

所有源码路径相对仓库根目录。数值是当前基线，不代替阅读源码；若用户改变项目设计方向，应同步更新约定。

## 组件所有权

| 内容 | 先读/复用 | 不应出现的偏移 |
| --- | --- | --- |
| 页面结构 | `src/pages/Tools/_shared/ui/ToolDetailLayout.tsx` | 每个工具自己定义一套宽度、左右 gutter 或配置列宽 |
| 页标题和工具色 | `src/pages/Tools/_shared/ToolPageHeader.tsx`、`ToolBadge.tsx`、`toolMeta.ts` | 新工具自己画装饰 Hero 或另造整页主色 |
| 普通面板 | `src/pages/Tools/_shared/ui/ToolPanel.tsx` | 同类标题栏一处 `p-3`、另一处 `px-4 py-3`、再一处 `py-4` |
| 配置面板 | `ToolConfigPanel.tsx`、`ToolField.tsx` | 外壳和字段双重 padding、空白比控件大 |
| 配置通栏部分 | `ToolConfigDivider.tsx`、`ToolConfigDisclosure.tsx` | 父级 12px 但负 margin 仍为 16px，导致展开后越界 |
| 上传 | `ToolFilePickerSurface.tsx`、`ToolFileDropZone.tsx` | 原生文件对话框与 input/dropzone 入口长得不一样 |
| 状态/指标 | `ToolStatBar.tsx`、`ToolSummaryLine.tsx` | 简短元数据拆成多层宽松区域，占掉正文 |
| 参数 | `ToolRadioButtonGroup.tsx`、`ToolSwitchRow.tsx`、`src/components/ui/select.tsx` | 为了看起来统一而改变控件语义 |
| 视图切换 | `src/components/qiuye-ui/clip-path-tabs.tsx` | 只 import 正确组件，却沿用默认 pill |
| 平滑圆角 | `src/components/qiuye-ui/smooth-corners.tsx` | 只凭 Tailwind 类名断定最终圆角可用 |
| 音频工具 | `src/pages/Tools/Audio/shared/AudioToolShell.tsx` | 工作区叠加独有的 20–24px 外围留白 |
| 字幕工作台细节 | `src/pages/Tools/Subtitle/SubtitleStudio/StudioControls.tsx`、`studio.css` | 新建文件名/分页控件后丢失既有处理 |

`ToolPanel` 默认正文没有 padding，这是给表格、列表和空状态自行控制的结构，不是缺陷。需要有内边距的表单正文通常用 `bodyClassName="p-3"`；不能直接给所有面板正文全局加 padding。

## 当前尺度

| 层次 | 基线 | 说明 |
| --- | --- | --- |
| 页面 | `max-w-7xl`；`px-4 sm:px-8`；底部 100px | 底部为固定导航预留，不因紧凑化直接删除 |
| 布局 | 桌面配置列 320px；列间 16px；主区域 gap 12px | 窄窗口的主要工作流可达；已有 `order-*` 有意表达流程 |
| 普通/配置面板 | `SmoothCorners` radius 16 / smoothing 0.72 | 复用背景、边框和轻阴影，不层层套装饰面板 |
| 上传区 | radius 18 / smoothing 0.74；2px dashed；`p-3`、gap 12px；图标底座 40px | 默认横向，容器不足时可换行；stacked 变体仍需验证 |
| 标题与配置正文 | 12px padding；字段组 16px | 核对调用方是否有覆盖及嵌套留白 |
| 底栏旧实现 | `px-3 py-1`，常见 32px 控件对应约 41px 含边框高度 | 记录已有代码，不作为审美验收标准；须按下方靠角等距要求检查，不固化横纵不等距 |
| 配置折叠/分隔 | `-mx-3`，折叠内容 `px-3`；必要底部补偿 `-mb-3` | 与父级内边距成对调整 |

色彩遵循 `src/index.css` 的语义 token：`background/card/muted/accent/border/foreground/muted-foreground`，工具标识使用 `toolMeta` 的 tone。不要因某品牌审美偏好引入另一套暖色、中性色或字体系统。

小标题延续现有紧凑排版：配置标题约 11px，普通面板标题约 13.5px；正文依用途采用项目已有字号。不能缩小所有文字来掩盖间距和结构问题。

## 圆角附近的等距留白

用户明确要求：靠近圆角的按钮或其他元素，与外层容器相邻两侧的留白相等、自然。此要求高于未经复核的既有 padding 数值；“统一 token”不足以通过验收。

- 右上角操作比较上/右，右下角分页比较下/右，左侧同理。量可见控件外框到真正外壳边框内沿的距离，计入中间容器、margin 和 border；不能只比较 CSS 声明。
- 先选符合整体密度的共同间距，再判断控件圆角与 `SmoothCorners` 外壳之间的轮廓。不要将两者半径机械设为相同，也不要把普通同心圆角的半径减间距公式硬套平滑圆角。
- 分页既要紧凑又要靠角协调。不能把横向 12px、纵向 4px 当作固定要求，也不能为了匹配横向值无条件增大整个底栏；需一起检查侧向留白、控件布局和整体尺度。
- 比较的是靠角元素的相邻两侧，不要求页面 gutter、字段 gap、行间距全部相同。按钮内部图标的光学留白、透明热区和焦点环另查，不能靠压缩点击区域或裁剪焦点环达成等距。

## 字幕工作台的空间预算

文件名称/格式/编码/来源状态和视图切换是工作区工具栏，不是独立内容章节。宽空间下共享一行或紧凑两行；窄窗口使用已有移动选择器策略，不能同时重复展示两份 metadata。

时间和正文是需要逐条扫描的内容。当前普通一行字幕约 33px，正文 13px / 20px 行高；这只是回归参照，字体缩放、多行和操作目标要求优先。长文本及显式换行可以增长该行，编号、时间、复制操作不能因此整体垂直居中。原始源内容视图按它自己的可读性要求排版，不盲目套正文行高。

列表相邻离散高亮保留 4px 间隔。不要用去掉 hover 或缩短点击区域来隐藏背景连接的问题。

文档库选择状态采用单一行表面：搜索框与行外框同为12px边距，行内8px，复选框/文字起点20px/44px。li统一承载hover、当前预览和多选背景，子button透明；当前预览仍有勾号指示。批量操作与分页复用45px单行固定footer（28px图标、上下8px），选择前后不增高或挪动列表。更多菜单承载继续、取消、删除和清空；数字跳页保留。原始顶部批量卡片不再作为本页参照。

## 文件名与 Tooltip

- 列表、预览标题和窄屏选择器保持一致的识别策略：长名称中间省略，尾部和扩展名可见，完整名称有 Tooltip/等效可访问入口。
- `src/components/ui/tooltip.tsx` 的通用默认包含 `text-balance`。文件名 Tooltip 应在局部覆盖为自然换行和内容自适应：当前为 `w-max`、最大 `min(20rem, 100vw - 2rem)`、`whitespace-normal`、`text-wrap` 与 `overflow-wrap:anywhere`。
- 不要全局删除所有 Tooltip 的均衡换行；不把某次 320px 上限推广为其他提示场景的固定宽度。
- 看短/长文件名实际打开后的文字与框，不能只检查最大宽度或存在状态。两个文本行都很短但框很宽，是失败信号；最后一行自然留白可以接受。
- 无障碍完整文本应只有一份有效名称；不能为 Tooltip 在按钮内新增嵌套 button。核对键盘焦点与鼠标两种入口，而不是因组件有 Tooltip 就假设都可用。

## 文案和交互

字幕工作台文件入口当前使用“上传字幕”，结果动作使用“下载原文”；“打开字幕文件”是选文件命令。四种语言、相关成功/错误提示与图标应一致。它仍走现有本地业务 API，不表示上传到网络，也无需为了显示文案重命名 IPC。

图标使用现有 lucide，尺寸、点击热区与 Button size 成套看。视图 Tab 使用圆角矩形选中形状；参数模式的既有胶囊 segmented control 是不同语义，保留它的约定。

## 这轮经验形成的检查项

| 曾漏检的类别 | 下一次要主动找的反例 |
| --- | --- |
| 风格 | 新页与转换器/相邻页并排是否属于同一产品 |
| 边距 | 上传四边、标题栏上下左右、右侧操作、配置正文、底栏是否同类一致 |
| 圆角留白 | 右上按钮上/右、末端分页下/右等是否等距；数值一致但内外曲线是否仍显得挤压或空洞 |
| 高度与横向浪费 | 文件信息竖向堆叠但旁边很空；正文可见行数被无效留白挤占 |
| 密度 | 一行内容被固定行高、时间两行或大操作按钮撑高 |
| 对齐 | 某列换行后编号/时间/操作的首行位置改变；Tab 与按钮右缘错位 |
| 局部补丁 | 把一个标题栏从 12px 加到 16px 虽然等边，却又与其他区域不一致 |
| 共享补偿 | 改 p-3 后遗漏 -mx-4、-mb-4、页面 bodyClassName 或上传区覆盖 |
| 交互状态 | 选中项旁边 hover、Tab shape、长文件名及真正打开的 Tooltip |
| 证据 | 测试通过但截图还带 loading、导航遮挡、未打开浮层或只测空状态 |
