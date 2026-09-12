# T-TRANSCRIPTION-05 任务准入、文档队列与应用接线

| 字段 | 值 |
| --- | --- |
| 任务 | T-TRANSCRIPTION-05 |
| 日期 | 2026-09-12 |
| 验证版本 | feat/subtitle-studio-transcription，e80ef6b 加本轮工作树；38文件源码/测试/维护指引快照见2026-09-12-transcription-admission.snapshot.json，SHA-256 691dfa0d687968d85f21e3c51f6b80df99d5df9bcf4ddf4a9fa5efaa23fecc02 |
| 环境 | Windows x64，Node24.19.0，TypeScript5.9.3，Vitest2.1.9，Electron41.10.6；使用已安装工具，无依赖安装 |
| 任务指纹 | aa27619c7c335c093b81fdf34a56298eb80560b3aa8759273436e329ebba344f |

## 实际结果

用户在分支接续盘点后回复“好的，继续推进工作吧”。已按 T05 接通私有转写资源、任务准入/队列、T04 文档生产者及 main/preload；转写页面尚未实现。T01–T04 已在 e80ef6b 集成，历史记录中的“共享未提交工作树”仅指当时验证状态。

新增独立任务契约及 task-service，每次最多20文件、会话最多1000任务。请求只包含 owner 的媒体 token 和转写选择；配置冻结后不含 output/postAction。同步取得准入序号，异步完成的校验按 FIFO 顺序发布；资源、运行时、后端品牌、媒体身份及音轨证明通过后原子预留能力，失败回滚全批。执行前再次检查租约、资源身份与有效 owner，逐任务释放原生 pin 后通过真实 producer/sink 创建媒体文档，公开稳定 documentId 和 confirmed/uncertain 持久性。

排队与运行任务按 owner 续租；取消和 owner 撤销先同步阻止新工作，再等待所有已启动操作。并发校验的一个失败不能遗弃其他校验；续租等待被取消时释放执行位置，但原续租仍留在该 owner 的待完成集合。已撤销 owner 的干净终态记录释放容量；清理失败继续保留资源锁和能力句柄。发布回执优先于迟到取消，不将已创建文档改报取消。此阶段没有跨重启任务恢复或推理重试入口。

主进程原生选择器签发只允许 probe/transcribe 的媒体能力；模型导入固定 copy。固定 preload 方法提供选择/撤销、资源查询/导入/安装/取消及任务创建/查询/取消/终态移除。请求使用原有严格 capability、主 frame 和来源 URL 检查，注册替换/导航/窗口销毁撤销旧 owner。公开响应排除路径、内部资源身份和原始错误诊断。新增错误码仅补齐现有错误映射及四语言文案，无布局或新转写页面。

应用退出/更新复用现有退出控制器，等待旧版与 Studio 两个运行时；任一失败仍尝试另一项，成功项不重复关闭。新版先等任务收敛，再关闭资源/媒体/服务器；缓存关闭和 owner-release Promise 后才触发同步 abort，失败保持 canonical 根锁供重试。资源工厂惰性创建，未安装新版 ASR 资源时 I1 仍可使用。

Windows 集成修正：为精确冻结/审计文本设置 LF checkout 属性，147目标预检后恢复131个仅有 CRLF 差异的本机文件，没有改来源摘要。运行时集成夹具改用宿主目标，避免在 Windows 上误用 macOS 的0700目录契约；生产权限校验不变。应用入口是基线中 reference-only 的组合证据，新增独立的准确内容审计允许本次关闭接线变更；不得借此放宽复制源码或算法的漂移检查。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-05-1 | 通过 | inline: 新IPC9项、既有IPC19项及任务契约2项通过；覆盖原生picker/严格输入、未知/伪造字段、frame/URL/capability拒绝、资源诊断消毒、copy-only、替换owner与迟到授权。实际Electron桥接1项通过 |
| V-TRANSCRIPTION-05-2 | 通过 | inline: 队列22项通过；真实input registry/lease coordinator与品牌backend，FIFO、20文件准入/回滚、1000任务容量回收、跨owner续租隔离、媒体/模型失效、排队/运行取消、能力释放失败与重试、并发验证完整join |
| V-TRANSCRIPTION-05-3 | 通过 | inline: 队列测试实际调用T04 producer/sink及磁盘DocumentRepository，2文件各入库并读回全文；原生执行器为受控适配器。发布前取消/存储失败没有文档，发布后owner释放保留completed文档ID，清理失败阻止移除且继续占用资源 |
| V-TRANSCRIPTION-05-4 | 通过 | inline: runtime19项、独立生命周期4项、应用关闭组合2项通过；同步重入Promise一致、等待任务后清理native、失败继续全部阶段、根锁和显式重试。真实Electron空库/资源查询、缺资源needs_configuration、重载新owner及退出通过 |
| V-TRANSCRIPTION-05-5 | 通过 | inline: 最终普通回归1137通过/20按开关跳过，来源及回放75通过；两套TS、i18n、306文件实际边界、Vite test构建/preload和实际Electron1项通过。来源副本/清单逐字节不变，规格ready/done及diff通过，进程表无本轮服务残留 |

