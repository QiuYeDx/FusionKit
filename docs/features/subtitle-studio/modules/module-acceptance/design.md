# I3 设计

## 现状与约束

基线为feat/subtitle-studio-transcription上的15340fd，开工时工作树干净。新增六项问题由用户明确要求完整实施；具体格式与交互细节为此授权内的可逆实现选择。保留已完成I1/I2契约和冻结ASR副本，不将此次扩展为打包、编辑器或新识别算法。

## 方案与取舍

保留现有领域边界，通过受控File导入、全库任务摘要、文本节点保留与主进程私有来源记录贯通六项；具体取舍分段如下。

## 前端设计基准

沿用工作台现有ToolPageShell、ToolFilePickerSurface、紧凑标题行、Button、Input、Select和ScrollableDialog。参考当前StudioTranscription队列、StudioExport对话框和资源摘要密度，不另造大卡片。根页面单写者接入拖入高亮和翻译摘要；工作区标题下以一条紧凑摘要显示全局任务数、真实本轮进度及详情入口。详情列表含文档名、任务状态/批次进度、等待/失败说明和打开入口，不用文档库分页充当任务数据源。

队列标题的“清理已完成”与更多菜单提供终态清理、批量取消；取消需数量确认，清理不删除文档。导出对话框增加保存位置和文件名后缀两组字段，无后缀为默认；自定义输入及无来源/不可用来源紧邻字段显示。长名称省略配完整提示，任务列表使用既有滚动/渐变组件，不嵌套整页滚动。文档工作区以动态标题高度和剩余视口分配阅读区；普通嵌套Grid允许最小0，明确展开诊断时保留120px阅读区并使用既有面板滚动。统一标题下留白8px，小高度标题上边距20px，保持与原生标题栏至少12px间距。验证1280×860浅色、786×540深色，包含空态、忙碌、部分失败、长文件名、键盘和原生文件拖入，真实渲染后审图修复。

## 拖入及权限

新增固定preload方法接收真实File数组，经webUtils提取原生路径并仅调用内部固定IPC；公共invoke及旧generic bridge拒绝内部通道。主进程沿用owner/frame/URL与能力校验。路径先经独立转写域的Windows Shell原始文件解析器处理，不能引入旧工具私有resolver。按钮和拖入共享逐文件读取/保存逻辑，保留每文件错误。异步结果复核owner，UI沿用操作互斥与版本读屏障。

## 队列及翻译总览

清理复用已有owner-bound remove/cancel方法；一次目标快照、单飞批量控制、逐项结果，主进程依然最终校验terminal与cleanupPending。无需增加可绕过单任务保护的批量删除接口。

新增固定listTranslationTasks公共接口：主进程从repository全部记录汇总计数，再分页返回轻量任务DTO。可选taskIds限定本轮集合；不返回正文/checkpoint/key。默认总览显示全局活动与需处理计数，本輪百分比只计算真实提交得到的任务ID集合，SPA内保留，重启无集合时只报全局数量和每项进度。事件驱动失效和有任务时短轮询单飞，读取期间再变更必须追读；由root接入既有跨分页打开文档逻辑。

## 格式支持

实际公共字段以domain.ts和export-contract.ts为唯一契约。origin/timing新增vtt/ass，有限正文范围与控制信息必须由验证器校验，旧schema数据保持可读。import/bilingual不能将未知格式落入LRC分支。

VTT按W3C结构读取header、cue IDs/settings及多行正文；NOTE/STYLE/REGION/未知结构原节点保留。ASS v4+按Events Format映射列、保留Text中逗号，支持普通Dialogue与转义；Comment、样式、附件/未知section保留，绘图不发模型。原始导出继续rawText+encoding+BOM；同格式导出对可安全修改的正文做范围补丁，并按导出选择统一LF/CRLF；原始导出保持输入字节，preservation.newline兼容LF/CRLF/CR。复杂内联/karaoke/drawing不宣称可自动重对齐，明确限制。跨格式规范生成新文档并列出实际元数据、样式、绘图、精度损失，确认后才发布。主参考：[W3C WebVTT](https://www.w3.org/TR/webvtt/)、[Aegisub ASS tags](https://aegisub.org/docs/latest/ass_tags/)、[libass format guide](https://github.com/libass/libass/wiki/ASS-File-Format-Guide)。

## 来源持久化及命名

DocumentRepository私有source-location记录绑定文档ID及origin fingerprint，导入/转写发布时保存实际输入和父目录身份；不进入公共文档schema。转写在task lease仍有效、即将持久化成功文档时惰性捕获源位置并传给sink，不能从文件名还原。每次来源目录导出重新核验，批量逐文档各自解析；输入不再存在时可另选目录并明确重新绑定。旧文档缺证据不猜来源；新增固定getSourceLocation/selectSourceDirectory，main原生picker返回安全状态。

destination缺省choose-location兼容旧请求，source-directory在提交和实际写入前重新验证。来源目录只用indexed no-clobber，不复用原生SaveDialog明确同意的replace能力。仍记录Node路径操作无法宣称彻底消除所有检查与syscall间替换的既有边界；不得以此删除必要身份检查。后缀schema缺省none，可选content-mode、target-language或受限custom；纯filename helper供格式planner调用，计划与发布重建一致。partial保持结构化提示，默认文件名不强加partial。

## 代码落点

root负责本模块文档/spec/BRD、主入口index.ts、ipc-contract、preload桥及policy、根页面index.tsx、翻译总览主服务及最终边界/来源审计。admission_design负责domain及formats/import/bilingual、electron/main/subtitle-studio/export-planner.ts与格式测试。ipc_design负责export-contract/batch-contract、filename helper、export/batch/source-location服务、repository/input-service、转写task-service/document-sink及导出UI/测试。windows_baseline负责队列/controller和新增翻译总览/controller、翻译提交反馈及全部四locale/其测试。runtime.ts等共享组合只由root修改。root另负责drop-input-service、库格式筛选、根布局CSS、IPC/文件与布局综合验收；相关既有断言随真实契约调整。跨写集需求先消息协调，不覆盖他人改动。最终独立复查发现Windows默认保存路径大小写问题，root临时委托ipc_design仅修正主入口两处比较及对应IPC测试后统一审计。

## 验证与风险

针对性单元和真实文件系统集成覆盖格式round-trip、保留/损失、来源重开和置换、批量并发/失败、File桥隔离与任务进度；现有Studio/转写/来源基线按受影响面回归。使用直接Node20入口，Vitest最多2 workers；两套TS、i18n、实际边界与provenance、spec/diff验证。真实Electron构建和隔离userData走六项UI/main/repository流程，测试翻译明确为受控响应，不冒充供应商质量；不重复无关真实GPU矩阵，不打包发布。记录最终代码/命令/截图和局限，用户整体验收保持pending。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-ACCEPTANCE-01 | 拖入及权限：原生File桥、同一批量导入、操作互斥 |
| R-ACCEPTANCE-02 | 队列及翻译总览：任务快照、终态清理和取消确认 |
| R-ACCEPTANCE-03 | 队列及翻译总览：全库摘要、本轮集合和单飞刷新 |
| R-ACCEPTANCE-04 | 格式支持：连续原节点、受支持正文补丁和跨格式损失 |
| R-ACCEPTANCE-05 | 来源持久化及命名：私有来源记录、身份复核和逐目录发布 |
| R-ACCEPTANCE-06 | 来源持久化及命名：缺省none、预设/自定义片段和计划一致 |
