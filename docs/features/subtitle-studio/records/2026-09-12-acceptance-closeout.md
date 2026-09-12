# I3：六项人工验收完善收尾

## 版本与原始问题

2026-09-12用户要求先记录六项问题，再完整连续实施，原始内容见[问题记录](2026-09-12-manual-acceptance-findings.md)。基线为feat/subtitle-studio-transcription上的15340fd74752484df9982ab7ca894b7410577273；本轮工作树未提交。批准范围指纹d72f5d521a79b0ee73d2bd171a4576842824d646c11550f14f8c853f78e877bf保持不变。

四项技术任务已经完成，分别见[拖入接线](2026-09-12-acceptance-01.md)、[队列与总览](2026-09-12-acceptance-02.md)、[格式](2026-09-12-acceptance-04.md)、[来源与命名](2026-09-12-acceptance-05.md)。唯一任务状态在module-acceptance/tasks.md，用户整体验收仍pending。源码和最终证据摘要见[集成快照](2026-09-12-acceptance.snapshot.json)；原始日志及截图位于Git忽略的test-results。

## 实际结果

1. 文档工作区支持多字幕拖入，显示拖入高亮，按钮和拖入共用逐文件导入与错误结果。preload同步从真实File获取原生路径，固定内部通道不进入公共invoke；主进程独立验证窗口、frame、URL、能力和文件身份。解析Windows Shell代理使用独立Studio域的冻结解析器，未恢复真实源的代理不取得导出来源权限。
2. 转写队列可清理已完成、清理全部终态及批量取消；取消明确数量并使用确认时的目标集合。单飞操作复用既有单任务保护，运行和cleanupPending不能误删，部分失败逐项保留，已经生成的字幕文档不受队列清理影响。
3. 标题下显示全库翻译状态总数、真实本轮批次进度和详情入口。任务摘要先从全库统计再分页，与文档筛选/分页分离；本轮只包含实际提交成功的taskId，SPA切换保留，重启无本轮集合时只显示可证明的全局和单项进度。详情可打开当前筛选之外的文档。摘要不包含正文、checkpoint或模型凭据。
4. VTT/ASS贯通导入、持久重开、正文翻译、双语映射、四格式原文/译文/双语导出。VTT头部、NOTE/STYLE/REGION、cue ID/settings及ASS样式、Comment、Text内逗号和未知section保留。同格式用已验证文本范围补丁保留结构，普通输出按用户选择LF/CRLF，原始下载保持字节。跨格式明确列出实际元数据、样式、定位、效果、精度等损失。Unicode字节计数及CR-only输入也有回归。
5. 字幕导入保存实际输入/父目录身份到主进程私有来源记录；转写在仍持task lease、即将发布成功文档时惰性捕获所选音视频来源。源记录持久化并在发布前复核。单份、批量和原始导出均可选来源目录，批量逐文档保存；旧记录缺来源时可通过原生目录选择明确重绑。重绑使旧导出计划失效，来源丢失不会阻止预览、翻译或另选位置。
6. 默认名称只有原名称和格式扩展名，取消强制source/target/bilingual/partial后缀。提供内容模式、目标语言预设及受限自定义片段，预览与发布一致。来源目录始终不覆盖，冲突只加必要序号。原生保存接受默认建议时，从原始无序号名称重新分配；Windows等价路径大小写不再误授权覆盖。

## 实际Electron验收

最终统一构建为直接Node20运行Vite build --mode=test，未调用electron-builder。三个隔离Electron场景在同一最终构建上全部通过，共59.59秒，日志studio-i3-ui-final.log。renderer/main/preload和repository实际执行；受控翻译响应与受控转写runtime只服务确定性界面验证，不冒充供应商或ASR质量。

- 文件流程：studio-i3-files/run-Rqns5c，6张图和result.json。原生OS-backed File通过DragEvent进入生产preload/main，VTT/ASS成功、txt逐项拒绝；实际翻译2次、VTT结构保留、ASS可选后缀、跨目录批量SRT、原始ASS字节一致，重启后两来源ready；模拟历史缺少私有来源记录后，经原生重绑、重新计划成功发布。原输入保持不变，pageErrors为空。
- 队列/总览：studio-t06-ui/controlled-a5AmdM，7张图、逐图geometry与i3-evidence.json。清理完成文档保留、清理中保护、取消快照排除确认后新任务、全库27项分页20+7、筛选及第二页以外文档打开、真实2项本轮进度50%到100%、SPA保留、Esc返回焦点均通过。errors为空，electronExited/serverClosed均true。
- 既有布局：subtitle-studio-height，五种窗口和展开诊断/原始内容分页通过。1280×860、1106×756、786×540、786×900、1440×1100下reader高度依次420/304/140/492/660px；标题栏间距12–16px，底部留白6px，外层溢出0。展开诊断后可在面板内滚到完整字幕，底部分页保持可达。

