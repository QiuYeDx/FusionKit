# T07 Windows 独立资源与真实 CPU 对照

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-12 |
| 任务 | T-TRANSCRIPTION-07 |
| 验证版本 | feat/subtitle-studio-transcription，e80ef6b6460a2c3a27c9f102078543ba07d29352加既有T05/T06与本次工作树；30源文件/25运行资源文件快照2026-09-12-transcription-windows-runtime.snapshot.json，SHA-256 dfd09dceaf788427f23b17198b0708e95c3e4bed920a8bb869e6be73d88f2ea4 |
| 环境 | Windows x64，Node24.19.0/TypeScript5.9.3/Vitest2.1.9；原生构建为已有Node20.19.4及匹配headers/import library、LLVM-MinGW22.1.3；实际Electron41.10.6内Node24.18.0/N-API10 |
| 授权 | T06交付、下一步明确为完整新资源和有界真实对照后，用户原文“好的，继续推进工作吧”；整体验收保持pending |
| 任务指纹 | f9fd479e9a101b64143d3853f7f6c19eb7acc934658b761d9209dfa1132aa229 |

## 实际结果

新版Windows CPU资源已生成于`build/subtitle-studio-resources/transcription`：Whisper v1.9.1服务器和12个DLL、固定BtbN FFmpeg/ffprobe、6份许可/来源证据及独立生产addon。明确读取仓库历史缓存，重新检查真实输入和来源签名，没有复制旧staging的ready结论、下载大模型或安装编译器。实际完整双资源配置的beforePack预检已通过，legacy/studio的runtime和addon均ready、模块导出探针通过；没有生成安装包。

新增两套T07来源配方各派生6个Windows资源工具或addon工具文件，固定3a0f50e，每个精确变换与源/目标hash可重建。T01/T02/T03清单、C++及精确副本保持不变。新资源发布helper使用独立锁、唯一partial、COPYFILE_EXCL、链接/现存目标拒绝及完整清理。原始FFmpeg源码包、签名、公钥、BtbN包、Whisper包和选中制品全部匹配固定hash，再由新审计器重新执行GPG和版本/配置审计，生成新manifest。重复最终目录明确拒绝。

Windows生产和故障addon分开构建，N-API8、协议4、journal3及延迟导入保留，实际Electron证明兼容性。审查修复了新工具中的三处继承问题：恢复子进程保留准确ELECTRON_RUN_AS_NODE=1；首个清理失败仍等待其他自有目录并保留主错误；故障测试构建拒绝透传生产receiptPath。修订后重新编译并重跑实物验证，生产/测试二进制hash分别与首轮相同。

真实输入为仓库已有A.wav：历史第一轨30–60秒切片，30秒、16kHz单声道PCM16、960078字节；SHA-256 `196a524c3805cdc5cccd9711711220bc5591c04906be442c6fa00955874798c5`匹配历史phase10来源记录。路径为`test-results/subtitle-quality-review/vad-baseline-isolated/A.wav`，未重新访问NAS或用户原始目录。固定large-v3-q5_0模型1081140203字节、hash `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1`。两侧通过真实管理器copy导入隔离managed根，用bigint文件身份和hash证明不是原文件或硬链。

两侧参数相同：CPU、日语、transcribe、beam5、temperature0、VAD关闭、fixed_v1、7000/84/42显示限制。旧侧真实JobManager/ProductionExecutor/Exporter，新侧真实runtime/tasks/producer/DocumentRepository，没有替换媒体或推理结果。旧侧只观察export收到的domain transcript，仍委托真实SRT写入；新侧读取schema2完整canonical transcript，并在关闭后重开核对文档digest。

| 项目 | 旧版 | 新版 |
| --- | --- | --- |
| 完整链路耗时，含导入/探测/关闭 | 44.857秒 | 45.077秒 |
| 字幕条数 | 6 | 6 |
| 逐条文字/起止时间差异 | 无 | 无 |
| 输出 | 真实SRT及domain transcript | schema2文档、confirmed持久性、关闭后重开一致 |
| 清理 | server disposed，已观察PID全退出 | server disposed，已观察PID全退出 |

