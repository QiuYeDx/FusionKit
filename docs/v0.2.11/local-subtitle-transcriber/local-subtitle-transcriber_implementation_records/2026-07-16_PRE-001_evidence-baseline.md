# 工作包 PRE-001：基准语料、工具链与 clean-room 证据基线

> 最终收口（2026-07-16）：本记录保存首次方案的历史过程，其中关于广泛语料、
> 独立真值、FasterWhisperGUI/CTranslate2 baseline 和严格失败门禁的要求已废弃。
> 当前有效结论见 `2026-07-16_PRE-001_scope-reduction-and-completion.md`：PRE-001
> 已完成，下一步为 PRE-002。
>
> 后续进展（2026-07-16）：Windows CPU/CUDA scoped reports、3 段真实媒体、
> 3 份 FasterWhisperGUI baseline output 和 `.local` inventory 已补入；详情见
> `2026-07-16_PRE-001_real-corpus-and-prebuilt-readiness.md`。本记录下方的
> “Windows 尚未验证 / 5 个真实语料全 pending”是首次建立基线时的历史事实，
> 不代表当前台账。

## 基本信息

- 日期：2026-07-16
- 状态：已完成（历史阶段记录；最终结论见范围收口记录）
- 对应执行计划工作包：`local-subtitle-transcriber_execution_plan.md` / `PRE-001`
- 目标平台/硬件：本次仅生成 macOS arm64 主机报告；macOS x64 已从支持范围移除，Windows x64 CPU/CUDA 和真实 NVIDIA 硬件尚未验证

## 本次认领边界

- 包含：样本覆盖清单、固定 baseline 参数、指标合同、第三方候选、clean-room 规则、PoC 记录模板、跨平台只读工具链预检、严格样本 inventory/hash 门禁和本机报告。
- 不包含：真实媒体/模型下载、runner/CMake 工程、FFmpeg staging、IPC、Store、页面、字幕导出或翻译交接实现。

## 本次实现内容

- 建立 6 个稳定样本槽位，覆盖日/英/中、多语言、BGM、长静音、噪声、抢话、低音量、纯静音、音频/视频、长短媒体和非 ASCII 路径。
- 以纯 Node 生成固定 10 秒、16 kHz mono PCM16 静音 WAV，使用非 ASCII leaf 并固化 size/SHA-256；仓库只提交生成器，不提交媒体，该样本已标记 `ready`。
- 固定 `faster-whisper==0.10.0` + CTranslate2 `large-v3` 的中性比较参数；模型和本地参考快照 SHA-256 未采集前保持 pending。
- 定义 CER/WER、语言检测、cue 边界 MAE、RTF、RAM/VRAM、首次/复用加载、取消延迟、包体和 SRT/LRC parse-back 口径。
- 新增结构校验与严格就绪两级门禁。严格模式要求真实样本 size/hash/license、参考文本 hash 和 `.local` inventory，并只在错误中返回 sample ID，不输出路径。
- 新增 macOS arm64、Windows x64 CPU/CUDA 三个预检 profile；macOS x64 返回稳定 `unsupported_architecture`。探测命令使用最小环境 allowlist，不安装软件、不运行 pnpm install、不改 lockfile。
- 冻结发布版 FFmpeg/ffprobe 合同：用户无需安装系统 FFmpeg；平台二进制位于 asar 外并由版本化签名 manifest 校验，packaged 模式禁止 PATH/用户 executable fallback；build 缺件失败，runtime 缺失/损坏/启动失败在入队前阻断并保留用户数据。
- 记录 2026-07-16 上游候选：whisper.cpp `v1.9.1`、Silero VAD `v6.2.1`、FFmpeg `n8.1.2`，均保留 PRE-006 分发/许可结论门禁。
- 生成并刷新本机 macOS arm64 报告：Node `v20.19.5`、pnpm `8.7.0`、lockfile `6.0`、CMake `4.4.0`、Apple Clang `21.0.0`、Xcode `26.6`/Metal compiler、FFmpeg/ffprobe `8.1.2` 均可用，报告为 `ready`。
- 首次 FFmpeg/ffprobe 冷启动超过固定 5 秒而产生瞬时假 blocker；媒体工具 probe timeout 单独放宽至 15 秒并补测试断言，预热后重跑确认不是安装或动态库故障。

## 修改文件

