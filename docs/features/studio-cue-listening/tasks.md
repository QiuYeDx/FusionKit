# 边听边校对 任务

每个任务块是唯一任务台账。设计基准见 design.md「UI（设计基准）」。

### T-LISTEN-01 主进程变速与 Web Audio 引擎

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-LISTEN-01 |
| 验收 | AC-LISTEN-01-1, AC-LISTEN-01-2, AC-LISTEN-01-3, AC-LISTEN-01-4 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-audio.ts, electron/main/subtitle-studio/cue-audio-clip.ts, src/services/subtitle-studio/cue-audio-player.ts, src/services/subtitle-studio/cue-audio-player.test.ts, test/subtitle-studio/cue-audio.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-LISTEN-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「播放引擎」：`tempo` 请求字段与 FFmpeg 输入时长 / `atempo`；播放器改为 Web Audio，保留现有接口，新增 `follow`、`positionFor`、循环、改速重启与结束判定。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LISTEN-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/services/subtitle-studio/cue-audio-player.test.ts：假 AudioContext 下的首尾调度、预取、位置（tempo、输出延迟）、循环、改速、结束、缓存键 | - |
| V-LISTEN-01-2 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-audio.test.ts：真实 FFmpeg 0.75× / 0.5× 时长与音高、输入时长生效 | - |
| V-LISTEN-01-3 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-audio-ui.test.ts：已有单段播放行为不回归 | - |

### T-LISTEN-02 连续跟读、速度与循环设置、打点

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-LISTEN-02, R-LISTEN-03, R-LISTEN-04 |
| 验收 | AC-LISTEN-02-1, AC-LISTEN-02-2, AC-LISTEN-02-3, AC-LISTEN-03-1, AC-LISTEN-03-2, AC-LISTEN-04-1, AC-LISTEN-04-2, AC-LISTEN-04-3, AC-LISTEN-04-4 |
| 依赖 | T-LISTEN-01 |
| 写集 | src/store/tools/subtitle-studio/preferences.ts, test/subtitle-studio/transcription-preferences.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueMenu.tsx, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/locales/, test/subtitle-studio/cue-listening-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-LISTEN-01：同一工作树 393dc61+未提交改动，引擎单元与单段播放界面测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-LISTEN-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「连续跟读」「速度与循环设置」「打点」：Shift+P 与菜单入口、跟读高亮 / 滚动 / 翻页、偏好与面板控件与角标、`[` / `]` 打点与提示、帮助项；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LISTEN-02-1 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-listening-ui.test.ts 的跟读 / 设置 / 打点部分：120 条转写文档跨页跟读、P 停止、0.75× 与循环偏好重启保持、改速继续、打点成功 / 被拒 / 未播放、撤销、菜单与帮助 | - |
| V-LISTEN-02-2 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：跟读高亮与选中区分、面板新控件、工具栏角标、状态区提示；问题修复后复验 | - |
| V-LISTEN-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；pnpm run i18n:check；偏好测试 | - |

### T-LISTEN-03 时间编辑框波形

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-LISTEN-05 |
| 验收 | AC-LISTEN-05-1, AC-LISTEN-05-2, AC-LISTEN-05-3 |
| 依赖 | T-LISTEN-02 |
| 写集 | src/subtitle-studio/cue-audio.ts, electron/main/subtitle-studio/cue-audio-clip.ts, test/subtitle-studio/cue-audio.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueWaveform.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx, src/services/subtitle-studio/cue-audio-player.ts, src/services/subtitle-studio/cue-audio-player.test.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTimeEditor.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.css, src/locales/, test/subtitle-studio/cue-listening-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-LISTEN-02：同一工作树，跟读 / 打点界面测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-LISTEN-03.md |
| 集成版本 | - |

#### 实现要点

按 design.md「波形」：`peaks` 折算与缓存、时间编辑器中的画布、标记拖动写回输入、试听当前输入；初版后渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LISTEN-03-1 | unit | required | cue-audio-player.test.ts 的 peaks 用例：有声 / 静音区间的峰值 | - |
| V-LISTEN-03-2 | browser | required | cue-listening-ui.test.ts 的波形部分：出现、标记位置、拖动写回、保存撤销、无媒体不显示 | - |
| V-LISTEN-03-3 | manual | required | 查看时间编辑器波形截图（1280 浅色、786 深色）：不撑宽时间列、标记清晰；问题修复后复验 | - |

### T-LISTEN-04 回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-LISTEN-01, R-LISTEN-02, R-LISTEN-03, R-LISTEN-04, R-LISTEN-05 |
| 验收 | AC-LISTEN-01-4, AC-LISTEN-02-3, AC-LISTEN-05-3 |
| 依赖 | T-LISTEN-03 |
| 写集 | CHANGELOG.md, docs/TODO.md, docs/features/studio-cue-listening/ |
| 负责人 | Claude |
| 依赖确认 | T-LISTEN-03：同一工作树，波形界面测试通过后回归 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-LISTEN-04.md |
| 集成版本 | - |

#### 实现要点

字幕工作台单元 / 接口 / provenance 回归与相关 Electron UI 测试；CHANGELOG 与 TODO 勾选；记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-LISTEN-04-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle electron --maxWorkers=4 --minWorkers=1 | - |
| V-LISTEN-04-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-listening-ui、cue-audio-ui、cue-structure-ui、cue-revision-ui、consistency-ui、preview-expansion-ui、cue-editing-ui | - |
