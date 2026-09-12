# T-TRANSCRIPTION-02 独立源码副本与等价回放

| 字段 | 值 |
| --- | --- |
| 任务 | T-TRANSCRIPTION-02 |
| 日期 | 2026-09-11 |
| 验证版本 | 来源3a0f50ed15c1b63451402cecf27240182235e567；副本、维护工具和边界门禁为本次未提交共享工作树，最终摘要见下文 |
| 环境 | macOS arm64，Node20.19.5，TypeScript5.9.3，Vitest2.1.9，已安装esbuild0.21.5；没有安装依赖 |
| 任务指纹 | 6cd77a80e88b90157b1deed24de1d5220378fadbf5f5d3ca4dda345b81383248 |

## 实际结果

承接T01完成后用户再次明确的“好的，继续往后推进工作吧”，完成原生产闭包的独立机械复制和迁移验证。root负责规格/边界/集成，baseline_checks负责copy工具及生成副本，workspace_progress负责配对回放与真实品牌测试，broader_roadmap只读核对资源、namespace和变换。没有注册产品入口，也没有代签I1/I2整体验收。

从正式279文件基线选取120文件：84份生产源码/类型/配置/manifest、9份原始licenses/source-offer、24份正常测试及3份helper/fixture。87个文件有227次登记变换，其余保持字节不变；35份参考文件和124份后续待复制文件逐项保留理由。独立审查逐项对照源Git blob、实际目标hash、目标字节数和变换重放，均匹配。

所有模块路径按AST字面量与两端映射重算；63条源码字面量规则和17条JSON字段规则均绑定源文件、旧值与次数/字段。IPC、运行根、原生组件名、必要临时文件和品牌描述使用新版身份，内部类型/类名保留以缩小机械差异。9份许可证据原字节及上游模型、VAD、CUDA pins保留；历史recipe路径只作来源证据，不冒充新版构建回执。

新生产路径为`electron/main/subtitle-studio/transcription/native/`，类型/config为`src/subtitle-studio/transcription/`，普通回归为`test/subtitle-studio/transcription/`。实际目标与精确变换位于`resources/subtitle-studio/provenance/transcription-fork.json`，状态明确为`source-copy-unregistered`。T01冻结清单和生成器保持原样。

## 隔离与门禁

业务图只增加已审计的yauzl和新版转录资源根；旧业务、旧native根及provenance脚本/测试/清单均禁止进入图。门禁增加业务JSON旧路径检查，4份历史JSON证据仅以精确路径与SHA-256豁免字符串审查，仍须可解析且字节不变。

原有门禁会漏掉`createRequire`装载。现在任何`node:module`访问均需源hash审计，唯一原生装载绑定文件、表达式、次数和完整源hash；Windows嵌入脚本预检另有准确源审计。独立审查曾复现括号、赋值、解构和方括号访问绕过，修复后负例均拒绝。实际源码图259项、0错误；这不是任意JavaScript的沙箱，也不是native运行证明。已记录FK-PIT-0131。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-02-1 | 通过 | inline: copy.test.ts最终11项通过；固定Git、精确变换、漂移/冲突/hash/符号链接、大文件/CRLF/clean-filter负例 |
| V-TRANSCRIPTION-02-2 | 通过 | inline: copy.mjs --check通过，历史重建、279登记源工作树、120实际目标及fork完整字节一致；独立逐项hash/227次变换审查通过 |
| V-TRANSCRIPTION-02-3 | 通过 | inline: replay.test.ts的13完整场景+3词时间模式通过；两侧各59个bundle输入，实际config/transcript/error/cueSummary、请求/窗口、回退/清理及产物hash严格一致 |
| V-TRANSCRIPTION-02-4 | 通过 | inline: replay.test.ts的4项真实品牌测试通过，backend/accelerator/batch/PCM-window本侧执行与双向消费者拒绝；不使用窗口brand bypass作为证据 |
| V-TRANSCRIPTION-02-5 | 通过 | inline: 新版24套679项正常回归、I1的336项回归、实际边界259项/0错误、两套TypeScript及i18n通过；规格ready/done --require-approval及git diff --check最终核对通过 |

I1命令`node node_modules/vitest/vitest.mjs run test/subtitle-studio --exclude 'test/subtitle-studio/transcription/**'`也匹配了provenance维护目录，本次输出363通过=336项I1+17项基线+当时10项copy反例。18项需显式启用的Electron/真实文件/API场景跳过，不能算本轮UI或真实服务验证。i18n检查四语言2125键一致，1986处调用全部解析；18条已有同值提示不影响结果。

## 回放与真实品牌证据

固定场景包括fixed/acoustic窗口几何、未知句界和合法重复、quiet增强拒绝后原音回退及空白负例、有界重复拆分/温度重放、55秒跨窗overlap、CUDA f16 DTW有效/缺点，以及CUDA q5/CPU f16排除路径，另验清理失败禁止导出。每个场景同时断言明确预期与新旧严格相等；完整transcript不做字符串归一化。词时间另外比较ordinary/VAD/DTW三条真实解析契约。