### 验收标准对应

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-05-1 | 通过 | V-TRANSCRIPTION-05-1 |
| AC-TRANSCRIPTION-05-2 | 通过 | V-TRANSCRIPTION-05-2 |
| AC-TRANSCRIPTION-05-3 | 通过 | V-TRANSCRIPTION-05-3 |
| AC-TRANSCRIPTION-05-4 | 通过 | V-TRANSCRIPTION-05-4 |
| AC-TRANSCRIPTION-05-5 | 通过 | V-TRANSCRIPTION-05-5 |

### 可重跑命令

```powershell
node node_modules/vitest/vitest.mjs run test/subtitle-studio test/app-shutdown.test.ts --exclude 'test/subtitle-studio-provenance/**' --maxWorkers=1 --minWorkers=1
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.node.json --tsBuildInfoFile test-results/studio-t05-node.tsbuildinfo
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node scripts/subtitle-studio/check-boundaries.mjs
node scripts/subtitle-studio-provenance/copy.mjs --check
node scripts/subtitle-studio-provenance/native-copy.mjs --check
node scripts/subtitle-studio-provenance/tooling-copy.mjs --check
node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/copy.test.ts test/subtitle-studio-provenance/replay.test.ts test/subtitle-studio-provenance/transcript-executor-copy.test.ts test/subtitle-studio-provenance/transcript-executor-replay.test.ts test/subtitle-studio-provenance/checkout-bytes.test.ts --maxWorkers=1 --minWorkers=1
node node_modules/vite/bin/vite.js build --mode test
node scripts/check-preload-bundle.mjs
$env:FUSIONKIT_STUDIO_TRANSCRIPTION_BRIDGE='1'
node node_modules/vitest/vitest.mjs run test/subtitle-studio/transcription-bridge.test.ts --maxWorkers=1 --minWorkers=1
```

日志位于忽略目录 `test-results/studio-t05-regression-final.log`、`studio-t05-tsc.log`、`studio-t05-build-final.log`、`studio-t05-i18n.log`、`studio-t05-bridge-final.log`；实际桥接摘要 `test-results/studio-transcription-bridge/result.json`。日志不随Git同步，本记录和内容快照保留可恢复证据。1137中包括全部本轮正常测试；20项环境开关跳过中的新bridge已另行实跑，其他19项旧UI/供应商/实物场景本轮未重跑。构建保留已有大chunk与混合import提示，不代表发布包已构建。

## 风险与未执行项

队列集成消费受控推理输出和隔离资源，真实Electron只验证桥接、能力、缺资源行为与I1共存，不能视为真实ASR、Windows原生addon或GPU验收。新版完整FFmpeg/Whisper staging仍需独立构建/回执，缺失时拒绝执行；未下载大模型、读取真实用户数据或修改真实媒体。

下一步细化转写UI的媒体列表、资源准备、参数及队列展示，消费本轮固定API；随后提供真实资源并执行有界新旧效果对照、Windows原生和共存/移除打包验证。当前新队列仅保留会话状态，失败推理可由用户重新选择媒体创建新任务，不能冒充原任务恢复。I1/I2用户整体验收仍pending；没有提交、推送或发布。本轮测试实例已关闭，进程表确认没有本项目Electron/Vite/原生服务残留。
