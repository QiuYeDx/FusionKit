# 渲染审查记录（studio-cue-listening）

截图由 `test/subtitle-studio/cue-listening-ui.test.ts` 在最终代码上生成（Electron 静默窗口、静音），已逐张查看。

| 截图 | 状态 / 视口 | 观察 |
| --- | --- | --- |
| screenshots/studio-cue-listening--01-following-1280-light.png | 第 2 行选中、第 3 行正在播放 | 正在播放的行为中性底色 + 播放强调条 + 进度环停止按钮，与天蓝色选中行可区分 |
| screenshots/studio-cue-listening--02-mark-refused-1280-light.png | 打点被拒 | 表头状态区显示“结束时间不能早于开始时间”，第 21 行时间未变 |
| screenshots/studio-cue-listening--03-menu-1280-light.png | 右键菜单 | “播放原始音频 P”下方“从这里连续播放 Shift+P” |
| screenshots/studio-cue-listening--04-next-page-1280-light.png | 跨页跟读 | 自动翻到 101–120 页并继续高亮 |
| screenshots/studio-cue-listening--05-panel-1280-light.png | 面板：0.75×、循环开 | 速度三段选择、循环开关、键位列表；工具栏按钮右下角“.75”角标 |
| screenshots/studio-cue-listening--06-following-786-dark.png | 786 深色跟读 | 正在播放行与选中行在深色下仍可区分 |
| screenshots/studio-cue-listening--07-panel-786-dark.png | 786 深色面板 | 面板高度受限于窗口，内部滚动，不再超出窗口底部 |
| screenshots/studio-cue-listening--08-waveform-1280-light.png | 时间编辑波形 | 有声段为色块、静音段为基线；开始 / 结束标记为深色竖线与顶部小标，试听按钮在右侧 |
| screenshots/studio-cue-listening--09-waveform-786-dark.png | 786 深色波形 | 波形与按钮不超出时间列（测试测量右缘），高亮段为亮蓝 |

## 发现与修复（状态/位置 → 现象 → 原因 → 改动 → 复验）

1. 786 深色面板 → 面板超出窗口底部 → 新增两组控件与三行说明使面板变高 → 高度限制为 `--radix-popover-content-available-height` 并内部滚动；三行说明改为紧凑键位列表 → 截图 07。
2. 1280 浅色跟读 → 正在播放行与选中行颜色几乎相同 → 两者都用天蓝色相 → 跟读改用中性底色 + 强调条 → 截图 01、06。
3. 波形 → 轻声时几乎看不见 → 按满幅绘制 → 按可见范围最大值归一（增益上限 20 倍）→ 截图 08，测试测量有声 / 静音列的着色比例。
4. 波形 → 开始 / 结束标记与高亮段同色、难以分辨 → 标记用强调色 → 改用文字颜色 → 截图 08、09。
5. 编辑时间时加载波形 → 会取消连续播放的下一段 → 主进程每窗口只保留一个解码 → 按“窗口 + 用途”分道（设计“实施中确定”）→ `cue-audio.test.ts`“decodes a waveform beside playback without stopping it”。