4类品牌使用两棵源码树各自的真实签发注册表。accelerator外侧proof在自动解析时不可采用，即使退回CPU，也会在要求CUDA的batch admission被拒绝；测试记录实际拒绝路径。本侧正例随后执行成功。PCM/window使用真实normalizer和注入的合成WAV runner，实际materialize/resolve均双向拒绝外侧proof，消费者使用完整task/generation/window binding。

最终回放20/20通过，证据`test-results/studio-transcription-replay/evidence.json`包含13条trace、3类word evidence、4类品牌结果及源/bundle信息，`status=passed`、`cleanupSucceeded=true`。这是可重新生成的本机忽略产物，Git中的测试和本记录承接可复核事实。

验证期间给真实PCM消费者补齐binding，Vitest加载独立bundle使用其支持的动态import；应用源树仍独立。Node同步stdin校验曾两次卡住，已结束对应父/子进程，复制工具改为Git直接文件读取并逐调用10秒超时，保留完整漂移/归一化/filter防护；原T01工具未改。FK-PIT-0131/0132/0133分别记录动态loader、真实品牌测试和有界Git校验。

## AC结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-02-1 | 通过 | V-TRANSCRIPTION-02-1, V-TRANSCRIPTION-02-2 |
| AC-TRANSCRIPTION-02-2 | 通过 | V-TRANSCRIPTION-02-2, V-TRANSCRIPTION-02-4, V-TRANSCRIPTION-02-5 |
| AC-TRANSCRIPTION-02-3 | 通过 | V-TRANSCRIPTION-02-3 |
| AC-TRANSCRIPTION-02-4 | 通过 | V-TRANSCRIPTION-02-4 |
| AC-TRANSCRIPTION-02-5 | 通过 | V-TRANSCRIPTION-02-2, V-TRANSCRIPTION-02-5 |

## 复现命令

```sh
node scripts/subtitle-studio-provenance/copy.mjs --check
node node_modules/vitest/vitest.mjs run test/subtitle-studio/transcription/
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/copy.test.ts
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/replay.test.ts --maxWorkers=1 --minWorkers=1
node scripts/subtitle-studio/check-boundaries.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.node.json
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
```

## 风险与未执行项

本阶段没有运行Vite、Electron、FFmpeg、whisper或真实GPU，也没有读取真实userData、媒体或模型。模拟推理输入证明源码继承的确定性，不能代替以后真实原生资源、音频效果和打包/签名验证。

下一任务细化独立资源与原生组装：重建addon、验证双工具打包/签名、独立managed根与生命周期；随后承接统一文档和转写UI。旧副本中的artifact/export/move分支只用于未注册的保守回放闭包；新的公开模型导入必须只允许copy，不能把move分支直接暴露。文档容量及word/speaker/confidence契约仍由Q-02承接，不能SRT往返或静默截断。

没有调用pnpm、更改依赖或锁文件；当前改动尚未提交Git。本轮临时回放目录已清理，生成的tsbuildinfo已删除；未启动前端服务。最终进程表核对未发现本次copy/Git/replay/esbuild或项目Vite/Electron进程残留。

## SHA-256

| File | SHA-256 |
| --- | --- |
| resources/subtitle-studio/provenance/transcription-fork.json | 993e57a72b3a191e8ba6afe50d90899baefd4f6af4f8f62ad25cc3d6371befa3 |
| scripts/subtitle-studio-provenance/copy.mjs | ca00f30d326d23c0886137d611037ba0030e7e4b59e81e349be6d83e697e65c4 |
| scripts/subtitle-studio-provenance/copy-policy.mjs | cbc72dc55c8ef342397e3479fb1ce7eca9c82149468c3eb2d3205f2400673002 |
| scripts/subtitle-studio-provenance/copy-literals.json | 9fb1e31a465fc86dc4bbb409928dbc69c92ae64454aa52ec17ddd7e98392421d |
| scripts/subtitle-studio-provenance/copy-json.json | 084c09cfd4918b3974c7d42f9420db7ad585c4371d4a92dd57a8056e2818145d |
| test/subtitle-studio-provenance/copy.test.ts | a57c032a6e25740da11d39dba419da7b87aeed9812f4e8af2f08d07720c5e1c3 |
| test/subtitle-studio-provenance/replay-harness.mjs | a9752efd9b2bd4add1acd19d9d5c069db4a6c39abd3cb37eb6fdf01c76b5914c |
| test/subtitle-studio-provenance/replay.test.ts | 6329f8650860e4c9d3692c989f23fb3a3b66109fbca81a99bb35576f964c0182 |
| test/subtitle-studio-provenance/fixtures/replay-cases.ts | f56afa4f611bf8d5cba20f654f513b58345a5d8082bbbfbae51304cb88d95e2f |
| scripts/subtitle-studio/check-boundaries.mjs | 2e03350932f289036e1bf8b21d62b5ec101bc2a26fd176c027a1e3427fe6fb19 |
| scripts/subtitle-studio/boundaries.json | 8aa6fa8d4209bfe10394239c51e665a146a73b15e40c8c39e847cd72e9662119 |
| test/subtitle-studio/boundaries.test.ts | 2749851f6a9eee2c9796a643d704b3d7685da13e563c6bcbcf134a6ae3375562 |
| test-results/studio-transcription-replay/evidence.json | a2252a9dce99991e3a5c7698eecd570f1331050f8e511881cd3a1150e6670378 |
