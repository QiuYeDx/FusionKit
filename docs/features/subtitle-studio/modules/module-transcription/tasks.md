# I2 任务台账

当前已完成T01来源冻结、T02独立副本/回放、T03独立runtime/本机原生验证及T04最终转录文档生产者。下一项细化任务准入/队列及应用接线，再接转写UI；完整ASR资源及真实对照仍待后续，见requirements.md与transcription-fork.md。

### T-TRANSCRIPTION-01 生产基线、依赖与资源来源冻结

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-01 |
| 验收 | AC-TRANSCRIPTION-01-1, AC-TRANSCRIPTION-01-2, AC-TRANSCRIPTION-01-3, AC-TRANSCRIPTION-01-4 |
| 依赖 | T-WORKSPACE-06, T-WORKSPACE-08 |
| 写集 | scripts/subtitle-studio-provenance/, resources/subtitle-studio/provenance/, test/subtitle-studio-provenance/, docs/features/subtitle-studio/modules/module-transcription/, docs/features/subtitle-studio/records/ |
| 负责人 | Codex root |
| 依赖确认 | T-WORKSPACE-06 已集成于002be2d；T-WORKSPACE-08及界面跟进已集成于a742746至3a0f50e；已核对Git祖先及当前源码，并复跑334项模块回归和130文件实际边界检查；旧转写来源保持3a0f50e |
| 完成日期 | 2026-09-11 |
| 实施记录 | records/2026-09-11-transcription-baseline.md |
| 集成版本 | 3a0f50e加本轮未提交维护工具/规格工作树；最终基线SHA-256 c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66，完整工具摘要见记录 |

#### 实现要点

沿本模块设计冻结固定提交，不修改旧业务。root 独占规格、基线生成产物及集成；baseline_checks 独占维护脚本与对应测试；另外两名审查者只读代码，可写临时清单，不能修改同一基线。共享策略由消息确认后单写，不并行更新生成 JSON。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-01-1 | unit | required | 隔离仓库覆盖稳定重建、源内容漂移、文件遗漏、未解析依赖、目的冲突和篡改拒绝 | - |
| V-TRANSCRIPTION-01-2 | integration | required | 当前3a0f50e生成基线，历史重建和工作树对照；核对每项hash、输出无绝对路径与未发生的复制/实测结论 | - |
| V-TRANSCRIPTION-01-3 | manual | required | 审查主进程/类型/默认值闭包、测试fixture、原生及构建资源、字符串边界、拟议复制与排除理由 | - |
| V-TRANSCRIPTION-01-4 | static | required | I1实际源码边界、模块回归、两套TypeScript、i18n、规格ready/done及git diff --check | - |


### T-TRANSCRIPTION-02 独立源码副本与等价回放

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-02 |
| 验收 | AC-TRANSCRIPTION-02-1, AC-TRANSCRIPTION-02-2, AC-TRANSCRIPTION-02-3, AC-TRANSCRIPTION-02-4, AC-TRANSCRIPTION-02-5 |
| 依赖 | T-TRANSCRIPTION-01 |
| 写集 | scripts/subtitle-studio-provenance/, test/subtitle-studio-provenance/, electron/main/subtitle-studio/transcription/, src/subtitle-studio/transcription/, resources/subtitle-studio/transcription/, resources/subtitle-studio/provenance/, test/subtitle-studio/transcription/, test/subtitle-studio/boundaries.test.ts, scripts/subtitle-studio/, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-01来源3a0f50e及已集成共享工作树可用；基线SHA-256 c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66，开始时核对既有副本工具、任务和工作区，不覆盖上轮未提交结果 |
| 完成日期 | 2026-09-11 |
| 实施记录 | records/2026-09-11-transcription-copy-replay.md |
| 集成版本 | 3a0f50e加本次未提交共享工作树；120文件副本，fork SHA-256 993e57a72b3a191e8ba6afe50d90899baefd4f6af4f8f62ad25cc3d6371befa3；完整工具及回放证据摘要见记录 |

