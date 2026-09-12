# T-TRANSCRIPTION-04 最终转录文档生产者

| 字段 | 值 |
| --- | --- |
| 任务 | T-TRANSCRIPTION-04 |
| 日期 | 2026-09-12 |
| 验证版本 | 3a0f50ed15c1b63451402cecf27240182235e567加T01/T02/T03及本轮未提交共享工作树 |
| 环境 | macOS arm64，Node20.19.5，TypeScript5.9.3，Vitest2.1.9，Electron41.10.6；使用已安装工具，无依赖安装 |
| 任务指纹 | 859678be84485624761250b7301c634b5e7bfc20f452ef29e14fbafab854ca5e |
| 集成快照 | [33文件内容摘要](2026-09-12-transcription-document.snapshot.json)，SHA-256 e770f8180a7a0da230cbdce8004f5a119bf29b6e899b93cb0ec457b615d32d51 |

## 实际结果

用户在T03完成后再次明确继续，按I2路线实现最终transcript到统一文档。root负责规格、producer、Electron集成及收尾；workspace_progress负责domain/adapter及消费者；baseline_checks负责派生executor/来源工具/配对回放；broader_roadmap负责repository/sink及提交边界。已有未提交结果全部保留，未修改冻结的T01/T02副本或旧业务。

新增schema2媒体文档，与schema1 SRT/LRC判别兼容。cue使用稳定UUID和segmentId按输入顺序一一对应，文本/起止时间精确保留；preservation保存严格canonical transcript中的全部已存在word/probability/speaker/confidence/estimatedTiming、语言和模型信息。媒体origin明确format=media、显示名/可选时长及transcriptDigest；摘要不冒充媒体文件hash，仓库入口校验摘要与转录内容。没有媒体副本、原字幕raw节点或编码，preserveSource=false。生产后处理未提供的word/speaker等字段不会补造。

保持100000 cues及128MiB完整snapshot限制；预检查拒绝显然越界的段/词/文本，完整结构字节计算防止只计正文遗漏结构开销。100001条返回limit_exceeded且仓库目录为空，不截断、拆分、合并或重排时间。源transcript的200000上限和T02代码保持原样。

新派生executor保留推理、窗口、后处理、默认值及能力brand规则，通过31条精确规则、59次文字替换和26处相对import重算，从T02固定来源重建。只移除输出授权/目录/文件exporter依赖，在native任务清理后返回完整transcript_ready。内部producer校验batch/task/sink身份，合并并发run，释放batch pin后才提交文档；清理失败隔离该producer，存储失败可以复用ready结果重试而不重复推理。该入口要求调用方提供已准入上下文，尚未接入应用任务准入/队列或renderer转写IPC。

sink冻结main侧owner/task/generation与一次文档身份，同内容并发合并、内容漂移拒绝。repository.createConfirmed将初次创建摘要/修订保存在指针中，并跨后续文档修订保留；发布前失败只清理本进程准确记录的临时目录身份，不接管未知孤立目录。同ID重试可核对实际文档，墓碑优先，删除后不会重放复活。

取消/owner检查的最后边界是发起current指针rename之前。rename一旦发出可能完成发布，迟到取消不能把已提交结果伪报为无文档；发布后的目录同步失败返回committed、同一documentId及durability=uncertain。此状态与confirmed明确区分，不承诺断电绝对安全、跨重启自动任务恢复或exactly-once推理。

现有工作台支持媒体文档分页、翻译及SRT/LRC投影，译文提交不改变原转录证据。原文件导出和双语原文拆分明确拒绝媒体；UI隐藏媒体raw页签与原文件下载、默认SRT，使用“转录信息已保留”及专用转录证据损失提示，四语言齐备。投影需接受损失后保存，不复用会声称原文件已保留的旧提示。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-04-1 | 通过 | inline: adapter/consumer新增27项，完整证据映射/旧schema、100000成功及100001拒绝、重复id/坏word/词数/128MiB正文与结构开销均覆盖；sink额外验证完整合法100001段已通过严格transcript校验后仍limit_exceeded且documents为空、sequence为0、磁盘根目录为空 |
| V-TRANSCRIPTION-04-2 | 通过 | inline: 派生来源6项、回放23项通过；13类实际配对比较T02完整最终transcript与预期路径，10项清理/取消/品牌/输出边界；包含真实派生executor→producer→sink→repository且batch pin先释放，输出目录为空；来源重建1文件/26依赖通过 |
| V-TRANSCRIPTION-04-3 | 通过 | inline: repository创建14项、sink12项、producer10项通过；覆盖实际重开、同ID故障重试/并发、内容漂移、owner/generation、发布前取消、发布后同步故障及迟到取消、删除墓碑、清理失败和缓存终态owner撤销。存储重试不重复执行ASR边界 |
| V-TRANSCRIPTION-04-4 | 通过 | inline: 27项adapter/consumer包含真实TranslationService使用隔离fake provider提交译文、源文件删除后文档可用、SRT/LRC损失及原文件/双语保护；加原有formats17、bilingual23、export-planner29共96项通过；Electron使用实际IPC分页及实际SRT文件保存 |
| V-TRANSCRIPTION-04-5 | 通过 | inline: 最终普通回归1094通过/19按环境开关跳过，T02与派生来源/回放49通过；T02 120项实际hash及T01 baseline保持冻结。真实边界298文件0错误，两套TS、i18n完整性/使用、Vite test构建/preload、spec ready/done及git diff --check通过。进程表核对本轮进程已退出，pnpm-lock与HEAD逐字节相同 |
| V-TRANSCRIPTION-04-6 | 通过 | inline: 隔离Electron opt-in测试最终1/1通过，105条媒体/旧SRT同库；实际按钮100→5→100分页、无media UTF-8或raw节点、下载菜单/默认SRT/损失确认、真实保存文件包含第105句、旧字幕原文件菜单通过。查看最终媒体分页/损失截图及首轮预览/旧字幕截图，未发现新增布局问题 |

