# T-SEG-00：日文开头断句问题的只读复现与根因记录

日期：2026-09-05。关联 R-SEG-01/02/03/07。状态：已完成调查与方案；没有修改生产代码。

## 输入与范围

使用用户明确提供的同一 `DAY01_trk01.wav`、参考双语 `.lrc` 和 FusionKit ` (1).lrc`。实际路径来自此前已保存的样本清单，并重新枚举该作品下同名文件确认。聊天文本转义的下划线不能展开为额外目录。

原 WAV 83,025,744 bytes，参考 LRC 4,831 bytes，当前 LRC 2,817 bytes；本轮三者在读取前后 SHA-256、size、mtime 均相同。完整路径和哈希只存在私有证据目录，不把 NAS 文件复制进 Git。

参考共 105 条有时间文本、54 个不同起点；FusionKit 66 条。双语行与单语行不直接比较条数，这些数值不是准确率。

本轮只提取开头 55 秒到工作区单声道 16 kHz PCM，通过两个 30 秒重叠窗口复现；第一个窗口核心截止 27.5 秒，与全轨规划一致。后一个窗口用于合法执行图，不能把截断后的全 55 秒结果宣称等于整轨输出。

## 原始结果与生产输出

真实本地 full large-v3 / CUDA / Silero v6.2.0，日语、beam 5、temperature 0、VAD min silence 500 ms、token timestamps false。两个窗口实际 gain 均为 0，不触发低音量增强或回退，共两次 native 请求。

第一个窗口的原始响应：

| 原始起止（秒） | 字符数 | 文字 |
| --- | --- | --- |
| 2.50～16.59 | 28 | ああもしもし私だそうだイオリだお前は誰だそうかお兄さんか |
| 16.59～24.96 | 38 | はは知っておる私が通話をかけたのだそなたがお兄さんだと知らないはずがなかろう |
| 24.96～30.00 | 9 | ん?なんだどうして |

同一生产 PCM writer、请求构造器、响应 parser、窗口规划、质量检查、后处理和格式器生成以下六条，逐行与用户当前 LRC 相等：

```lrc
[00:02.50]ああもしもし私だそ
[00:07.02]うだイオリだお前は誰
[00:12.06]だそうかお兄さんか
[00:16.59]はは知っておる私が通話をかけたのだそな
[00:20.77]たがお兄さんだと知らないはずがなかろう
[00:24.96]ん?なんだどうして
```

第一段时长 14,090 ms，7000 ms 限制要求至少三份，字符分成 9、10、9：

- `2500 + round(14090 × 9/28) = 7029`。
- `2500 + round(14090 × 19/28) = 12061`。

第二段时长 8370 ms，要求至少两份，38 字各 19 字：

- `16590 + round(8370 × 19/38) = 20775`。

这五条均被标记 `estimatedTiming=true`。LRC 量化为 7.02、12.06、20.77；它没有新切文本或删除标点。报告 `splitSegmentCount=2`、`shortCueMergeCount=0`、`estimatedTimingSegmentCount=5`、`trimmedBoundaryPrefixCount=0`。24.96 秒段被窗口所有权裁到 27.5 秒，其词句差异/后窗重复仍是另一个需回归的问题。

诊断性反事实：保持同一原始响应，将合法策略上限改为 15000 ms 再回放，开头恢复为上述两个完整原始文本段，三个断词消失，但长串内部仍没有句界，短句仍共用一个起点。因此“只调大时长”不能达到用户期望。该参数没有写入产品配置。

## 参考源码核对

本地 GUI 0.8.5 与 FineSub 0.5.0 快照可读，实际根为 `temp/subtitle_tools`。核对普通 LRC exporter、segment 包装以及 FineSub 统一分句/无词轴 fallback。未运行 GUI、未修改其目录，不声称本地快照就是用户历史产物所用版本。具体依据与限制见[设计第 2 节](../design.md#2-参考项目学什么不能据此推断什么)。

本例原始 ASR 段已缺标点，同时 FusionKit 制造断词和比例时间，两个问题必须分开验收。不能再只改短 cue 合并阈值，也不能因参考较好就未经同输入验证整体替换后端。

## 私有证据与复核方式

忽略目录 `test-results/subtitle-quality-review/phase12/`：

- `sources.json`、`reference.lrc`、`user-current.lrc`：输入身份与字幕副本。
- `opening-55s.wav`、`window-1/2.wav`、`window-1/2.json`：原音提取、实际输入、原始响应。
- `canonical-7000.json`、`canonical-15000.json`：当前策略与诊断参数回放。
- `replayed-7000.srt/.lrc`、`replayed-15000.srt/.lrc`：共四份由生产 formatter 导出的文件，均回读成功。
- `diagnose.ts/.mjs`、`report.json`、`diagnostics.json`：私有复现驱动、执行参数及结果。驱动只做组件级本地复现，不是桌面任务操作；canonical 的全零 modelHash 是 schema 回放占位，不是模型哈希证明。

编译命令：`node node_modules/esbuild/bin/esbuild test-results/subtitle-quality-review/phase12/diagnose.ts --bundle --platform=node --format=esm --packages=external --outfile=test-results/subtitle-quality-review/phase12/diagnose.mjs`。随后执行该 mjs。本轮使用 Codex bundled Node 绝对路径启动，源文件哈希在 finally 检查。

结果：前六行精确复现；两次请求；三个 NAS 源文件指纹不变；四个字幕文件 parse-back；模型进程 PID 56316 已退出，进程表无残留 whisper-server。本轮没有启动 Electron/Vite，没有安装新模型，没有调用远程转写或翻译。

本轮验证的性质是“错误机制被复现”，不是“错误已经修好”。本次执行后新增需求、设计、任务文档；下一步是 T-SEG-01/02，先移除默认后处理制造的错误，再完成限定时间能力选型。

## 文档验证

已运行 `check_spec.py`：0 error、0 warning；本阶段四个 Markdown 文件的 8 个本地链接目标存在，文本无行尾空格；`git diff --check` 通过。Git 只有现有仓库换行设置的 LF/CRLF 提示，无 whitespace error。

最终再次核对三份 NAS 输入的 SHA-256、size、mtime 不变，whisper-server 进程表为空。生产 `electron/`、`src/`、`test/`、`scripts/` 均无 diff，本轮不重新构建充当效果证明。补充 FK-PIT-0116，将显示预算与语义/声学边界分开的经验写入项目避坑索引；原先无关的未跟踪避坑文件保持不动。