#### 实现要点

root独占规格、边界规则、最终记录与整合；baseline_checks独占copy工具/策略、生成的新生产/类型/资源/正常测试副本及fork provenance；workspace_progress独占维护侧replay测试/harness/输入表；broader_roadmap只读审查资源/命名空间。T01工具与冻结baseline不改。写权细分通过协作消息登记，临时旧树只用于迁移验证、不注册服务。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-02-1 | unit | required | 复制工具反例：固定重建、精准变换、缺依赖/源漂移、覆盖/目的冲突拒绝、实际目标hash校验 | - |
| V-TRANSCRIPTION-02-2 | integration | required | 实际副本生成及重建校验、T01旧来源对照；逐文件检查修改仅为允许的路径/身份变换，原生/脚本递延有理由 | - |
| V-TRANSCRIPTION-02-3 | integration | required | 隔离新旧执行器完整transcript/请求/窗口/回退配对；窗口策略、quiet、重复/未知句界、overlap、DTW矩阵与预期路径断言 | - |
| V-TRANSCRIPTION-02-4 | integration | required | 实际签发的backend/accelerator/batch runtime/PCM-window双向跨副本拒绝；有效本侧正例保留 | - |
| V-TRANSCRIPTION-02-5 | static | required | 新版正常回归、真实业务依赖边界、两套TypeScript、i18n、I1模块回归、spec ready/done与diff检查 | - |

### T-TRANSCRIPTION-03 独立资源工厂与原生构建组合

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-03 |
| 验收 | AC-TRANSCRIPTION-03-1, AC-TRANSCRIPTION-03-2, AC-TRANSCRIPTION-03-3, AC-TRANSCRIPTION-03-4, AC-TRANSCRIPTION-03-5 |
| 依赖 | T-TRANSCRIPTION-02 |
| 写集 | native/subtitle-studio-overwrite/, scripts/subtitle-studio/transcription/, scripts/subtitle-studio-provenance/, resources/subtitle-studio/provenance/, electron/main/subtitle-studio/transcription/, test/subtitle-studio/transcription/, test/subtitle-studio/transcription-runtime.test.ts, test/subtitle-studio/helpers/, test/subtitle-studio-provenance/, test/subtitle-studio/boundaries.test.ts, scripts/subtitle-studio/, scripts/packaging/, electron-builder.subtitle-studio.json, .gitignore, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-02共享工作树已集成于3a0f50e加未提交副本，120副本fork SHA-256 993e57a72b3a191e8ba6afe50d90899baefd4f6af4f8f62ad25cc3d6371befa3；20项回放及679新版回归已通过，当前核对未提交结果和冻结来源并复跑copy --check通过，不修改T02机械副本 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-runtime-native.md |
| 集成版本 | 3a0f50e加T01/T02及本次共享工作树；42文件集成快照SHA-256 cfba72e89fc0320771051c2484aac4273d0fec6fd5f2194c13d2ce403a52d86b；新版native/tooling fork和真实签名后addon摘要见实施记录 |

#### 实现要点

root独占规格/边界/最终集成；baseline_checks独占native、overwrite-native脚本与native来源工具/测试/记录；broader_roadmap独占runtime构建校验脚本、双资源builder/组合hook与tooling来源记录；workspace_progress独占runtime工厂与正常测试。shared runtime-manifest/staging-contract由broader_roadmap单写并提供给native；不修改T01/T02清单和机械副本。所有新增来源记录分文件单写，不由多个agent更新同一JSON。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-03-1 | unit | required | native/tooling来源hash和准确变换重建；旧源对照、目标冲突拒绝；生产源码/脚本新版闭包与动态装载审计 | - |
| V-TRANSCRIPTION-03-2 | integration | required | 独立runtime工厂/owner/目录、copy-only导入及源删除后副本可用、并发初始化/关闭、失败重试与清理、无旧目录修改 | - |
| V-TRANSCRIPTION-03-3 | integration | required | 完整双资源builder配置校验、逐贡献真实验证器调用、错映射/错平台/缺失/篡改负例、新版单贡献独立验证 | - |
| V-TRANSCRIPTION-03-4 | integration | required | 当前macOS arm64实际新版编译、ad-hoc签名、最终hash、Electron独立加载和事务/恢复；分开登记Windows及完整app实跑待验 | - |
| V-TRANSCRIPTION-03-5 | static | required | 新增正常回归、T02回放、真实边界、两套TypeScript、i18n、spec ready/done及diff；清理本轮进程 | - |