普通回归为前阶段1031项加本阶段63项（adapter27、creation14、sink12、producer10）。19项跳过中18项是既有UI/真实API/本地文件环境场景，另1项是本轮新媒体UI开关；新UI已单独在真实Electron运行。49项维护测试为T02回放20、派生来源6、派生回放23。数字不包含本轮未重跑的T03完整native/packaging专项，不代表全部产品测试或真实ASR通过。

### 验收标准对应

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-04-1 | 通过 | V-TRANSCRIPTION-04-1, V-TRANSCRIPTION-04-4 |
| AC-TRANSCRIPTION-04-2 | 通过 | V-TRANSCRIPTION-04-1, V-TRANSCRIPTION-04-3 |
| AC-TRANSCRIPTION-04-3 | 通过 | V-TRANSCRIPTION-04-2, V-TRANSCRIPTION-04-3 |
| AC-TRANSCRIPTION-04-4 | 通过 | V-TRANSCRIPTION-04-3 |
| AC-TRANSCRIPTION-04-5 | 通过 | V-TRANSCRIPTION-04-4, V-TRANSCRIPTION-04-5, V-TRANSCRIPTION-04-6 |

### 可重跑命令

```sh
node scripts/subtitle-studio-provenance/copy.mjs --check
node scripts/subtitle-studio-provenance/transcript-executor-copy.mjs --check
node node_modules/vitest/vitest.mjs run test/subtitle-studio --exclude 'test/subtitle-studio-provenance/**' --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/replay.test.ts test/subtitle-studio-provenance/transcript-executor-copy.test.ts test/subtitle-studio-provenance/transcript-executor-replay.test.ts --maxWorkers=1 --minWorkers=1
node scripts/subtitle-studio/check-boundaries.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.node.json
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node node_modules/vite/bin/vite.js build --mode test
node scripts/check-preload-bundle.mjs
FUSIONKIT_STUDIO_TRANSCRIPTION_UI=1 node node_modules/vitest/vitest.mjs run test/subtitle-studio/transcription-document-ui.test.ts --maxWorkers=1 --minWorkers=1
python3 /Users/qiuyedx/.agents/skills/spec-driven-ai-coding/scripts/check_spec.py docs/features/subtitle-studio --stage ready --require-approval
python3 /Users/qiuyedx/.agents/skills/spec-driven-ai-coding/scripts/check_spec.py docs/features/subtitle-studio --stage done --require-approval
git diff --check
```

构建采用现有test模式生成实际main/preload/renderer，未开启Vite服务。i18n四语言各2127 keys，使用检查1986 calls/1982 resolved；18条历史相同译值提示不变。Vite保留既有大chunk及动态/静态混合import提示；本轮构建及preload检查成功，不等于发布包完成。

### 本机证据与截图

最终日志：`/tmp/fusionkit-t04-normal-final.log`（1094）、`/tmp/fusionkit-t04-replay-tests.log`（49）、`/tmp/fusionkit-t04-electron-final.log`（1）、`/tmp/fusionkit-t04-build.log`、`/tmp/fusionkit-t04-i18n.log`。临时日志和test-results不随Git同步；源码测试与本记录/快照随仓库保留。

Electron测试真实启动已构建应用，在独立临时profile创建schema2媒体文档与schema1字幕，结束后关闭应用并移除profile及输出文件。界面逻辑尺寸1280×860、浅色中文，截图2560×1720。证据位于`test-results/studio-transcription-document-ui/`：`media-preview.png`、`media-next-page.png`、`media-export-loss.png`、`subtitle-download.png`。审阅看到长文件名/长正文可读、表格与页脚对齐、第二页101–105正确、转录保留提示准确；损失提示在弹窗内完整可见且未确认时保存禁用；旧字幕仍有UTF-8/raw页签和原文件下载。未增加CSS/动画或新工具页面，没有把人工构造媒体fixture称作真实转写。

| 来源或证据 | SHA-256 |
| --- | --- |
| T01 baseline（未变） | c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66 |
| T02 fork（未变） | 993e57a72b3a191e8ba6afe50d90899baefd4f6af4f8f62ad25cc3d6371befa3 |
| T04 transcript-executor.ts | 4b22722b1acfc22aff6d36ae381f362bc6f9ed39374f6631023a41f93e376c35 |
| T04 transcription-executor-fork.json | 57ad828cd4859554b0ab5f7081abc0bc096111e542d6b856d32d405ffb1d590e |
| T04 replay-evidence.json（本机test-results/subtitle-studio-transcript-executor） | 2639aef87e8109e130913cc6c400e4dd6d7a036924a0da003adb864435917d3b |

## 风险与未执行项

下一阶段先细化新版任务准入/队列与应用runtime、main/preload接线，再提供转写UI。现有producer是内部组合入口，不替代媒体授权、能力签发、任务恢复、全局关闭与renderer权限。完整新版FFmpeg/Whisper构建输入及回执仍待准备；T03双资源beforePack在缺新版staging时应继续阻止打包。Windows实跑、真实ASR/GPU、有界新旧效果对照、共存/删除后的完整应用包、外层签名/公证和产品分发仍待后续验收。

本轮未修改真实userData、模型或用户媒体，未执行pnpm、提交或发布，未启用新版转写入口。tsbuildinfo已清理；所有本轮测试/Electron进程已退出，进程表没有本项目服务残留。I1/I2用户整体验收保持pending。新增FK-PIT-0135沉淀发布与迟到取消、持久性未知及稳定文档身份的边界。