此次没有新增、遗漏、重复或时码差异，原有质量局限不因此被判定解决。耗时是本次完整链路观察值，不是吞吐基准；原始报告保存完整domain transcript和最终cue，不宣称采集未解析HTTP响应或完成新的听校。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-07-1 | 通过 | inline: runtime工具19项/来源5项；addon工具11项/新版来源7项；固定来源与配对回放90项通过。两份新配方各6文件逐字节重建，错误hash/来源/变换/缺失/覆盖/链接/并发/清理反例通过。addon工具另2个显式开关场景跳过，实际编译与Electron已单独执行 |
| V-TRANSCRIPTION-07-2 | 通过 | inline: ffmpeg-audit-receipt.json重新验证固定PGP签名和制品；windows-runtime-staging.json记录15个PE x64制品、6份固定证据及三个实际启动exit0/versionMatched。windows-runtime-no-clobber.json证明重复目标拒绝且manifest未变 |
| V-TRANSCRIPTION-07-3 | 通过 | inline: native/revised生产866304字节、故障版868352字节重编译；Electron生产19/故障恢复60/namespace4共83案例通过，宿主模式反例2项通过。staging ready/moduleExportsVerified均true，实际完整双贡献beforePack预检通过 |
| V-TRANSCRIPTION-07-4 | 通过 | inline: real-cpu-comparison/run-d343xv/report.json和real-cpu-comparison-final.log：真实测试1通过，6/6逐cue文字/时间全等，schema2关闭后重开digest一致，源音频/模型前后指纹不变，旧新各2个已观察原生PID均退出，无fixture推理 |
| V-TRANSCRIPTION-07-5 | 通过 | inline: 任务/文档/生命周期130项通过（另1个原有Electron桥接开关跳过）；333文件实际边界0错误、边界7项通过；两套TS及额外harness TS通过。旧staging28文件hash/数量不变，最终相关原生进程表为空。T06快照22文件原字节保留，另2个仅更新本轮边界与避坑索引 |

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-07-1 | 通过 | V-TRANSCRIPTION-07-1, V-TRANSCRIPTION-07-5 |
| AC-TRANSCRIPTION-07-2 | 通过 | V-TRANSCRIPTION-07-2, V-TRANSCRIPTION-07-5 |
| AC-TRANSCRIPTION-07-3 | 通过 | V-TRANSCRIPTION-07-1, V-TRANSCRIPTION-07-3 |
| AC-TRANSCRIPTION-07-4 | 通过 | V-TRANSCRIPTION-07-4 |
| AC-TRANSCRIPTION-07-5 | 通过 | V-TRANSCRIPTION-07-1, V-TRANSCRIPTION-07-3, V-TRANSCRIPTION-07-5 |

本机证据均位于忽略目录`test-results/studio-t07/`。主要日志：core-regression、frozen-regression、windows-addon-unit-revised、windows-addon-provenance-revised、boundaries-test、tsc/tsc-node/tsc-harness。native/revised/final-toolchain-evidence.json串联源码、重编译回执、全部原生报告和staging；dual-contribution-preflight.json及isolation-final.json记录完整配置和旧文件/进程核对。证据文件hash见本记录快照，不将重复执行的测试数量叠加。

首次真实入口在推理开始前因测试设置180000ms超过生产启动上限而失败，保留run-6Z14eJ及real-cpu-comparison.log；改为允许的120000ms后通过，未放宽生产校验器。一名子agent误用pnpm wrapper，因无TTY退出后改用已安装Node；package.json/pnpm-lock.yaml无变化，未进行依赖安装。新增FK-PIT-0141记录实际Electron恢复子进程宿主模式反例。

### 实物摘要

| 产物 | SHA-256 |
| --- | --- |
| runtime manifest | 3a2ac09dfc9bf21119e57977fc95bbce582622896e410770c53e72dac32302dd |
| 生产addon | bcbb8f476d37cff3bc1b1f29b061e492c27bfda341916e946f70af10697e7dc1 |
| addon manifest/generation | 098ac203acf2ab3979ba0473f1d9144de4a396cb87e7de746f3ffd7c657d2d14 |
| staged build receipt | 2b6e9561e1051735d878886b3042ba17547b746c95820fb171c5332535a8289b |
| 最终原生工具链证据 | bcf2107fcfda6fac84879e8d12f5c2fa684c8f214162693be6ab628c557c424b |

### 复核入口

仓库根目录使用已安装Node，来源检查不会执行ASR：

```powershell
node scripts/subtitle-studio-provenance/runtime-windows-copy.mjs --check
node scripts/subtitle-studio-provenance/windows-addon-copy.mjs --check
node scripts/subtitle-studio/check-boundaries.mjs
$env:FUSIONKIT_REAL_ASR='1'
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/real-cpu-comparison.test.ts --maxWorkers=1 --minWorkers=1
Remove-Item Env:FUSIONKIT_REAL_ASR
```

重制资源需新空输出目录与新回执名。新版audit-ffmpeg-windows-x64、stage-runtime-windows-x64及overwrite-native/build-addon-windows-x64、overwrite-staging均有`--help`。本机上游缓存位于`docs/v0.2.11/local-subtitle-transcriber/poc/runtime-smoke.local`：Whisper为whisper-bin-x64.zip/expanded/Release，FFmpeg为downloads/pre005-windows及expanded-pre005-windows。GPG明确使用`C:/Program Files/Git/usr/bin/`下工具；另一份build缓存的零字节公钥不可用。新工具只接受明确输入，不自动查找旧缓存。

## 风险与未执行项

真实证明限定Windows x64 CPU、一个30秒样本、VAD关闭/fixed_v1；默认VAD/acoustic_quiet_v1、B/C低声噪声、长音频/窗口接缝矩阵和CUDA/Metal比较尚未完成。macOS完整资源、共存/移除应用包及签名/公证仍待后续任务。双资源预检不代表安装包已构建或发布，用户整体验收未代签。

新版build资源被Git忽略；模型只复制到隔离测试根，没有写真实userData。启动开发版后仍通过资源页明确导入模型、准备所需VAD/加速资源。保留隔离模型副本、文档和回执供复核，原模型/音频/旧staging未改。所有本轮原生进程退出、tsbuildinfo已清理。本轮没有UI/语言/产品源码变化，沿用T06渲染/i18n证据，不将它们当作真实ASR界面验收；未提交、推送或发布。
