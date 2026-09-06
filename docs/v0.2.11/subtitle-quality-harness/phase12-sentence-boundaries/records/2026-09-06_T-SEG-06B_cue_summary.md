# T-SEG-06B 最终超建议值统计与任务说明

2026-09-06，基线5d9837b加06A工作树，用户授权继续，按设计6.32。以最终canonical字幕和任务快照建议值统计，替代直接展示增强前preservedSegmentCount的错误口径。待代码/协议/真实界面验证完成后关闭。

## 实现与口径

新增cue-summary.ts，在最终导出成功时按标准化任务快照建议值统计总数/超建议值条数；一条满足多条件仍只计一次。不使用增强前的preservedSegmentCount，不更改文字、时间或分段。类型cueSummary为可选字段，旧任务未统计时不显示0。JobManager只复制两个有界整数到完成事件和快照，丢弃额外内部字段；严格IPC拒绝额外键、无效数值及非完成任务携带统计，重试清除旧值。

任务行新增总条数，超建议值时可展开说明。明确这可能来自时长、总字数或行长超出本次任务建议值，不代表识别错误。四语言均有完整文案，普通说明颜色、原生details交互；设置及任务完成状态不变。

首次测试发现调用应使用createSubtitlePostProcessPolicy读取标准化advanced建议值，不能直接传inference对象；类型检查和实际计数断言共同捕获，修正后通过。测试事件断言也修正为已有event.task封装，不改变正式事件协议形状。

## 验证

- 294项相关测试通过：新计数核心12项、生产执行器131项、JobManager84项、IPC45项、session registry22项。涵盖增强后条数、有效任务失败不附计数、界限、多条件去重、原文不变、额外字段投影、事件/快照一致与旧任务兼容。
- TypeScript、Vite三段构建、preload外部模块检查通过。四语言完整性通过；source usage仅保留已知Q-SEG-CHECK-01的Rename/OptionsPanel动态键与过期manifest两项，新增字幕键无错误。未删检查或更改既有重命名代码。
- 实际新构建Electron、隔离userData，large-v3/CUDA/ja/VAD，固定opening与independent两份工作区副本。最终字段与导出文件独立计数一致：opening共13条/超建议值0；independent共27条/超建议值10。解释展开可见，0时无超建议值提示。两份SRT/LRC与05T逐字节相同，无新增ASR结果差异。
- 真实任务行桌面和390×844窄屏截图已查看，无新增文字横向溢出；窄屏说明区域clientWidth/scrollWidth同为146px。未把窄屏检查等同移动端产品支持。
- NAS三文件SHA256、大小、mtime保持；原素材/附件未修改。Electron PID69536及关联配置进程数0，隔离配置5379034916字节已删除。清理脚本明确UTF-8、终止错误及非空PID检查。

私有证据：`test-results/subtitle-quality-review/phase12/cue-summary-production/`中的`app-report.json`、`verification.json`、`cleanup-report.json`、`summary-desktop.png`、`summary-narrow.png`和实际字幕；`document-check.json`记录当前增量依赖/需求/文件指纹，沿用旧Markdown台账，不使用不兼容v2检查器。

06B完成，未提交。此项是输出可解释性，未提高模型识别精度，也不以0超限判定质量合格。综合全轨人工验收和翻译知识库仍未关闭；现有人工已确认的局部结果无需重复询问。
