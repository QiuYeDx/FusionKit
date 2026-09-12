# I6 第三轮交互优化：综合收尾

2026-09-13，分支`feat/subtitle-studio-transcription`。用户七张截图的十项问题已先记录，再按四项任务完整实现和验证。基线为`3855c2c72bfa45740f248406f7266cf0342ae1f6`加I5未提交工作树；开始前已核对I5快照的65个源码文件字节一致，保留所有已有工作。本轮没有提交请求，I5/I6均未提交，打包与I4编辑继续后置。

## 实现与反馈对应

| 用户项 | 完成行为 | 实施记录 |
| --- | --- | --- |
| 1、2 | 进度槽在浅深hover下清晰可辨；自动翻译短标签并入元数据行，完整提示按需显示，停止/错误能力保留 | [T01](2026-09-13-interaction-01.md) |
| 3 | 复制按钮打开明确菜单：原文、译文、双语，以及带时间信息的相应内容；不猜译文或未知结束时间 | [T02](2026-09-13-interaction-02.md) |
| 4、5 | 已选文档在编码与换行之前；导出检查进入独立确认内容，摘要先行、逐文件默认折叠，明确确认后实际写入 | [T03](2026-09-13-interaction-03.md) |
| 6 | 导入、翻译提交、导出、原始下载及管理结果统一为简洁成功/失败/跳过总览，清单按需展开 | [T02](2026-09-13-interaction-02.md)、[T03](2026-09-13-interaction-03.md)、[T04](2026-09-13-interaction-04.md) |
| 7、8、9 | 工作台标题内边距适度缩小；宽窄/滚动切换起点一致；翻译概览仅归属文档侧栏，窄窗提供紧凑入口 | [T04](2026-09-13-interaction-04.md) |
| 10 | 全选只更新选择，已有页面立即响应；跨页查询仅局部pending，旧响应不覆盖后来的清除/筛选/切页意图 | [T04](2026-09-13-interaction-04.md) |

## 验证版本与结果

环境为Windows x64、Node20.19.4、Electron41.10.6、Vitest2.1.9、TypeScript5.9.3。最终构建日志`test-results/studio-i6/build-layout-final.log`，renderer入口`index-CevJ6Vg-.js`和`index-k4Tr7WaQ.css`。本轮renderer多次修复期间main/preload字节始终一致，精确SHA和完整未提交源码见[快照](2026-09-13-interaction.snapshot.json)；快照另标记每个文件相对I5是新增、修改或未变。

| 检查 | 实际结果与证据 |
| --- | --- |
| 相关单元 | 6文件共79项不同用例通过。`related-unit.log`的56项与`export-guard-unit.log`的30项有7项batch-service重叠，不直接相加。覆盖复制文本、reader协调/观察、导出计划、服务与批量保护。 |
| 生产与测试类型 | `frontend-types-final.log`、`node-types.log`及`test-types-final.log`均exit0；后者覆盖本轮新增及适配验收文件。main源与I5一致。 |
| i18n | 四语言键完整；usage扫描2177调用、2146静态/有限、31清单项、2214可解析key，通过。已有SAME提示保留。 |
| 边界/构建 | 422源码文件边界无错误；最终构建成功、preload仅外部electron检查通过。仅保留既有large chunk警告，不执行electron-builder。 |
| 最终UI | 下表10套实际Electron场景均通过；在最终renderer上串行运行，避免独占窗口焦点冲突。 |
| 清理 | `process-cleanup.json`匹配本轮Node/Electron进程为空；4个明确profile均不存在。各套finally及对应cleanup记录覆盖实例/HTTP服务/临时目录；复制原剪贴板常用格式已恢复。 |
| 规格/差异 | `spec-ready-final.json`批准范围匹配、0错误0警告；最终done/overall及git diff检查保存在`test-results/studio-i6`。这只证明结构/声明完整，不代替实际UI和字节验证。 |

