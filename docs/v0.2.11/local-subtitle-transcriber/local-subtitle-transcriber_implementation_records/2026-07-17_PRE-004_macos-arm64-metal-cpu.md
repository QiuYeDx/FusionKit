# 工作包 PRE-004：macOS arm64 Metal/CPU PoC

## 基本信息

- 日期：2026-07-17
- 状态：已完成
- 对应执行计划工作包：`local-subtitle-transcriber_execution_plan.md` / `PRE-004`
- 目标环境：macOS 26.2 / Apple M5（10-core CPU、10-core GPU）/ 16 GB / arm64

## 本次认领边界

- 包含：从精确上游提交构建 macOS arm64 Metal-enabled official
  `whisper-server`；在 packaged-like 资源路径检查架构、依赖、可执行位与签名；使用
  `large-v3-q5_0` 跑相同 3 个中/日真实样本的 Metal/显式 CPU；采集 backend、RTF、
  RSS、模型复用、取消、语言检测、raw transcript validity 和 SRT/LRC 回读；定义诚实
  fallback 边界。
- 不包含：完整 Electron DMG/ZIP、bundled FFmpeg/ffprobe、Developer ID 凭据、公证、
  更新/回滚、production resolver/IPC/UI、人工制造 Metal 故障或 OOM。
- backend、性能、packaged-like 与最终有界窗口字幕有效性均已通过。Developer ID、
  公证和 Gatekeeper accepted 只在未来采用公开无警告分发时由 `QA-004` 验收，不是
  PRE-004 blocker。

## 固定源码、构建与模型

| 资产 | 固定值 | 结论 |
| --- | --- | --- |
| whisper.cpp | `v1.9.1` / `f049fff95a089aa9969deb009cdd4892b3e74916` | 精确 tagged shallow clone；构建元数据和最终二进制均含 `f049fff` |
| staged server | 3,611,408 B / `4a27a3058d43dff4f763aaf4fc8cb3726460dee145f55a4e520dc4e5a7354f1a` | thin arm64、可执行、Metal library embedded |
| `ggml-large-v3-q5_0.bin` | 1,081,140,203 B / `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1` | 与 PRE-003 使用同一公开模型 |

固定构建参数：

```text
CMAKE_OSX_ARCHITECTURES=arm64
BUILD_SHARED_LIBS=OFF
GGML_NATIVE=OFF
GGML_METAL=ON
GGML_METAL_EMBED_LIBRARY=ON
WHISPER_BUILD_SERVER=ON
```

macOS v1.9.1 没有可直接采用的官方预编译 server，因此此候选需要受控 source build；
这不等于 FusionKit 需要编写 C++ runner。Node 仍直接管理上游 official server HTTP
合同。

## 本次实现

- `process-metrics.mjs` 新增 POSIX exact-PID RSS 采样；Metal 只有同时观察到有界
  initialization 与 device 诊断、且没有 failure marker 时才是 verified。正向证据
  在采样间单调累积，避免启动日志被 64 KiB 诊断窗口淘汰后误报；任何后续 failure
  marker 都会永久否决本次运行。
- `run-poc.mjs` 与 `run-backend-probe.mjs` 支持显式 `metal`；CPU 继续传
  `--no-gpu`，Metal 未验证时返回 `backend_unverified`，不能凭 `/health` 或文件名
  宣称 GPU。
- 新增 `verify-macos-runtime.mjs`，检查 bundle containment、可执行位、thin arm64、
  x64 artifact 缺失、Mach-O 动态依赖、严格签名和 Gatekeeper，并把 packaged-like
  readiness 与 release readiness 分开。
- 修复 supervisor 跨平台测试：使用宿主原生 `node:path` fixture 和
  `path.delimiter`，不再把 Windows 字面路径交给 macOS 的 `path.dirname()`。
- 新增两个 FusionKit pitfall：无 `.git` 的上游 tar 解压目录会继承祖先 FusionKit
  Git metadata；跨平台 Node 测试不能混用外来路径字面量与宿主 path helpers。
- 用户复核原始结果后新增 `FK-PIT-0031`：SRT/LRC parse-back 只证明序列化结构，不能
  代替 raw transcript 的重复、时间轴、媒体边界和覆盖有效性检查。
