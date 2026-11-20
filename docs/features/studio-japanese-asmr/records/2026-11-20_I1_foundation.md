# I1 实施记录 · 契约与 ONNX 打轴基础

日期：2026-11-20

基线提交：`v0.6.0`，文档提交：`182c8233`

## 已完成

- 新增可选的 `standard` / `japanese_asmr` 转写模式字段，省略字段时继续走标准模式。
- 日语 / ASMR 模式固定 `anime-whisper-q8_0`、`ja`、转写任务和 VAD，主进程模型能力校验允许该专用两阶段组合。
- 新增 ONNX Runtime Node CPU 依赖 `onnxruntime-node@1.21.1`，通过项目固定的 pnpm `8.7.0` 写入锁文件。
- 新增 Whisper 30 秒、16 kHz、80 × 3000 的 CPU log-mel 输入生成，以及 ONNX 会话适配器。
- 新增概率帧的迟滞检测、最短停顿合并、整数帧半开区间和超长区间待听校标记。

## 验证证据

- `corepack pnpm@8.7.0 exec vitest run test/subtitle-studio/transcription/japaneseAsmrContract.test.ts test/subtitle-studio/transcription/japaneseAsmrSegmentation.test.ts test/subtitle-studio/transcription/whisperLogMel.test.ts` 通过，10 个测试通过。
- 相关回归测试通过，73 个测试通过，覆盖配置、IPC、模型能力和共享资源清单。
- `corepack pnpm@8.7.0 exec tsc --noEmit` 通过。
- `onnxruntime-node` 的 Node 和 `ELECTRON_RUN_AS_NODE=1` 宿主加载检查通过，确认 Electron 可加载 CPU 会话 API。

## 待验证与阻塞

上游 `Whisper-Vad-EncDec-ASMR-onnx` 二进制下载在本机网络环境中多次超时，尚未完成真实模型的输入张量、输出形状、概率语义和目标 Electron 宿主冒烟。模型固定版本、字节数和 SHA-256 仍需从上游成功取得后写入资源清单。真实音频质量、Turbo 对照和端到端任务链路保持待验证。

## 下一步

取得固定版模型与元数据后，完成 Electron CPU 冒烟，接入共享资源事务和两阶段执行器，再接 Studio 模式选择、资源状态、阶段进度与待听校入口。