| 实际Electron套件 | 用例/耗时 | 最终证据 |
| --- | --- | --- |
| interaction-workspace | 1/1，46.48s | `studio-i6-workspace/run-Z3MnOD`及workspace-ui-complete.log |
| acceptance-live-refresh | 1/1，12.98s | `studio-i5-refresh/run-eQwP6m`及live-refresh-attempt-01.log |
| vertical-layout | 1/1，13.56s | `subtitle-studio-height`及vertical-layout-attempt-01.log |
| library-ui | 1/1，80.29s | `studio-library/evidence.json`及library-attempt-01.log |
| interaction-queue | 1/1，19.65s | `studio-t06-ui/controlled-wKEdLm/i6-queue-result.json`及queue-ui-final.log |
| interaction-export | 1/1，14.83s | `studio-i6-export/run-cMYu0E`及export-ui-rerun4.log |
| export-ui | 1/1，54.39s | `subtitle-studio-export`及export-regression-ui.log |
| acceptance-files | 1/1，23.10s | `studio-i3-files/run-rN1OoS`及export-regression-ui.log |
| experience-export | 1/1，17.98s | `studio-i5-export/run-0OKPhv`及export-regression-ui.log |
| interaction-copy | 1/1，16.00s | `studio-i6-copy/run-DuwGwO`及copy-ui-final.log |

表中目录均位于`test-results/`；workspace旧回归日志位于`studio-i6-workspace/`，其余根日志位于`studio-i6/`。各组已直接审阅宽浅/窄深、长名称、键盘、错误及按需详情截图，root另复核关键界面；导出组共32图，队列6图。最终证据文件路径和哈希保存在版本化快照中，本地PNG与隔离数据不提交。

## 复验发现与修复

实际布局验收发现三处生产问题，均修复后重建复验：文档沿用32px空间预算使40px标题占位被压缩8px；窄长转写又因祖先flex默认min-height把占位压为0；紧凑总览controlled dialog关闭后缺少焦点返回。现工作台限定标题占位不可收缩、主ScrollArea可缩小并实际滚动，内容仍可到达底部；两种总览入口共用关闭回焦逻辑。最终宽窗两视图header top40/content top120，窄窗top40/116，严格相等。另在代码复核时补全局部pending可见反馈、修正导出仅统计真正就绪项的字幕数，并确保全失败结果无绿色成功0。

全选误用foreground reader导致全页busy的原因与防回归方式已沉淀为FK-PIT-0149。项目避坑流程使本轮从动作状态与迟到请求处理修复问题，未靠隐藏loading样式掩盖闪烁。

测试假设的修正单独记录：双语导入样本需达到既有3组识别门槛；Windows剪贴板比较只规范CRLF；Radix标签使用实际键盘处理、文本断言统一可见innerText避免计入已有sr-only名称；tooltip退出与新提示暂存时使用精确提示匹配；导出几何按实际contents/footer结构取值并等待入场动画稳定，保留32px动作严格断言，窄窗文档库操作走其对应入口。未为通过测试放松业务守卫。workspace一份失败日志曾被重跑覆盖，attempt-notes.json明确为回溯诊断记录；没有伪称恢复原日志。其他失败日志与最终成功记录分开保留。

## 风险与未执行项

用户整体验收保持pending，技术通过不代签接受。队列仅以既有受控原生runtime及返回摘要装饰覆盖视觉状态，不作为新的ASR/自动翻译质量证据；翻译测试使用本机受控HTTP。过期译文视觉仅装饰真实read-page响应的cue修订，不代表完成I4编辑；导出TTL只推进自有Electron主进程Date.now并恢复，全部失败只临时移动测试输入并恢复/核对哈希。File拖入回归使用真实OS File和生产bridge，不声称额外执行了物理资源管理器手势。未进行新的设备矩阵、真实供应商质量评估、打包、签名、发布或提交推送。