- 新增 PCM frame 精确窗口、raw transcript gate、有界拆短重试和 owned-core overlap
  merge。原媒体只由 FFmpeg 规范化一次；30 秒窗口使用 5 秒 overlap，同一 server/model
  进程处理全部独立请求。
- 定位并修复 v1.9.1 VAD 双时间轴：segment 时间已映射回原媒体，但 token/word 时间仍
  在去静音后的压缩时间轴。VAD 请求强制 `token_timestamps=false`，parser 丢弃 words；
  merge 再拒绝越出 parent segment 的 word 时间并回退到 segment。

## 源码 provenance 事故与修正

第一次从 codeload tar 解压到 FusionKit ignored 子目录后，CMake 的 `git rev-parse`
向祖先目录查找，错误把 FusionKit `7c0b2eb` 写进 whisper/ggml build metadata。该
产物被判定为不可用，没有进入 staged runtime 或脱敏结果。

随后重新从上游做精确 v1.9.1 shallow clone，确认完整 HEAD 为
`f049fff95a089aa9969deb009cdd4892b3e74916`，再从全新 build directory 配置和编译。
生成的 `whisper-config.cmake`、`ggml-config.cmake` 与 staged binary 均显示
`f049fff`。这一检查成为后续 native artifact manifest 的必需 provenance 门禁。

## Backend 与性能运行结果

以下数值证明同一 arm64 artifact 的 Metal/CPU backend、资源占用、复用与取消行为，
但来自后来判定为内容退化的整段单请求策略。它们不是最终窗口化产品策略的性能承诺，
修复后必须重新采集。

### Metal

冷启动 backend probe 首次加载约 7,453 ms；样本批次启动时模型已进入系统文件缓存，
server load 约 527 ms。三个正常请求使用同一 PID、一次模型加载，Metal 初始化与
device 诊断可见且无失败标志；峰值 RSS 2,510,077,952 B。Apple unified memory 下
没有把 RSS 伪装成独立 VRAM 数值。

| 样本 | 语言 | 媒体时长 | 耗时 | RTF | cue |
| --- | --- | ---: | ---: | ---: | ---: |
| `ja-character-pv-bgm-medium` | ja | 230.229 s | 18.506 s | 0.0804 | 79 |
| `ja-audio-drama-frequent-silence-medium` | ja | 753.390 s | 106.816 s | 0.1418 | 460 |
| `zh-character-pv-bgm-medium` | zh | 235.221 s | 33.757 s | 0.1435 | 104 |

5,000 ms 取消探针在约 6 ms 后结算为 `aborted`，立即健康检查通过；下一任务合同仍
固定重启 server，不能把健康响应当作底层 inference 已完全收敛的证明。

### 显式 CPU fallback

同一 arm64 artifact 通过 official `--no-gpu` 启动。backend probe 加载约 423 ms，
样本批次加载约 435 ms；三个正常请求复用同一 PID/一次模型加载，峰值 RSS
2,957,639,680 B。

| 样本 | 语言 | 媒体时长 | 耗时 | RTF | cue |
| --- | --- | ---: | ---: | ---: | ---: |
| `ja-character-pv-bgm-medium` | ja | 230.229 s | 41.804 s | 0.1816 | 70 |
| `ja-audio-drama-frequent-silence-medium` | ja | 753.390 s | 222.806 s | 0.2957 | 187 |
| `zh-character-pv-bgm-medium` | zh | 235.221 s | 61.141 s | 0.2599 | 98 |

CPU 仍全部快于实时，但在本机比 Metal 慢约 1.81～2.26 倍。该区间只作为首个产品
提示证据，不能外推为所有 Apple Silicon 的固定承诺。5,000 ms 取消探针在约 5 ms
后结算为 `aborted`。

两个 backend 的语言检测均匹配 ja/zh，生成 SRT 与标准 LRC 均由独立 parser 回读。
首轮只抽查每个结果开头几段，错误地把“开头可读 + parse-back”当成整体通过；后续
全量检查确认 raw `verbose_json` 已严重退化。

## 整段字幕有效性失败与定位

