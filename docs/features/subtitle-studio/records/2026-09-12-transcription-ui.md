# T06 转写工作区与文档交接

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-09-12 |
| 任务 | T-TRANSCRIPTION-06 |
| 验证版本 | feat/subtitle-studio-transcription，e80ef6b加既有T05及本次工作树；24文件快照2026-09-12-transcription-ui.snapshot.json，SHA-256 0ed05341d32e5b287bb86ba51c0097ee99fb4ccfb5a995ef5502c0a824d2eaae |
| 环境 | Windows x64，Node24.19.0，TypeScript5.9.3，Vitest2.1.9，Electron41.10.6；使用既有依赖，无下载模型或依赖安装 |
| 授权 | T05交付及转写UI下一步说明后，用户原文“好的，继续推进工作吧”；I1/I2整体验收保持pending |
| 任务指纹 | 218408e291a3be92f9549d39b3224f8e19829b4773b456b4135dbb788e0f2fd0 |

## 实际结果

工作台增加文档/转写视图，复用现有ToolDetailLayout、圆角ClipPathTabs、配置/文件面板、文件名提示和资源对话框。媒体每次最多20份，支持多音轨、探测重试和撤销；模型/VAD/GPU资源准备只调用新版固定API。配置继承生产默认值，高级参数支持中间编辑态和有界校验。缺运行环境和缺模型分别展示，不能通过下载模型伪装原生就绪。四语言文案完整。

新renderer会话controller惰性启动，SPA切换保留有效草稿、任务、配置及待撤销能力；活跃工作有界轮询，后台空闲停止。任务提交单飞并捕获媒体/配置；明确成功后消费草稿能力，异常或畸形成功回执保持未知状态并阻止自动重复提交。迟到任务/资源快照不覆盖本地修改，撤销异常和ok:false均保留限次退避及到期回收。取消持续观察至终态，清理未完成任务禁止移除。

新增probeTranscriptionMedia固定方法只接受当前owner token，沿用frame/URL/capability与legacy拒绝；返回严格消毒的探测摘要。完成任务先等待当前文档库操作，分页发现同一文档取得合法读取权限，再清除旧筛选并打开真实统一文档。既有文档组件保持挂载，原翻译/导出状态不因工作区切换丢失。

## 渲染复查与修复

基线为本机实际Electron内24行字幕的原工作台。首轮实际资源缺失状态和受控完整流程暴露三处问题：顶层ClipPathTabs默认w-fit使空/短内容工作区缩窄；高级参数在每次按键时强制有效数字会阻止清空后输入；完成文档自动刷新期间点击查看被当作revision_conflict。分别修为工作区明确全宽、独立数字文本草稿及有效性、加入现有reader操作的settlement Promise后再发现目标。额外修复空媒体面板双分隔线、文件名flex空间和按运行目标筛选GPU选项。