- `scripts/local-subtitle/benchmark/preflight.mjs`
- `scripts/local-subtitle/benchmark/preflight.test.mjs`
- `scripts/local-subtitle/benchmark/validate-manifests.mjs`
- `scripts/local-subtitle/benchmark/validate-manifests.test.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/poc/*`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/feat/2026-07-16_local-subtitle-transcriber_arm64-only-and-bundled-ffmpeg.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/bundle-native-media-runtime-instead-of-system-path.md`

## 接口、状态或数据结构变化

- 新增版本化 `benchmark-manifest`、`baseline-profile`、`metrics-contract`、`third-party-candidates` 与 toolchain report v1 合同。
- `benchmark-manifest.requiredTargetProfiles` 收敛为 `mac-arm64-metal`、`windows-x64-cpu`、`windows-x64-cuda`。
- 新增 CLI：`preflight.mjs --target <profile> [--output <file>]`。
- 新增 CLI：`validate-manifests.mjs [--strict --inventory <file.json.local>]`。
- 未修改应用运行时类型、Electron IPC、renderer Store 或用户数据。

## 安全、隐私与许可证检查

- 路径/capability：真实媒体路径仅允许存在于 Git 忽略的 `.local` inventory；校验错误和提交报告不含绝对路径。未涉及应用 capability。
- 日志/持久化：预检报告不记录 hostname、username、完整环境或命令路径；仓库未加入媒体、字幕正文、模型、二进制或凭据。
- 第三方来源与许可：AGPL 参考项目固定为只读行为研究；whisper.cpp/VAD/模型/FFmpeg/CUDA 仍是候选，不把工程清单当作最终法律或分发结论。
- 用户环境：系统 FFmpeg 仅是当前开发/PRE PoC 工具链，不是发布版用户依赖；没有引入任意 executable/path 配置。

## 验证结果

执行命令：

```text
node --check scripts/local-subtitle/benchmark/preflight.mjs
node --check scripts/local-subtitle/benchmark/validate-manifests.mjs
node --check scripts/local-subtitle/benchmark/generate-synthetic-fixtures.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/generate-synthetic-fixtures.mjs --output <temporary-directory>
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict
node scripts/local-subtitle/benchmark/preflight.mjs --target mac-arm64-metal --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_mac-arm64-metal.json
git diff --check
```

结果：

- 通过：三个脚本语法检查；Node tests 16/16；synthetic WAV 生成结果为 320044 bytes 且 SHA-256 与 manifest 一致；结构校验 0 error、8 个 pending warning（5 个真实语料、baseline、2 个 Windows 目标报告）；macOS arm64 报告 ready；macOS x64 稳定错误测试通过。
- 预期失败：严格清单门禁 9 errors（5 个真实语料、baseline hash、2 个 Windows 目标报告、local inventory）。这些失败是 PRE-001 未完成的真实证据。
- 未运行及原因：没有真实样本/参考模型，不运行准确度或性能；无 Windows/签名环境，不生成对应报告。
- 真实硬件/packaged 范围：仅 macOS arm64 工具链只读探测；未运行 native runner、GPU 推理或 packaged app。

## 产生的证据

- benchmark/fixture/截图/日志摘要路径：`docs/v0.2.11/local-subtitle-transcriber/poc/`；本机报告位于 `poc/reports/2026-07-16_mac-arm64-metal.json`。
- 不应提交的本地产物位置与清理结果：只在系统临时目录生成过 deterministic silence WAV，验证后已删除；未下载模型、runner、FFmpeg，未留下媒体、临时 WAV、`.partial` 或测试服务器产物。

## 当时未完成事项与风险（已被最终收口取代）

- 当时计划补独立参考、样本权利证据和 baseline hash；最终产品范围评审确认这些不是 PRE-001 必需证据，已删除对应门禁。
- 当前 macOS arm64 PRE-001 工具链已 ready，不需要用户继续安装 CMake、Xcode/Metal 或 FFmpeg。当前 Homebrew GPL/full FFmpeg 仅可作开发 PoC，不能直接进入发行包。
- Windows x64 CPU/CUDA 目标机报告已在后续会话补齐并 ready；真实推理仍留给 PRE-003，不能由环境 probe 代替。
- `package.json` 尚未声明 `packageManager`；本次只记录 warning，未借机修改依赖元数据。

## 最终交接

- 当前 3 样本 strict inventory 与三个目标 profile 报告均已闭环，PRE-001 已完成；下一步进入 PRE-002。