### T-TRANSCRIPTION-04 最终转录文档生产者

| 字段 | 值 |
| --- | --- |
| 状态 | 已完成 |
| 批次 | I2 |
| 需求 | R-TRANSCRIPTION-04 |
| 验收 | AC-TRANSCRIPTION-04-1, AC-TRANSCRIPTION-04-2, AC-TRANSCRIPTION-04-3, AC-TRANSCRIPTION-04-4, AC-TRANSCRIPTION-04-5 |
| 依赖 | T-TRANSCRIPTION-03, T-WORKSPACE-06, T-WORKSPACE-08 |
| 写集 | src/subtitle-studio/, electron/main/subtitle-studio/, test/subtitle-studio/, scripts/subtitle-studio-provenance/, test/subtitle-studio-provenance/, resources/subtitle-studio/provenance/, scripts/subtitle-studio/, src/pages/Tools/Subtitle/SubtitleStudio/, src/locales/, docs/features/subtitle-studio/, .agents/skills/fusionkit-pitfall-guard/references/ |
| 负责人 | Codex root |
| 依赖确认 | T-TRANSCRIPTION-03共享工作树42文件快照cfba72e89fc0320771051c2484aac4273d0fec6fd5f2194c13d2ce403a52d86b与已集成I1源码可用；核对T03记录及当前schema/repository/executor实物，T-WORKSPACE-06与T-WORKSPACE-08已在HEAD3a0f50e祖先；保留未提交结果 |
| 完成日期 | 2026-09-12 |
| 实施记录 | records/2026-09-12-transcription-document.md |
| 集成版本 | 3a0f50e加T01/T02/T03及本次共享工作树；33文件集成快照SHA-256 e770f8180a7a0da230cbdce8004f5a119bf29b6e899b93cb0ec457b615d32d51；派生来源与13类配对/10项边界证据摘要见实施记录 |

#### 实现要点

按design T04独占写集分工；保持T02精确副本，新派生输出边界单独来源记录。只创建隔离文档，不开转写UI、不接真实模型。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-TRANSCRIPTION-04-1 | unit | required | 完整字段映射/旧schema兼容、100k边界/超限/坏word/重复id/快照字节拒绝 | - |
| V-TRANSCRIPTION-04-2 | integration | required | 派生精准变换重建、最终transcript配对、无文件export/输出授权、pipeline及task/batch cleanup与取消负例 | - |
| V-TRANSCRIPTION-04-3 | integration | required | sink实际仓库创建/重开、并发去重、owner/generation/signal发布前拒绝、提交故障/迟到取消/重试/墓碑不复活 | - |
| V-TRANSCRIPTION-04-4 | integration | required | 媒体文档翻译/分页/导出投影与损失，证据保持，原文件/双语保护及旧字幕兼容 | - |
| V-TRANSCRIPTION-04-5 | static | required | I1/T02与本轮回归、T02来源无漂移、实际边界、两套TS/i18n、ready/done、diff、进程清理 | - |
| V-TRANSCRIPTION-04-6 | browser | required | 隔离Electron媒体105cue/旧字幕，分页、原文件菜单、默认SRT、损失确认与实际输出，查看最终截图 | - |
