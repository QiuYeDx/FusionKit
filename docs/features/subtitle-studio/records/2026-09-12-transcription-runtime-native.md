# T-TRANSCRIPTION-03 独立资源工厂与原生构建组合

| 字段 | 值 |
| --- | --- |
| 任务 | T-TRANSCRIPTION-03 |
| 日期 | 2026-09-12 |
| 验证版本 | 3a0f50ed15c1b63451402cecf27240182235e567加T01/T02和本次未提交共享工作树 |
| 环境 | macOS arm64，Node20.19.5，TypeScript5.9.3，Vitest2.1.9，Electron41.10.6，Xcode macOS SDK26.5；无安装依赖 |
| 任务指纹 | 40efd3c8cf58464713270771c80761e5a09b8582a6d7dda0cc0671612f38cc2d |
| 集成快照 | [42文件内容摘要](2026-09-12-transcription-runtime-native.snapshot.json)，SHA-256 cfba72e89fc0320771051c2484aac4273d0fec6fd5f2194c13d2ce403a52d86b |

## 实际结果

用户在T02交付后再次明确继续，按既定I2路线展开独立资源、进程及原生构建。root负责规格/边界/集成；workspace_progress负责外围runtime工厂及正常测试；baseline_checks负责新版native源码、构建/签名/加载验证及独立来源清单；broader_roadmap负责runtime验证脚本、完整双工具builder/hook及来源清单。共享runtime-manifest/staging-contract仅由broader_roadmap写入，T01/T02文件保持原样。

已建立私有runtime工厂，构造无副作用，显式初始化拥有`<userData>/subtitle-studio/transcription`。工厂组合独立的授权、媒体、资源、进程、任务及生命周期服务，公开导入仅允许copy。canonical根互斥、owner取消与完整能力撤销、异步完成前复核、失败关闭重试均有反例。`initialized`只表示资源管理已初始化，`inspectRuntime.verified`只证明静态资源身份，不代表模型推理可用。

新增16份native/overwrite脚本副本及7项外部依赖证明，45条精准规则共90次替换；另有4份runtime校验脚本/测试副本。来源可从固定Git重建，独立清单与T01/T02分开。新增namespace验收脚本是本阶段实现，不冒充历史来源。C++/binding.gyp及动态loader按准确源码hash审计。

完整双资源builder与组合beforePack已经落地，调用两套独立runtime/addon验证器，固定双贡献、目标矩阵及两套冻结目录的签名忽略规则。默认旧builder和旧源码不改。尚未注册转写UI/renderer IPC、全局应用退出钩子或transcript文档生产者。I1/I2整体用户验收保持pending。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-03-1 | 通过 | inline: `native-copy.mjs --check`16文件/7依赖、`tooling-copy.mjs --check`4文件、T02 `copy.mjs --check`120文件通过；来源反例10+5通过，包含目标冲突、遗漏、漂移、clean filter执行前拒绝。root独立核对16份原生副本源hash和45条变换；实际边界289文件0错误 |
| V-TRANSCRIPTION-03-2 | 通过 | inline: 15项runtime集成测试通过；真实微型GGML头/hash/复制后删除源再重开、缺资源/篡改、copy-only、不同实例和owner、异步撤销、初始化/关闭竞态、失败清理重试与根锁、相邻模拟旧目录保留 |
| V-TRANSCRIPTION-03-3 | 通过 | inline: 8项组合检查；electron-builder实际getConfig+validateConfig通过完整配置。两套真实runtime验证器覆盖缺manifest/篡改/错架构/缺license；去掉旧源码/资源的隔离树可独立装载新版两套验证器。真实默认hook在宿主通过旧资源后按预期拒绝缺新版staging |
| V-TRANSCRIPTION-03-4 | 通过 | inline: 真实macOS arm64重复构建字节一致，最终嵌套ad-hoc签名/strict校验后取hash；Electron41.10.6独立加载生产组件、事务、54项故障恢复、4项命名空间隔离通过。23项原生node测试：沙箱22通过，staging一项在真实宿主定向复验通过 |
| V-TRANSCRIPTION-03-5 | 通过 | inline: 最终普通回归1031通过，来源/回放35通过，runtime/packaging node测试30通过；真实边界、两套TS、i18n、规格ready/done及diff通过。未安装依赖/启动前端服务，测试进程和临时fixture已清理 |

普通回归由679项T02正常测试、15项runtime及337项I1/边界测试组成。另有18项需显式环境的I1 UI/真实API/本地文件测试按原开关跳过，本轮无UI改动，不能据此宣称再次完成UI/真实服务验收。node runtime测试22通过、1项Windows专属检查跳过；组合8项通过。35项维护测试为T02配对回放20、native来源10、tooling来源5。

模型导入测试消费真实资源管理器和supervisor，但使用合成child、签名适配器与微型GGML；证明复制和生命周期行为，不能冒充真实ASR。