root直接审阅最终总览窄窗、键盘返回后的字幕阅读区、VTT/ASS已翻译浅色界面；也审阅同一最终renderer CSS的宽窗及展开诊断读屏，以及最终导出布局之前仅标题微调的深色弹窗。队列图与导出图此前完整审阅，最终三场景未留下读屏错误或遮挡。测试app/profile和本轮服务已退出，未启动用户生产资源迁移或修改真实文档。

## 验证与修复依据

环境为Windows x64、Node20.19.4、Electron41.10.6、Vitest2.1.9、TypeScript5.9.3。直接Node入口运行工具，Vitest普通回归最多2 workers，UI场景1 worker。

| 检查 | 实际结果 |
| --- | --- |
| 字幕/共享资源/来源广回归 | 最初1624项通过，1项旧runtime权限断言未包含新增derive_source_output；改为真实lease及目录身份验证后19项专项通过。后续广回归1622项通过，3项来源检查在最后Windows主入口修正期间因当前审计摘要过期正确拒绝；未降低守卫，更新当前组合审计后受影响7项来源及最终23项IPC全部通过（studio-i3-final-audit-regression.log，30项）。29项条件跳过主要为单独运行的UI/真实设备等入口，不冒称全设备通过 |
| 格式 | studio-i3/formats-final.log：7文件180项，含新增36项及既有双语/媒体回归；与广回归有重叠，不累加 |
| 队列/总览 | studio-i3/queue-overview-unit.log：39项；全库摘要与File桥7项及来源23项均包含在普通回归 |
| TypeScript | studio-i3-ts-final.log、studio-i3-ts-node-final.log、studio-i3-ts-tests-final.log均exit0；测试专属配置覆盖新增验收/IPC/布局/runtime，修复了测试局部nativeWindow遮蔽DOM window及mock context的精确类型收窄 |
| i18n | studio-i3/queue-overview-i18n.log：四语言447 studio键、全库2306键及使用检查通过，18条既存同源提示保留 |
| 构建与边界 | studio-i3-build-final.log根测试构建、实际preload只依赖electron、395文件0边界错误；当前集成11项/legacy审计5项精确通过，冻结ASR源码和来源baseline未改 |
| 规格与格式 | ready授权检查范围未变；done/overall/diff最终检查通过，各任务有实际V/AC证据和独立用户验收状态 |

实际发现并修复的布局问题是：外层卡片未越界，但内层Grid的120px固定最小行在总览/译文工具条占用空间后延伸到页脚后。普通状态改为按剩余空间缩放；明确展开诊断时保留最小阅读区并使用面板滚动。既有中窗300px阅读面积及标题对齐要求继续保留，未放宽测试。旧布局测试的“下一页”在文档库也有分页后改为明确定位字幕页脚。

独立主入口复查还用真实Windows路径证明C:/与c:/对应同一对象，而默认保存路径的严格比较会误入replace。两项普通/原始导出竞争测试修前失败、修后通过，源和竞争文件保持原样，输出为sample (2).lrc。只更新当前组合摘要和理由，未改冻结复制清单。两项经验分别沉淀为FK-PIT-0145和0146。

## 风险与未执行项

VTT复杂ruby/内部时间戳、ASS karaoke/混合绘图及不能安全重排的复杂控制结构会明确限制自动翻译；原始内容仍可保存，同格式能保留的结构不静默丢弃，跨格式损失需确认。本轮不是ASS特效编辑器，未声称所有复杂字幕都可无损改写。

來源检查在Node路径文件操作前后验证身份，不能宣称彻底消除身份检查与最终syscall之间的所有替换窗口；来源目录只使用不覆盖发布。旧文档没有可信记录时不猜来源。本轮原生File拖入验收不是物理Explorer长路径手势录制，Shell代理隔离负例和冻结解析器回归另有覆盖。

用户整体验收保持pending，Windows技术验证不替代macOS、真实翻译供应商质量、新GPU矩阵或安装包验收。按用户指令继续暂停打包演练；本轮尚未提交推送，I4编辑后置。