| backend / 样本 | raw 失效证据 |
| --- | --- |
| Metal / 日文长音频 | `405.52～753.52 s` 连续 347 段重复同一句；该句总计出现 352 次，后半段真实语音丢失 |
| Metal / 中文 PV | `63.86～217.86 s` 连续 77 段重复 |
| Metal / 日文 PV | `196.60～225.60 s` 连续 14 段重复 |
| CPU / 中文 PV | `61.80～106.88 s` 连续 43 段重复 |
| CPU / 日文长音频 | 多处重复和零时长 segment；末 cue 到 `781.28 s`，超过媒体约 `27.89 s` |

重复在上游 raw response 中已经存在，不是 `createSmokeCues()`、SRT formatter 或 LRC
formatter 引入。FFmpeg 输出覆盖完整媒体，故障区间也有持续变化的真实语音；不能通过
删除重复行恢复 decoder 锁死期间漏掉的内容。

对照结果如下：

- 关闭 token timestamps 后中文最长重复增至 131 段；关闭 flash attention 仍有 65
  段；`max_len=1000` 仍为 131 段，均未解决。
- `beam_size=5` 把最长重复降到 3 段，但把开头约 30 秒写成另一条常见网络视频幻觉；
  同版本 `whisper-cli` 默认 beam 也有类似新幻觉和漏识别，不能直接作为修复。
- 保持原 greedy 参数，分别独立推理中文 `0～30 s`、`60～90 s` 和日文长音频
  `405～435 s`，均恢复实际变化内容。

直接故障面因此定位为：一个整段 HTTP inference request 的 decoder 状态会在后续内部
窗口锁死。Metal 改变严重程度但不是唯一触发条件；同一 backend/model 对独立有界窗口
可以正常识别。

## 最终修复与完成证据

最终候选固定为：一次性 FFmpeg 规范化到 16 kHz mono PCM16；按 PCM frame 生成 30 秒
窗口和 5 秒 overlap；每窗使用独立 decoder 请求但复用同一 model/server；raw segment
在 formatter 前检查连续重复、零/负时长、倒序、重叠、窗口/媒体越界和 15 秒以上单段；
退化窗口最多递归拆短 3 层；合并按 owned core、边界文本和整数毫秒确定性仲裁。

Silero VAD 能让 `600～630 s` 静音窗口返回 0 段，但第一次接入后输出整体提前。检查
ignored raw windows 后确认 server 的 segment `13.70～17.28 s` 已正确对应原窗口
`638.70～642.28 s`，只有 words 仍从压缩时间轴 `0 s` 开始。最终实现关闭 VAD token
timestamps，只用 mapped segment 时间；并增加跨层测试防止未来适配器重新传入错轴 words。

最终 3 样本矩阵：

| backend / 样本 | RTF | raw / cue | retry | 最长连续重复 | raw 时间轴错误 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Metal / 日文 PV | 0.0821 | 65 / 57 | 0 | 1 | 0 |
| Metal / 日文长音频 | 0.0698 | 168 / 136 | 3 | 2 | 0 |
| Metal / 中文 PV | 0.0759 | 86 / 74 | 0 | 2 | 0 |
| CPU / 日文 PV | 0.2811 | 67 / 59 | 0 | 1 | 0 |
| CPU / 日文长音频 | 0.2129 | 166 / 136 | 4 | 1 | 0 |
| CPU / 中文 PV | 0.1954 | 85 / 73 | 0 | 2 | 0 |

- Metal 峰值 RSS 1,870,495,744 B，CPU 峰值 RSS 2,034,991,104 B；CPU 比 Metal 慢
  约 2.57～3.42 倍，仍全部快于实时。
- 两个 backend 的长音频均在 `600～630 s` 返回空窗口，随后从约 638.70 s 恢复
  “そういえばさ、お風呂どうする?”，并持续识别到 738.84 s；没有原来的静音短幻觉、
  后半段中断或媒体越界。
- Metal/CPU 分别以同一 PID/一次模型加载完成 56/58 个成功窗口请求；语言检测和所有
  SRT/标准 LRC 回读通过。5 秒取消分别在 2/6 ms 后结算为 `aborted`，健康探针通过，
  下一任务合同仍固定 restart server。