### 验收标准对应

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-03-1 | 通过 | V-TRANSCRIPTION-03-1 |
| AC-TRANSCRIPTION-03-2 | 通过 | V-TRANSCRIPTION-03-2 |
| AC-TRANSCRIPTION-03-3 | 通过 | V-TRANSCRIPTION-03-2 |
| AC-TRANSCRIPTION-03-4 | 通过 | V-TRANSCRIPTION-03-3 |
| AC-TRANSCRIPTION-03-5 | 通过 | V-TRANSCRIPTION-03-4, V-TRANSCRIPTION-03-5 |

### 关键命令和宿主诊断

```sh
node scripts/subtitle-studio-provenance/copy.mjs --check
node scripts/subtitle-studio-provenance/native-copy.mjs --check
node scripts/subtitle-studio-provenance/tooling-copy.mjs --check
node node_modules/vitest/vitest.mjs run test/subtitle-studio --exclude 'test/subtitle-studio-provenance/**' --maxWorkers=1 --minWorkers=1
node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance/replay.test.ts test/subtitle-studio-provenance/native-copy.test.ts test/subtitle-studio-provenance/tooling-copy.test.ts --maxWorkers=1 --minWorkers=1
node --test scripts/subtitle-studio/transcription/runtime/*.test.mjs scripts/packaging/*.test.mjs
node --test scripts/subtitle-studio/transcription/overwrite-native/*.test.mjs
node scripts/subtitle-studio/check-boundaries.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.node.json
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
python3 /Users/qiuyedx/.agents/skills/spec-driven-ai-coding/scripts/check_spec.py docs/features/subtitle-studio --stage ready --require-approval
python3 /Users/qiuyedx/.agents/skills/spec-driven-ai-coding/scripts/check_spec.py docs/features/subtitle-studio --stage done --require-approval
git diff --check
```

原生实物编译/签名/验收编排保存在本机忽略目录`test-results/subtitle-studio-native-20260912-t03/run-acceptance.mjs`；namespace测试修正返回值断言后，由`finish-acceptance.mjs`复用已生成实物、重新验证签名并运行最终namespace脚本。生产和恢复报告与最终摘要均核对hash；既有16份来源副本没有变化。

受限沙箱内Electron会在exit0及正确exports的同时输出`task_name_for_pid: (os/kern) failure (5)`，因此严格staging探针拒绝。定向使用真实宿主权限重跑后stderr为空并通过；未放松验证。完整默认beforePack同样在宿主复验，实际旧贡献通过后报`contribution=studio / ENOENT`，最终cause是`build/subtitle-studio-resources`不存在。此结果证明缺新版正式资源时阻止打包，不是完整打包通过。

### 实物与来源摘要

| 产物 | SHA-256 |
| --- | --- |
| T01 baseline（未变） | c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66 |
| T02 fork（未变） | 993e57a72b3a191e8ba6afe50d90899baefd4f6af4f8f62ad25cc3d6371befa3 |
| T03 native fork | 8cb95bb1fbe2f8096b7faed52472589e2a925e5c9eba809f7916564ad1768c4b |
| T03 tooling fork | 028bf36c819412999935b25f15b5468a851495881798e64bfb733ea814a4a8f7 |
| 未签名production addon，132960字节 | a605a46a3b8d319d11bb61c515b987fae1e5d118115aa4bf2214a22ea410554b |
| 最终ad-hoc addon，150304字节 | 0e86674a51ea1f78f8a9cc5295a21e948a94f707b999d195f3582ee703021d81 |
| 测试专属fault addon，133264字节 | 0153994f8a588f51090c8a58892848a32070db26b503eec0c95362bc343b9def |
| acceptance-summary.json（本机test-results） | 9799f3fcda28ce2e6e640391dd600e72616a4aadb02b6f10215dc676f312f6c0 |

最终签名标识`com.fusionkit.subtitle-studio.overwrite`，原生生产协议4、N-API8，实际Electron内Node24.18.0。生产报告覆盖4种终态、2种open、2种冲突及恢复/拒绝/清理；故障版在新子进程中执行54个恢复案例；namespace覆盖旧partial拒绝、旧prefix/suffix journal忽略与新版finalize/acknowledge。验收报告和二进制位于忽略目录，不随Git同步；本记录与源码快照随仓库保存。

## 风险与未执行项

本机没有Developer ID签名身份。当前旧ASR staging存在合法旧二进制，但没有本轮新版可复现的FFmpeg/Whisper构建输入及回执；不能复制旧ready声明或改路径冒充完整新版ASR staging。本阶段真实native证据限新版addon；组合hook必须在完整新资源缺失时阻止打包。

Windows原生运行、完整新ASR资源构建、真实音频/GPU、转录文档及UI、外层签名/公证和共存/删除后的完整应用包仍需后续验收。未来双工具外签要忽略两套已冻结native根并前后核对hash，macOS26对osx-sign1.0.5使用系统codesign严格复核，不调用只忽略旧根的签名脚本。

本轮测试仅对隔离临时目录中的合成文件进行复制/原生事务，不读取真实userData/模型/媒体；无pnpm、依赖锁变更或发布。fixture已清理，tsbuildinfo已移除，原生/Electron测试子进程已退出；保留上述忽略目录证据。按项目避坑规范保留签名后hash与严格探针，并新增FK-PIT-0134记录抽离runtime时不能遗漏独立能力注册表撤销。
