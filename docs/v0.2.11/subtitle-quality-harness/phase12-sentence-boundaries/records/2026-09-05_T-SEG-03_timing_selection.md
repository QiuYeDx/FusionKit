# T-SEG-03 / 03A / 03B：时间能力与实际模型对照

日期：2026-09-05。关联 R-SEG-02/03/05/07；[需求](../requirements.md)、[设计](../design.md)、[任务](../tasks.md)。

## 决定与生产影响

限定选型已完成；A/B 均未通过自动采用质量门。本轮没有替换生产引擎或接入新的默认词时间，T-SEG-01/02 停止比例硬切的成果继续保留。开头的句读与候选时间有改善，但低声漏词、音效添词及无效词时间阻止直接采用。全部增强字幕仍为实验产物，未经本轮人工听校，不称全轨修复完成。

用户提供约 6.17 GB 的实际模型并确认 GUI 使用 float16 后，完成同模型 FP16/FP32 对照；三个样本的文字和原始段边界一致。本机文件清单证明体积差异来自 FP32/FP16 浮点存储，张量名称和形状一致；不等于更大的模型架构，也未证明两份模型数值权重完全相同。用户随后明确：先不为较大模型增加额外适配。因此不安排 CTranslate2 模型导入、产品引擎适配或运行时打包，下一任务回到现有引擎的局部增强资格。

## 固定输入、环境与次数

三个输入固定为本次开头 55 秒、既有低声 B 30 秒、人工标记无词的 B-noise 18 秒。首轮 A/B 各 3 次；03A 复核已有低音量保护 2 次；03B 用户模型两种计算精度各 3 次、GUI 保存配置代理 3 次，合计 **17 次实际推理请求**。未继续调参，未以参考 LRC 为提示词。

- A：whisper.cpp v1.9.1，commit `f049fff95a089aa9969deb009cdd4892b3e74916`，现有完整 large-v3 GGML / CUDA。独立服务、`vad=false`、`token_timestamps=true`、beam 5、temperature 0、无历史上下文；DTW 未启用（`t_dtw=-1`）。保留静音输入，不消费原生产 VAD 压缩词轴。55 秒作为一次服务请求，区别于生产外层 30 秒窗口流程。
- B：faster-whisper 1.2.1 / CTranslate2 4.6.0 / CUDA float16。官方 `Systran/faster-whisper-large-v3` 固定 revision `edaa852ec7e145841d8ffdb056a99866b5f0a478`；beam 5、temperature 0、关闭 previous text、打开 word timestamps。VAD threshold 0.5、min silence 500 ms、pad 400 ms；min speech 默认 0。
- 03A：复用已保存、源身份核对过的 `phase10/production-limited/B.wav` 与 `B-noise.wav`，实际增益 12 dB；仅沿用既有增益路径的 pad 1000 ms，其余 B 参数不变。
- 用户模型：只读 `D:/Program Files/whisper-large-v3-float32/`。缺少 preprocessor 配置时，按实际加载的 `n_mels=128` 在进程内配置特征提取；未写回目录。分别断言实际 compute type 为 float16 / float32。
- GPU 为 RTX 4070 Ti SUPER 16 GB，用户其他应用继续运行。下载仅取公开模型资源；音频、字幕和用户模型没有上传。

私有原始响应、参数、哈希、运行 PID 及对照放工作区忽略目录 `test-results/subtitle-quality-review/phase12/selection/`。官方模型文件均验证来源哈希；NAS 三个原文件及用户模型目录四个文件在试验前后大小、时间及内容指纹不变。

## 结果

| 路线 | 开头 | 低声 B | B-noise | 采用判断 |
| --- | --- | --- | --- | --- |
| A：现有引擎独立非 VAD | 14 段 / 130 词单元；句读增加，7 处词区间异常 | 保留主体，但首词吞入静音，最长词 6.04 秒 | 重复输出 5 条呼气文字 | 不作自动词时间来源 |
| B：官方 FP16 | 8 段 / 109 词单元；有句读，词结构审计无异常 | 丢失已认可的前缀，仅余后半短语 | 空 | 开头有价值，召回门失败 |
| B 加已有输入保护 | 复用未增益开头结果 | 前缀变成错误文字，且词间跨长停顿 | 无词片段产生新词 | 兼容复核失败 |
| 用户模型 / float16 | 8 段 / 109 词单元；3 个零时长词 | 同样丢失前缀 | 空 | 不因文件更大自动采用 |
| 用户模型 / float32 | 与同模型 float16 文字及段起止相同，仍有 3 个零时长词 | 同样丢失前缀 | 空 | 本组无文字收益 |
| 用户模型 / GUI 保存参数代理 | 8 原始段，有标点；未请求词时间 | 同样丢失前缀 | 空 | 不是旧 GUI 的完整复现 |

