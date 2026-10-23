# 协调者修补记录（2026-10-22）

T-ASRQ-09 对照与各任务评审之后，由协调者直接做的小范围修补。不是独立任务，界面渲染复核随整体回归一起做（见 records/regression.md）。

## 改动

1. 预设标为实验性（依据 records/T-ASRQ-09.md：两个预设在非语音负对照 B-noise 上都新增了文字，标准无字）。
   - `src/pages/Tools/Subtitle/SubtitleStudio/StudioTranscription.tsx`：音频类型下拉中“低音量·耳语”“嘈杂·音乐音效”加“实验性”标记（复用 `studio:transcription.model_experimental`，`data-testid="studio-transcription-audio-experimental"`）。
   - `src/locales/{zh,zh-Hant,en,ja}/studio.json`：`audio_quiet_hint`、`audio_noisy_hint` 改为以“实验性”开头，说明在没有人声的声音上也可能编造文字、请用“待复核”逐句检查。原 `audio_noisy_hint` 写的“提高语音检测门槛”与实际参数不符（noisy_music_v1 的 vad_threshold 为 0.45，低于默认 0.5），一并改为“略放宽语音检测”，并去掉“减少音乐和音效上的误识别”这一未被对照证实的说法。
2. 模型下拉宽度（T-ASRQ-07 渲染时发现的 T-ASRQ-06 问题）：`StudioTranscription.css` 中 `.studio-transcription-model-options` 的最大宽度改为不小于触发器宽度，避免宽触发器下说明被裁切；音频类型选项与模型选项共用“名称 + 标记”的样式。
3. 重新识别的默认模型（T-ASRQ-07 评审遗留）：`src/subtitle-studio/ipc-contract.ts` 的文档摘要新增可选 `transcriptionModelId`（取自媒体文档保存的转写稿），`StudioCueRecognize.tsx` 在“本次会话上次的选择”之后优先使用它，再退回会话内任务与转写设置。
4. Home Agent 错误文案（T-ASRQ-08 评审遗留）：`src/pages/HomeAgent/components/action-error.ts` 为 `studio_transcription_model_{recognize_only,translate,prompt,language}` 映射专门文案，`src/locales/*/home.json` 新增对应四条。

5. 仅重识别剪辑的填充不越过相邻字幕（records/T-ASRQ-10.md 发现：Belle 19 句中 5 句开头带进紧邻上一句的词，anime-whisper 疑似 2 句）：`electron/main/subtitle-studio/cue-recognize-service.ts` 新增 `cueRecognizePadBounds`，`cueRecognizeClipRange` 接受 `{notBeforeMs, notAfterMs}`；仅重识别模型与有时间戳模型的“单独再听一次”都在前一条字幕结束处、后一条字幕开始处截止。`test/subtitle-studio/cue-recognize.test.ts` 新增边界与“紧邻字幕”用例，并把“单独再听一次”的剪辑长度期望由 1.4 s 改为 1.2 s（相邻字幕 2.4 s 结束、3.6 s 开始）。`npx vitest run test/subtitle-studio/cue-recognize.test.ts`：10 项通过、1 项跳过；`tsc` exit 0。真实音频复跑未做（改动只缩短剪辑，T-ASRQ-10 的 28 句听审清单仍按原剪辑生成）。

## 验证

- `npx tsc --noEmit -p tsconfig.json`：exit 0。
- `node scripts/check-i18n.mjs`：exit 0；`check-i18n-usage.mjs`：仍为既有的 40 条（与 HEAD 相同，无新增）。
- `npx vitest run --maxWorkers=4 --minWorkers=1 src/pages/HomeAgent test/subtitle-studio/{acceptance-source-output,automatic-export,bilingual-import,export-planner,translation-service,cue-recognize,transcription-controller,transcription-model-profiles}.test.ts src/pages/Tools/Subtitle/SubtitleStudio`：18 个文件、271 项通过，1 项跳过。
- 界面渲染（音频类型下拉、模型下拉、重识别默认模型）由整体回归中的 audio-profile-ui、model-profile-ui、cue-recognize 相关 UI 用例与截图复核覆盖，见 records/regression.md。
