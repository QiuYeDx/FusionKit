# 字幕片段原始音频试听 任务

这里的每个任务块是唯一任务台账。设计基准见 design.md「UI（设计基准）」。

### T-AUDIO-01 契约、媒体关联与片段截取（主进程）

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AUDIO-01, R-AUDIO-02 |
| 验收 | AC-AUDIO-01-1, AC-AUDIO-01-2, AC-AUDIO-01-3, AC-AUDIO-01-4, AC-AUDIO-02-1, AC-AUDIO-02-2, AC-AUDIO-02-3, AC-AUDIO-02-4 |
| 依赖 | - |
| 写集 | src/subtitle-studio/cue-audio.ts, src/subtitle-studio/cue-audio.test.ts, src/subtitle-studio/ipc-contract.ts, electron/main/subtitle-studio/cue-media-service.ts, electron/main/subtitle-studio/cue-audio-clip.ts, electron/main/subtitle-studio/document-repository.ts, electron/main/subtitle-studio/index.ts, resources/speech-resources/provenance/current-integration-audits.v1.json, electron/preload/subtitle-studio-api.ts, electron/preload/subtitle-studio-channel-policy.ts, test/subtitle-studio/cue-audio.test.ts, test/subtitle-studio/ipc.test.ts |
| 负责人 | Claude |
| 依赖确认 | - |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-AUDIO-01.md |
| 集成版本 | - |

#### 实现要点

按 design.md「媒体关联」「片段截取」实现：纯函数（扩展名、同名匹配、时间段解析、schema）放 `cue-audio.ts`；`CueMediaService` 解析顺序与身份复核、私有手动关联记录；`CueAudioClipper` 会话级运行时缓存、FFmpeg 参数与限制、WAV 封装、owner 级取消；四个 IPC 方法与 preload 白名单；owner 释放时中止进行中的截取。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AUDIO-01-1 | unit | required | node node_modules/vitest/vitest.mjs run src/subtitle-studio/cue-audio.test.ts：同名匹配多级后缀/同级冲突/大小写/条目上限，时间段解析未知结束/首末交换/120 秒截断/媒体时长/余量 | - |
| V-AUDIO-01-2 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/cue-audio.test.ts：真实随应用 FFmpeg 生成分段频率 WAV/MKV/MP3，截取长度与频率位置、转写来源/同名/手动关联与重启后保持、移动/修改后不可用、无音轨/损坏/运行时注入失败的原因、快速连续请求取消与无残留文件 | - |
| V-AUDIO-01-3 | interface | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio/ipc.test.ts：新通道白名单、未登记文档 access_denied、返回值不含媒体路径 | - |
| V-AUDIO-01-4 | static | required | pnpm exec tsc --noEmit -p tsconfig.json 与 tsconfig.node.json | - |

### T-AUDIO-02 预览列表试听与原始音频面板

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AUDIO-03, R-AUDIO-05 |
| 验收 | AC-AUDIO-03-1, AC-AUDIO-03-2, AC-AUDIO-03-3, AC-AUDIO-03-4, AC-AUDIO-03-5, AC-AUDIO-05-1, AC-AUDIO-05-2 |
| 依赖 | T-AUDIO-01 |
| 写集 | src/services/subtitle-studio/cue-audio-player.ts, src/services/subtitle-studio/cue-audio-player.test.ts, src/store/tools/subtitle-studio/preferences.ts, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueAudio.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueTable.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueMenu.tsx, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/locales/, electron/main/test-window-mode.ts, test/subtitle-studio/cue-audio-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-AUDIO-01：同一工作树 027f010+未提交改动，主进程截取与 IPC 测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-AUDIO-02.md |
| 集成版本 | - |

#### 实现要点

