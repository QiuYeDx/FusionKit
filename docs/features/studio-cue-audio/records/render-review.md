# 渲染审查记录（studio-cue-audio）

截图由 `test/subtitle-studio/cue-audio-ui.test.ts` 在最终代码（见 `snapshot-files.txt`）上生成，Electron 静默窗口模式、静音，已逐张查看。

| 截图 | 状态 / 视口 | 观察 |
| --- | --- | --- |
| screenshots/studio-cue-audio--01-row-hover-1280-light.png | 悬停第 2 行，1280×860 浅色 | ▶ 叠在序号位置，其他行仍显示序号；列宽、行高与未悬停时一致 |
| screenshots/studio-cue-audio--02-playing-1280-light.png | 播放中，指针已移开 | 进度环（淡色轨道 + 进度弧）+ 停止方块，左侧 2px 强调条；无残留提示，焦点留在列表 |
| screenshots/studio-cue-audio--03-menu-1280-light.png | 右键菜单 | 首项“播放原始音频 P”，与“编辑时间 T”快捷键对齐；另一行正在播放的进度环同时可见 |
| screenshots/studio-cue-audio--04-panel-ready-1280-light.png | “原始音频”面板（转写来源） | 文件名完整显示（Interview.wav），方式“转写来源”，“更换…”、余量三段选择、P 提示；面板右缘与触发按钮对齐，未超出窗口 |
| screenshots/studio-cue-audio--05-expanded-playing-1280-light.png | 放大预览中按 P | 播放状态与普通视图一致 |
| screenshots/studio-cue-audio--06-panel-missing-1280-light.png | 无媒体 SRT，按 P 打开面板 | “未找到原始媒体”+ 说明 +“选择媒体文件…”；触发按钮弱化并带琥珀点；行内无播放按钮 |
| screenshots/studio-cue-audio--07-playing-786-dark.png | 786×660 深色播放中 | 窄列下按钮仍在序号位置，选中行与播放状态都清晰 |
| screenshots/studio-cue-audio--08-panel-786-dark.png | 786×660 深色面板（手动选择） | “Picked take.wav” 空格保留，“更换… / 取消关联”，面板在窗口内 |
| screenshots/studio-cue-audio-revision--01-structure-playing-1280-light.png | AI 修订合并建议播放中 | 按钮位于复选框与“1–2”之间，不改变勾选 |
| screenshots/studio-cue-audio-revision--02-proposal-playing-1280-light.png | 改字建议播放中 | 按钮与序号同行对齐，差异文字未被挤压 |
| screenshots/studio-cue-audio-revision--03-structure-786-dark.png | 786×660 深色修订 | 窄窗口下按钮与序号仍在同一行 |
| screenshots/studio-cue-audio-consistency--01-place-playing-1280-dark.png | 一致性检查跨文档出处 | Meeting.wav 各处有按钮，Notes.srt（无媒体）无按钮但留空对齐 |

## 发现与修复（状态/位置 → 现象 → 原因 → 改动 → 复验）

1. 面板 → 点余量/按钮即关闭 → portal 内的 React 事件冒泡到字幕列表，`onMouseDown` 抢焦点、`onPointerDown` 改选择 → 面板内容停止 mouse/pointer/click/contextmenu 冒泡；忙碌按钮不禁用 → 截图 04/06/08 面板保持打开，测试断言选择与面板可见。
2. 面板 → 触发按钮提示盖住面板 → 提示与面板同在按钮下方 → 面板打开时强制关闭提示 → 截图 04。
3. 面板 → 文件名截成 “Interview.wa” → 文字列按内容宽度、尾段 `max-width: 50%` 相互约束 → 文字列 `flex: 1` → 截图 04 完整。
4. 面板 → “Picked take.wav” 显示为 “Pickedtake.wav” → `StudioFileName` 两段 flex 子项在断点折叠空格（共享组件既有问题）→ `.studio-file-name` 改 `white-space: pre` → 截图 08；测试断言首段渲染文本保留空格。
5. 列表 → 点播放后“停止播放”提示残留在上一行 → 按钮获得焦点 → `mousedown` 阻止默认聚焦 → 截图 02；测试断言无提示、按钮未聚焦。
6. 列表 → 进度弧像残片 → 无轨道参照 → 加 20% 透明度的整圈轨道 → 截图 02/07。
7. 列表表头 → 无媒体提示文字挤占列标题 → 提示放在状态区 → 改为按 P 打开面板（AC-AUDIO-03-3 调整）→ 截图 06。
8. 一致性检查 → 无媒体文档的出处与有按钮的出处不对齐 → 无按钮时不占位 → 有任一按钮时其余出处留 18px 空位 → 截图 consistency--01。
