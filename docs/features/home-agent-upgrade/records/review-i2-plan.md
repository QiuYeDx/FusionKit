# I2 复审发现与实施前设计

日期 2026-10-03；基线 161b109；初始工作树仅有原 artifacts/。用户明确授权自行 review 并完善，本文件先于 I2 源码变更。沿用项目 UI、pitfall 与 spec-driven-ai-coding 工作流；此次不扩大实验工具范围。

## 有证据的发现

| 问题 | 证据与影响 | 本轮处理 |
| --- | --- | --- |
| 名称规划停止不终止模型工作 | executor 未传 planner signal，planner 生成请求也未接 signal；后续批次可能继续请求 | signal 贯穿批次、SDK/fetch 和取消异常，禁止取消后 fallback/retry |
| Responses 工具循环丢 reasoning 项 | 本地 SSE 含 reasoning 密文和 function_call，下一步只有 call/output；正式推理模型允许被选择 | 完整响应后按原序回传本 turn 的可重放输出，保留 store:false，不向 UI/日志/会话保存 reasoning |
| 模式指引误导 | system prompt 的 Queue Only 固定要求去工具页启动，但现代工具仅创建首页 ready 动作 | 按真实返回状态区分经典队列与工作台准备 |
| 长对话丢失未决计划身份 | 历史预算裁剪掉 preview 后，系统上下文没有 pending rename ID；实际动作仍有效 | 当前经典确认/重命名状态做有界只读投影，不授予额外权限 |
| 导出不能重导入 | 300 条约 30k 消息可导出 9MB，但导入上限 8MiB | 保存前按同一 schema/大小预检，超限明确失败且不截断或写坏归档 |
| 批量部分失败不可见 | translation plan 丢失败项；确认仅需一个 taskId 就报 queued；卡片不显示 result.items | 准备及提交均保留结构化逐项回执，包括全失败；用户可见数量/文件/原因 |
| 转写范围静默缩水 | 确认 signature 不含 draft.status，enqueue 过期清理后只提交仍 ready 子集 | 确认后在真实 admission 前校验 expectedDraftIds 全集，全不一致则零提交 |
| 资料搜索翻页遗漏 | offset 只作用 entries，collections/recipes 固定第一页 | 三类结果正确分页并给各自数量和后续偏移 |
| 首页恢复入口缺失 | 导入按钮仅 !isEmpty 渲染，无模型空态无法恢复 | 空态提供导入，取消/失败保留现有会话 |
| 历史与当前状态冲突 | 已提交截图仍有旧“待确认”和计划“等待确认” | 历史回执描述已发生事实；上次计划与当前动作区分；进度检查只填草稿 |
| 任务结果及重复使用可读性 | local 返回 tasks 未显示，实际转写阶段未映射；最多50终态卡全量铺开 | 有限阶段/进度/失败投影；活动操作优先，终态可折叠查看 |
| 页面交接与键盘/日志 | Studio入口仅通用route；模式focus ring被去掉；日志无条件滚底 | 有限工作区view hint、可访问名称/焦点、仅底部跟随日志 |

## UI 实施前基准

Responses 协议依据：[function calling](https://developers.openai.com/api/docs/guides/function-calling) 要求工具调用伴随的 reasoning 项跟随工具输出回传；[reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) 的当前 stateless 约定默认提供 encrypted_content，无须额外 include。仅修复现有单 turn 工具循环；密文也计入上下文预算。不声称进行了真实供应商付费验证。

保留现有单列对话、max-w-2xl、InputCapsule、Button sm/ghost、Accordion 和 ScrollableDialog；参照当前计划/操作卡与工作台任务行，不重新装饰首页。活动操作置前；历史分组标题提供数量/失败提示，展开后保留原范围与错误。部分失败用紧凑数量摘要和自然换行清单，无全局大弹窗。上次计划显示更新时间，“检查执行进度”填入并聚焦输入，保留已有草稿，不自动调用模型。空态导入与能力入口同排。

工作台导航只携带 documents/transcription 的受限 view hint，不虚构 documentId/taskId 深链或更改执行权限。任务阶段使用有限四语言映射，查询成功与任务失败分开表达。日志保持用户阅读位置，回到最新才恢复跟随。

验收样本：1280×860 中文浅色、786×660 英文深色，另检查日文/繁中；无模型空态取消/非法/合法会话导入；混合批量失败；加载模型/转写/取消/失败；20条终态加2条待办；提交后旧历史/计划语义；键盘模式和日志阅读；真实隔离导入及合成模型请求。测试 fixture 与真实供应商能力明确分开。

## 协作及收尾

实施中交叉复查明确了未知提交边界：传输异常/底层 submission_unknown 不等于全部未提交；保留准备回执和未知诊断，不显示虚构的零成功统计、不自动重试。普通明确部分/全失败仍完整投影。

runtime：运行提示与状态投影、planner取消、executor透传、会话导出；tools：现代工具/动作回执、资料分页、转写controller准确范围；UI：HomeAgent、locale、工作台view hint；root：文档、QA脚本、最终集成验证。先通过 I2 ready，再开始源码。新记录独立归档，保留 I1 证据，不把旧截图记作新代码验收。
