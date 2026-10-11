# 实施记录：T-AUDIO-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-AUDIO-01 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:cc135b2eb4b30173819c6ac762131076f37aa00941676bceb9f9b2d64d23dd74 |
| 环境 | Windows 11 Pro 10.0.26200，Node（项目 pnpm 依赖），Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet，mute-audio），随应用 FFmpeg n8.1.2-21-gce3c09c101-20260630（开发环境 build/subtitle-studio-resources），无网络服务；模型请求为本机受控模拟服务 |
| 任务指纹 | 12de91d6ac05d4ac89309d0300da44fb6593eeba516dc2292add2748f1344da2 |

## 实际结果

新增 `src/subtitle-studio/cue-audio.ts`（扩展名、同名匹配、时间段解析、请求 schema、WAV 头）、`electron/main/subtitle-studio/cue-media-service.ts`（手动关联 > 转写来源 > 同名匹配，每次复核身份，私有 `cue-media.private.json`）、`cue-audio-clip.ts`（会话级运行时校验缓存、`selectCueAudioFfmpeg`、FFmpeg 截取到内存、窗口级票据与取消）；四个 IPC 方法与 preload 白名单；`index.ts` 组合审计已更新。真实 FFmpeg 集成测试：WAV/MKV/MP3 截取 9.5–10.5 s 的长度与频率位置正确；25 分钟 MP3 在 25:00.250 截 4.5 s 用时 71–80 ms；LRC 未知结束、同级冲突、手动关联重启保持、移动/修改不可用、无音轨/损坏/运行时缺失、运行中解码被新请求终止、工作目录无残留均按预期。转写冻结副本未改动（provenance 重放通过）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-AUDIO-01-1 | 通过 | file:records/audio-01-contract.log |
| V-AUDIO-01-2 | 通过 | file:records/audio-01-ffmpeg.log |
| V-AUDIO-01-3 | 通过 | file:records/audio-01-ipc-provenance.log |
| V-AUDIO-01-4 | 通过 | file:records/static.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-AUDIO-01-1 | 通过 | V-AUDIO-01-2 |
| AC-AUDIO-01-2 | 通过 | V-AUDIO-01-1, V-AUDIO-01-2 |
| AC-AUDIO-01-3 | 通过 | V-AUDIO-01-2, V-AUDIO-01-3 |
| AC-AUDIO-01-4 | 通过 | V-AUDIO-01-3 |
| AC-AUDIO-02-1 | 通过 | V-AUDIO-01-2 |
| AC-AUDIO-02-2 | 通过 | V-AUDIO-01-1, V-AUDIO-01-2 |
| AC-AUDIO-02-3 | 通过 | V-AUDIO-01-2 |
| AC-AUDIO-02-4 | 通过 | V-AUDIO-01-2 |

## 风险与未执行项

只在 Windows 开发环境运行时验证；macOS 打包运行时未实测（选择规则与转写一致）。多音轨文件固定第一条音轨（已知限制，A-03）。网络盘或超大文件的首次跳转耗时未测，以 20 秒超时兜底。文件移动后在打开的文件句柄层面没有 dirfd 级保证，与现有来源回执同为路径+身份复核。