按 design.md「渲染端播放器」与「UI（设计基准）」：单例播放器（LRU 6、过时请求丢弃、rAF 进度、stopAll）、余量偏好、`#` 列叠放按钮、工具栏“原始音频”弹出面板、P 键与菜单项、帮助项、无媒体提示、文档切换/卸载停止；测试窗口模式静音；四语文案。初版后实际渲染审查并修复复验。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AUDIO-02-1 | unit | required | node node_modules/vitest/vitest.mjs run src/services/subtitle-studio/cue-audio-player.test.ts：toggle/stop、过时请求丢弃、LRU 6 与 revokeObjectURL、修订号变化不命中缓存、错误态 | - |
| V-AUDIO-02-2 | browser | required | 构建后 FUSIONKIT_STUDIO_E2E=1 运行 test/subtitle-studio/cue-audio-ui.test.ts 预览列表部分：转写文档悬停播放→playing→自然结束；P 键相邻多选；A→B 切换；切换文档停止；同名匹配 SRT；无媒体 SRT 提示→选择文件（stub）后可播；余量切换；放大预览中 P；编辑中按 P 不播放；quiet 模式 mute-audio 已启用 | - |
| V-AUDIO-02-3 | manual | required | 查看 1280×860 浅色与 786×660 深色截图：行悬停、播放中进度、弹出面板已关联/未关联、菜单项；检查行高/列宽不变、对齐、截断、焦点与弹出面板边界，发现问题修复后重新截图复验 | - |
| V-AUDIO-02-4 | static | required | pnpm exec tsc --noEmit 两个配置；node scripts 中现有 i18n 检查（如有）或四语键一致性比对 | - |

### T-AUDIO-03 AI 修订与一致性检查中的试听

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AUDIO-04 |
| 验收 | AC-AUDIO-04-1, AC-AUDIO-04-2, AC-AUDIO-04-3 |
| 依赖 | T-AUDIO-02 |
| 写集 | src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioCueRevision.css, src/pages/Tools/Subtitle/SubtitleStudio/StudioConsistencyCheck.tsx, src/pages/Tools/Subtitle/SubtitleStudio/StudioConsistencyCheck.css, src/pages/Tools/Subtitle/SubtitleStudio/index.tsx, src/locales/, test/subtitle-studio/cue-audio-ui.test.ts |
| 负责人 | Claude |
| 依赖确认 | T-AUDIO-02：同一工作树 027f010+未提交改动，播放器与预览列表 UI 测试通过后开发 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-AUDIO-03.md |
| 集成版本 | - |

#### 实现要点

复用 `CueAudioButton`：修订改字建议按 `cueIds`，结构建议按 design.md 的范围规则；按钮点击不切换复选框；一致性检查出现项按出现文档请求；对话框关闭 `stopAll`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AUDIO-03-1 | browser | required | test/subtitle-studio/cue-audio-ui.test.ts 修订/一致性部分：prepared 结构建议（合并、改时间）播放请求范围正确且勾选不变；改字建议播放；跨文档出现项播放与无媒体文档的不可用提示；关闭对话框停止 | - |
| V-AUDIO-03-2 | manual | required | 查看修订结果与一致性检查截图（1280 浅色、786 深色）：按钮与序号对齐、不挤压文字、播放中状态可辨，问题修复后复验 | - |

### T-AUDIO-04 集成回归与文档

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I1 |
| 需求 | R-AUDIO-01, R-AUDIO-02, R-AUDIO-03, R-AUDIO-04, R-AUDIO-05 |
| 验收 | AC-AUDIO-01-4, AC-AUDIO-03-4, AC-AUDIO-05-1 |
| 依赖 | T-AUDIO-03 |
| 写集 | CHANGELOG.md, README.md, test/subtitle-studio/transcription-preferences.test.ts, docs/features/studio-cue-audio/ |
| 负责人 | Claude |
| 依赖确认 | T-AUDIO-03：同一工作树 027f010+未提交改动，修订/一致性 UI 测试通过后回归 |
| 完成日期 | 2026-10-11 |
| 实施记录 | records/T-AUDIO-04.md |
| 集成版本 | - |

#### 实现要点

运行字幕工作台相关单元/接口/provenance 回归与受影响的既有 Studio Electron UI 测试，确认与已知的既有失败一致；更新 CHANGELOG 0.4.0 条目与 README「运行测试」的静音说明（API 速查不列 Studio 方法，不适用）；写记录。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-AUDIO-04-1 | integration | required | node node_modules/vitest/vitest.mjs run test/subtitle-studio test/subtitle-studio-provenance src/subtitle-studio src/services/subtitle-studio src/pages/Tools/Subtitle electron --maxWorkers=4 --minWorkers=1：除记忆中已知的既有失败外全部通过 | - |
| V-AUDIO-04-2 | browser | required | FUSIONKIT_STUDIO_E2E=1 运行 cue-audio-ui、preview-expansion-ui、cue-structure-ui、cue-structure-revision-ui、cue-revision-ui、consistency-ui、context-menu-ui、cue-editing-ui、library-ui、interaction-copy-ui，确认放大预览、菜单、修订、一致性与文件名显示未回归，测试过程静音、不抢焦点 | - |
