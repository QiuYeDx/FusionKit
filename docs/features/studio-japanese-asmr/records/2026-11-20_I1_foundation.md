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

## 初次验证的阻塞

上游 `Whisper-Vad-EncDec-ASMR-onnx` 二进制下载在本机网络环境中多次超时，尚未完成真实模型的输入张量、输出形状、概率语义和目标 Electron 宿主冒烟。模型固定版本、字节数和 SHA-256 仍需从上游成功取得后写入资源清单。真实音频质量、Turbo 对照和端到端任务链路保持待验证。

## 初次验证后的计划

取得固定版模型与元数据后，完成 Electron CPU 冒烟，接入共享资源事务和两阶段执行器，再接 Studio 模式选择、资源状态、阶段进度与待听校入口。

## 2026-11-20 下载重试与实际模型冒烟

- 固定修订 `6963d4305de71a565ef84ecce4e14982b27371d4`。本机系统 DNS 返回的地址仍连接超时。使用独立 DNS 查询返回的地址临时解析官方域名，保留 HTTPS 证书校验，跟随官方 CDN 重定向下载成功。
- 实测 `119137398` 字节，SHA-256 为 `cd47513515766d57f740e3094440dbbca9ab87e026b9cf21540d7ad588c0e047`，均与同一修订的 Git LFS 指针一致。模型保存在忽略目录 `test-results/studio-japanese-asmr/upstream/model.onnx`。
- macOS arm64 的 Electron 41.10.6 隔离宿主以 ONNX Runtime 1.21.1 CPU 加载并运行完整模型。输入 `input_features` 为 float32 `[1,80,3000]`，输出 `frame_logits` 为 float32 `[1,1500]`，每帧 20 ms，应用 sigmoid 后得到概率。
- 对照固定修订的 `inference.py` 与 Transformers 4.55.4 的 CPU `WhisperFeatureExtractor`，修正 Slaney mel 滤组、Hann 窗与固定窗口零填充。641 样本边界脉冲与带首尾静音的 Kyoko 日语合成语音。两种输入的最大特征绝对差分别为 `1.20e-7` 和 `8.71e-6` 以下。有效帧内的最大概率绝对差均小于 `2.41e-6`。
- 641 样本的末窗返回 3 帧，122389 样本返回 383 帧，完整 30 秒窗口返回 1500 帧。验证了会话释放等待正在进行的推理，重复释放复用同一结果，释放后拒绝继续运行。本地证据位于 `test-results/studio-japanese-asmr/smoke-result.json`。
- 下载阻塞已解除。T-JASMR-01 仍在进行，待验证跨窗拼接、故障退出、目标平台覆盖与带标注的真实日语 ASMR 素材效果。