B 加输入保护时，即使假词的各词区间全部正时长、落在父段内、文字覆盖正确，仍在无词片段添词。由此不能将结构审计结果直接作为语音存在判断。空结果也不能脱离人工标签被解释为静音。

## 模型体积与实际 GUI

| 比较项 | 官方候选 | 用户实际模型 |
| --- | --- | --- |
| model.bin 大小 | 3,087,284,237 bytes | 6,174,511,117 bytes |
| binary / spec | version 6 / WhisperSpec revision 3 | 相同 |
| 张量清单 | 1046 个，1,543,613,451 个序列化元素 | 名称、形状、元素数相同 |
| 浮点存储 | FP16，3,087,226,880 bytes | FP32，6,174,453,760 bytes |
| alignment heads 配置数 | 10 | 320 |

两者还有语言 ID、suppress IDs 配置差异，不能把词时间变化全归于精度。本轮没有逐个比较数值权重。存储类型和运行时 compute type 是不同概念，加载时可以转换，见 [CTranslate2 官方说明](https://opennmt.net/CTranslate2/quantization.html)。当前 FusionKit 的 GGML 引擎不能直接加载该 CTranslate2 文件；这里成功加载仅证明隔离实验可用。

用户授权查看运行中的应用后，只读核对窗口版本：**FasterWhisperGUI 0.7.6 / faster-whisper 1.0.1 / WhisperX 3.1.1**，与此前参考源码 0.8.5 不同。界面可见 float16，与用户回答一致；其余参数按保存配置核对，没有修改控件或在用户 GUI 点击转写。

保存配置：VAD 开启、threshold 0.5、min speech 250 ms、min silence 2000 ms、pad 400 ms；beam/best-of 5、patience 1、length penalty 1.8、temperature 0～1 按 0.2 回退、condition previous text 关闭、word timestamps 关闭、prompt/prefix 为空。只摘录与任务相关的参数，不复制完整配置。代理对照用这些参数和用户模型，但仍是本轮 faster-whisper 1.2.1 / CTranslate2 4.6.0，实验线程 8 而保存配置为 4，不能称恢复了历史 GUI 运行环境或原 LRC 的生成链。

同模型 FP16 / FP32 的三个推理耗时分别为 3828/265/47 ms 与 4860/422/31 ms；运行期间整卡观测最大占用分别为 12038 / 15400 MiB。耗时不含统一冷启动成本，整卡值包含其他应用且采样可能漏峰，不是进程峰值，也不是严谨性能基准；未采集进程 CPU 内存峰值。本组结果支持继续使用 float16，不能外推任意素材完全不受精度影响。

## 可复查产物与检查

- `selection/comparison.json`：17 次结果及不自动采用决定、源文件未变、`listeningValidated=false`。
- `selection/model-inventory.json`：两份 CTranslate2 文件的张量结构清单，`numericWeightsCompared=false`。
- `selection/candidate-opening.srt` / `.lrc`：**官方 FP16 B** 的诊断分句，16 条；只按已有标点和相应词起止分组，精确覆盖该候选全文。不是用户模型输出，不是生产默认产物；后半仍有缺标点长段。
- `selection/user-float16-opening.srt` / `.lrc`、`user-float32-opening.*`、`user-gui-settings-opening.*`：用户模型各自的 **8 条原始段**，没有用无效词时间强行拆句。
- 新增离线 `scripts/local-subtitle/benchmark/word-timing-audit.py` 和测试：6 项通过，覆盖无效区间、标点覆盖、父段与顺序、长跨度及禁止自动接受。审计输出不含台词，永远不授权自动替换。
- 2 份官方诊断字幕和 6 份用户模型字幕均经生产 SRT/LRC parser 回读通过；格式正确不等于时间正确。
- 首次原生脚本在推理前遇到大于 2 GB 整文件读取限制，改为分块哈希后运行；私有字幕首次回读因 CRLF 不符合严格输入失败，改为 LF 后 8 份回读通过。二者不计额外推理，未改生产解析合同。

本轮生产代码没有新增改动，未重跑上批 380 项生产回归或完整构建；其证据见 T-SEG-01/02 记录。所有本轮启动的模型进程已退出，收尾核查 6 个实验 PID 均不存在，原生服务经 supervisor 停止；用户 GUI 保持运行，没有启动前端服务。收尾 `check_spec.py` 为 0 error / 0 warning，本阶段 Markdown 本地链接无缺失，`git diff --check` 通过（仅提示工作区 LF/CRLF 转换）。

## 下一步

T-SEG-03C 先使用保存响应验证现有引擎的同文局部增强资格：文本覆盖、标点插入来源、词内接缝和时间有效性分别设门，保留主识别及低音量保护；有真实可用正例才进入 T-SEG-04 生产接线。失败时明确缺什么证据，不通过换更大文件或继续调 GUI 参数绕开问题。用户模型产品适配已按最新指示暂不推进。
