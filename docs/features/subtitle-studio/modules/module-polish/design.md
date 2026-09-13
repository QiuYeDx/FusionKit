# I8 设计

## 现状与约束

使用fusionkit-ui-design、fusionkit-pitfall-guard和spec-driven-ai-coding。3a3fcdf现状：App外层依据新pathname切换pt-10但AnimatePresence仍呈现旧页面；Studio CSS又根据子节点改变共用flex几何。来源保存在main私有绑定中，转写队列有owner私有记录。翻译服务已记录真实usage，overview尚未投影。

## 方案与取舍

沿用FusionKit中性tokens、ToolPanel、StudioIconButton、StudioDocumentList和ScrollableDialog。队列标题行28px图标按钮，元数据紧贴，行内8px、行间4px；操作hover使用更明显的foreground混色，停止/删除保留destructive语义。移除无操作的队列底栏。清理菜单用名称加短说明区分成功项与所有终态，不增加独立问号层。

翻译计划详情由border内8px等边容器承载滚动清单，渐变仍固定在viewport外。结果按钮消除尾部方向箭头的光学偏重，以明确文字主动作居中（箭头不提供必要信息），不缩小热区。页面留白下移到带pathname key的motion容器，App spacer和ScrollArea约束稳定，与路由无关。

看板标题下三列：进行中、已完成、需处理，数字优先、次级标签；取消非零时在摘要显示。下面独立细分隔为实际token用量，输入/输出数字及总计，不添加装饰图标堆叠。聚合所有当前可读任务（不限可见分页），每个字段已知总和与未知任务数独立记录；有未知时显示已知值和不完整标记，全未知显示未提供。不从估算值补用量。最近提交进度仅完整且active时显示一行，不重复终态计数或过时警告。窄侧栏保留紧凑入口，详情弹窗同样有用量总览。

## 代码落点

App.tsx与studio.css负责路由几何。StudioTranscription、StudioTranslationOverview及对应CSS、StudioTranslation.css、StudioOperationResult负责呈现。ipc-contract新增revealSource(kind,id)严格请求；main验证owner.documents或task owner，SourceLocationService/TaskService验证原生来源后调用shell；无通用renderer路径接口。translation-overview在分页前聚合usage，契约同步，四种locale同步。所有文件由Codex root串行修改。

## 验证与风险

先静态/单元验证来源权限与身份失效、聚合分页及未知字段，构建真实Electron后覆盖队列hover/清理语义、文档来源、展开详情四边、看板及结果按钮。1280浅色和786深色长名；采样进/退场连续帧几何，不能只截settled状态。截图亲自审阅后修复复验。文件夹shell仅在隔离测试录下可信路径，不打开用户文件夹；运行资源与进程由测试finally关闭。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-POLISH-01 | 八项AC、队列密度/来源入口/看板/稳定路由和受影响清单 |

## 实测后的修复与证据边界

来源转写记录仅在main保留admission原生inputPath及inputIdentity，完成释放lease后仍可只读reveal；每次重新核验文件身份、owner和记录存活。document沿用私有source绑定和锁。renderer只有kind/id，无路径回传。

实测发现短清单的scrollbar-gutter:stable在右侧多留6px，shared StudioBatchItems范围改auto；两份计划灰色行四边实测8px，需要滚动时仍保留真实滚动条。停止hover原16%混色在浅色红绿差25，增强为24%后复验通过。结果主按钮去掉重复方向箭头，文字光学居中；不更改结果header的提交图标。

增加路由逐帧测试后，41文件导入需要等待真实批次完成，旧5秒测试超时改为30秒有界等待，不减少文件量或降低功能标准。11工具矩阵中的Studio标题仍是I6已批准的8/12/8/12，旧测试统一12的断言同步该精确例外；其他工具标准不变。用量测试原HTTP fixture未返回usage，统计正确为未知；补明确100/40/140回执后两任务精确聚合200/80/280，另一个取消任务保持未知。