- 人工复核 `400～440 s`、`600～670 s`、媒体尾部和 3 个样本参考字幕；最长 2 cue
  的短重复对应真实连续台词或合法窗口边界，不是 decoder loop。

## fallback 与平台边界

- auto 只有在 batch commit 前完成 backend 解析并显示 CPU 性能提示，才可从 Metal
  候选解析为 CPU；显式 Metal 不允许静默降级。
- 显式 Metal 没有 positive initialization/device evidence 时稳定返回
  `backend_unverified`；CPU 则由实际 `--no-gpu` 参数证明。
- macOS x64 validator 返回 `unsupported_architecture`，packaged-like resource 中
  x64 artifact count 为 0；不生成 Rosetta 或独立 x64 CPU runner。
- 取消后下一任务重启 server；正常任务继续跨文件复用模型。

## Packaged-like 与发行能力边界

- staged relative path 为 `mac-arm64/metal/whisper-server`，可执行位保留。
- Mach-O 只有 arm64 slice；8 个动态依赖全部来自系统 Framework 或 `/usr/lib`。
- ad-hoc `codesign --verify --strict` 通过，签名没有 TeamIdentifier。
- 本机 codesigning identity inventory 为 0；`spctl --assess` 返回 rejected / exit 3。
- 因此 `packagedLikeReady=true`、`releaseReady=false`。Gatekeeper rejected 仅记录当前
  未采用的公开无警告分发能力；`pre004Gate=false`，owner 为未来 `QA-004`。

ad-hoc 签名只证明文件在当前 staged 形态下完整可执行，不能替代 Developer ID、
notarization、完整 Electron app 签名顺序或最终 DMG/ZIP 验收；反过来，缺少这些发行
能力也不影响本地开发运行，不应阻塞 PRE-004 的功能与 packaged-like 验证。

## 隐私与本地资产

- 脱敏汇总在 `poc/pre004-macos-arm64-results.json`；不含 hostname、用户名、绝对
  路径、PID、签名身份、媒体/字幕正文、模型字节或 native binary。
- 真实 inventory、模型、源码 clone/build、staged runtime、原始 JSON 与生成字幕均
  留在 `*.local` 忽略目录。
- 模型和 native runtime 未进入 Git；没有运行 `pnpm install`，pnpm lockfile 未改动。
- provenance 错误的 tar 解压/build 已删除；模型合并通过固定 SHA-256 后删除冗余
  `.part`/range 分块。结束检查无 whisper-server、FFmpeg、curl、
  `fusionkit-whisper-server-*` 临时目录或前端/Electron 服务残留。

## 验证

```text
node --test scripts/local-subtitle/benchmark/*.test.mjs scripts/local-subtitle/whisper-server/*.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict --inventory <ignored inventory>
node scripts/local-subtitle/whisper-server/run-backend-probe.mjs <ignored Metal/CPU arguments>
node scripts/local-subtitle/whisper-server/run-poc.mjs <ignored Metal/CPU arguments>
node scripts/local-subtitle/whisper-server/verify-macos-runtime.mjs <ignored packaged-like arguments>
git diff --check
```

最终 Node 测试 42/42 通过；结构与真实 inventory 严格清单校验均为 0 error / 0
warning；`git diff --check` 与 JSON 解析通过。runtime verifier 预期 exit 2，因为它仍
如实区分 `packagedLikeReady=true` 与 `releaseReady=false`；PRE-004 汇总不再把该
release-only 状态转换为 blocker。

## 下一步

- `PRE-004` 已解除全部开发 blocker；禁止回退到整段请求或 VAD word 时间轴。
- `PRE-005` 继续冻结 bundled FFmpeg/ffprobe、完整 native resource manifest、许可、
  `extraResources` staging 和无系统 PATH smoke。
- Developer ID、公证和 Gatekeeper accepted 仅在产品选择公开无警告分发时进入
  `QA-004`；不影响 PRE-004 完成结论。
- `PRE-005` 完成后由 `PRE-006` 冻结 macOS source-build artifact 获取方式和跨平台
  runtime manifest，再进入 production 实现。
