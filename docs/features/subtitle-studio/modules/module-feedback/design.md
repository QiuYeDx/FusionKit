# I7 完成反馈设计

## 现状与约束

8589872。采用fusionkit-ui-design、fusionkit-pitfall-guard与apple-design：明确层级、克制反馈、行动就近，保留FusionKit语义颜色与字体。用户所附旧弹窗是待修反例，而非视觉基线。不使用营销Hero、庆祝动画或扩大空白制造高级感。

## 方案与取舍

结果外壳最大420px，与600px设置/检查阶段明确区分。在同一Radix生命周期中切换完整结果内容，不重启controller或任务。结果顶部为40px状态标记、20px动作标题和13px摘要，24px等边留白。内容以单文件收据或一处紧凑文件明细入口承载，默认不展开；成功、警示、失败采用克制语义色及不同图标。末端36px主要按钮；翻译已提交时主要操作为查看进度，完成作为次要动作。去掉表单header/footer横线和重复计数。

结果组件直接提供ScrollableDialogHeader/Content/Footer，仍用既有滚动与渐变。明细为单层文件列表，每项有状态及可读原因；长名称复用StudioFileName，输出名称单独保留避免输入/输出重复。最多100项时按需渲染，滚动不挤走标题和操作。短成功没有无意义的“查看成功详情”。所有异常默认同样只给总览，用户主动打开原因。

## 代码落点

StudioOperationResult提供operation、items、onClose、testId、closeButtonId、primaryAction、titleRef。operation为export/source/import/translation/delete/resume/cancel；item保留name/state/detail/actions，可选outputName。组件派生结果标题、数量及请求语义，不读取业务状态或执行IPC。root负责组件/CSS、locale、文档；admission_design负责StudioExport；ipc_design负责index与StudioTranslation；windows_baseline负责结果与受影响Electron测试。实际UI测试由root调度串行，运行期间禁止构建。

## 验证与风险

覆盖单文件/批量/混合/全失败/跳过/空结果及请求状态，长名和长错误，键盘展开/关闭/焦点，翻译进度入口；实际1280×860浅色与786×540深色，四语文案静态检查及英文窄窗样本。复验受影响导出/导入/管理/翻译业务路径和冻结保护，截图人工审阅后修复。只对拥有的隔离profile/服务操作，不访问真实用户数据。没有输出目录原生能力，故不虚构“打开文件夹”按钮。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-FEEDBACK-01 | 统一420px结果组件、动作语义、三个消费者及隔离验证 |

## 初版审阅后的修复

实际Electron run-1A5vuG：单份成功的结果层级/24px边距清楚；展开长名时Radix内部display:table撑宽，截图09暴露右留白丢失。最终局部将测量wrapper约束为block/full-width/min-width0，并补内部viewport溢出断言。正常按钮按36px调整为7px上下padding，保留多行自增长。

代码复核发现退场动画复用200ms：export关闭清空结果会闪回600px表单，library清结果会变空壳。关闭仅撤销open/操作权，结果收据保留到退场结束；下一次打开时重置配置/结果。快照不能重新打开对话框或执行旧任务。验证通过MutationObserver检查closed阶段仍有相同结果标题且不重现settings。

新测试直接引用工作台自身中英文studio.json。依赖边界仅审核这两个确切文件，不放宽locale目录或旧字幕模块。四套历史导出UI断言同步新结果语义与明细结构，保留原字节/冻结计划/取消/实时更新断言。