Electron测试使用两种隔离应用：真实生产main/preload/renderer且无新版staging，验证运行时确实missing；另一种按精确模块路径替换新版runtime的测试入口，保持真实注册、IPC、preload和文档仓库，控制资源/任务过程并写入真实105cue文档。构建工具esbuild只在准确测试helper被边界允许，不给生产代码全局豁免。测试模型及推理结果是合成数据，不能作为真实ASR、质量或GPU证据。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TRANSCRIPTION-06-1 | 通过 | inline: controller21项覆盖生产默认值对照、惰性/订阅重入、活跃与闲置轮询、去重/限额/过期、探测迟到和撤销超时/失败/重入退避、明确失败/未知/畸形成功回执、任务与资源迟到快照、取消和资源准备 |
| V-TRANSCRIPTION-06-2 | 通过 | inline: 转写IPC11项及原有IPC19项通过；固定probe方法、严格输入和输出、owner/frame/导航失效、legacy拒绝及实际preload接线 |
| V-TRANSCRIPTION-06-3 | 通过 | inline: 新Electron2项通过（43.98秒）：实际资源缺失main；受控runtime下真实选择器/固定IPC/资源导入与安装取消/音轨/数字输入/SPA任务保持/各阶段和清理锁。已有搜索Archive且库正在刷新时，结果位于第2页，单次查看打开真实105cue文档并分页读回 |
| V-TRANSCRIPTION-06-4 | 通过 | inline: 最终controlled-en4NpL内01资源导入、02媒体/02b长名Tooltip、03队列、04真实文档第2页、05深色窄窗口错误、06键盘设置、06b高级参数和07资源Dialog均已查看；actual-missing-6ttAyZ实际缺失截图已检查。真实窗口1280×860/786×540，CSS视口1279/785（边框差），DPR2；宽侧留白32px、无横溢出、短文件名尾部完整、错误位于dock上方 |
| V-TRANSCRIPTION-06-5 | 通过 | inline: 普通回归1161通过/22按环境开关跳过；来源/回放75通过，120副本copy检查通过，316文件实际边界无错误；两套TS、四语言完整性和使用检查、根Vite test构建/preload及规格门禁通过。另行实跑既有工作台1项及媒体文档/原字幕导出1项，全部通过 |

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TRANSCRIPTION-06-1 | 通过 | V-TRANSCRIPTION-06-1, V-TRANSCRIPTION-06-2, V-TRANSCRIPTION-06-3 |
| AC-TRANSCRIPTION-06-2 | 通过 | V-TRANSCRIPTION-06-1, V-TRANSCRIPTION-06-3, V-TRANSCRIPTION-06-4 |
| AC-TRANSCRIPTION-06-3 | 通过 | V-TRANSCRIPTION-06-1, V-TRANSCRIPTION-06-3 |
| AC-TRANSCRIPTION-06-4 | 通过 | V-TRANSCRIPTION-06-3, V-TRANSCRIPTION-06-5 |
| AC-TRANSCRIPTION-06-5 | 通过 | V-TRANSCRIPTION-06-4, V-TRANSCRIPTION-06-5 |

本机日志位于test-results/studio-t06-regression.log、studio-t06-provenance.log、studio-t06-ui-final.log、studio-t06-workspace-ui-final.log、studio-t06-existing-ui.log、studio-t06-tsc.log、studio-t06-tsc-node.log、studio-t06-i18n.log及studio-t06-build-final.log。1161已包含本轮controller/IPC/边界普通测试，不重复叠加计数。22个环境场景中本次另实跑新UI2项、原工作台1项、媒体文档1项；其他供应商/原生场景未跑。资源/任务fixture和实际生产runtime证据分别保留build-evidence.json、fixture-trace.json或actual-runtime.json；测试不会复制使用真实用户数据。

旧workspace UI脚本原先全局匹配唯一Tab，现按文档内Tab限定选择器。一次完整脚本在主题重载的全局preload loading等待处间歇超时，未取得当时可见性证据，不能认定根因；加入失败取证后独立重跑通过（37.63秒测试时间），未修改全局加载器或放宽等待条件。新UI最终两场景无renderer错误。窄窗口高级参数首张截图曾在展开前滚动，现等待过渡后重新居中取证；没有将旧无效截图列为最终证据。项目避坑新增FK-PIT-0139/0140记录真实文档交接与content-sized Tab布局经验。

## 风险与未执行项

尚未准备完整新版FFmpeg/Whisper staging及真实资源回执；Windows原生实物、ASR/GPU、有界新旧效果对照、共存/移除后的完整安装包及签名验证留后续任务。用户整体验收未代签；本次不提交、推送或发布。

全部本轮Electron实例及原生测试进程已关闭，最终进程表无本项目测试服务残留。T05快照中28文件保持原字节；本次涉及的10个既有文件均进入新的24文件快照，没有覆盖其他T05未提交结果。最终spec done与diff检查通过。
