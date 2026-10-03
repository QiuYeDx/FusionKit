# HomeAgent 运行可靠性设计

## I2 已审查的修复设计
依据 ../../records/review-i2-plan.md 与 R-RUNTIME-02。名称 planner 使用同一个 AbortSignal 贯穿 executor、batch 和 SDK/fetch，取消分支必须在 fallback/retry 前退出。系统上下文从真实 store 读出当前 pendingExecution/pendingNameTranslationPlan 的有限摘要，仍由原确认门禁决定执行资格。导出返回 `{success, cancelled?, errorCode?: 'too_large'|'invalid'|'save_failed'}`；先验证待保存 JSON 字节数和 parseSessionJson，再调用保存 IPC。Responses 在完整 response 后收集原序 replayable output，下一请求附上结果；事件只发普通文字与工具事实，reasoning 临时数据不持久化，并计入原有请求预算。不添加新的模型参数。

## 现状与约束

orchestrator.ts 的全局 controller 与当前 store 写入没有 session/turn 归属；reset/import 后迟到流可写入新会话。工具调用在 finish-step 才保存，异常路径丢失工具回执。两种 adapter 一条直接透传 AI SDK 流，一条自行解析 SSE，缺少相同的终止语义。全部历史与完整工具结果每轮回传模型，规模无界。

本模块不修改 store、全局消息类型、工具注册和旧 executor。使用现有 session.id、AgentMessage 及工具 execute options；共享契约由集成负责人维护。遵循 FK-PIT-0163 的同步 claim、所有权隔离和已接纳回执保留；遵循 FK-PIT-0103，不叠加自动重试。

## 方案与取舍

### Turn 生命周期与串行工具

在第一次 await 前认领 {id, sessionId, controller}，同一 session 的重复发送不创建第二次请求。监听 session 身份变化并取消旧 turn；每次状态/文本/日志/用量写入先核对当前 turn 和 session。取消保留 controller 所属 turn，直到其清理完成；finally 仅释放自身，旧 finally 不能覆盖新 turn。

guarded-tools.ts 在每轮生成工具包装器：共用串行 Promise 链，工具开始前检查 signal 和 turn 归属，透传工具 ID 和 abortSignal，将同一 turn 内重复 call ID 的执行归并为同一 Promise。取消后排队调用直接返回/抛取消，不接纳新副作用。串行化避免 SDK 同步返回多个变更调用时并行污染 pending 状态；读工具也串行以保持可解释顺序。旧 executor 的 await 后副作用 fence 由集成负责人补齐，包装器不能承诺强行终止不支持取消的底层操作。

### 执行事实与模型上下文

每步骤维护 calls/results ledger，finish-step 原子提交；异常、取消及自然流结束均冲刷 ledger，已有结果保持原值，缺失结果补明确 interrupted/unknown 错误。工具异常归一成工具失败，不遗漏 result。副作用结果优先保留事实，不从聊天取消推断任务回滚。

conversation-context.ts 用纯函数构建请求历史：过滤不完整/孤立工具片段、对大结果生成显式截断摘要、按完整用户 turn 或工具 call/result 组从新到旧纳入预算。最新用户请求必须完整，无法容纳则报错。预算显式按序列化字符估算，记录裁剪范围；当前计划/未决约束通过系统提示词引用工具目录及规划状态，由集成后的 catalog/plan 合约提供，避免依赖旧闲聊保留它们。系统提示词继续区分普通对话与用户授权的工具任务，不强迫每次聊天规划。

### Adapter 终止与错误

运行时事件补明确 finish reason、tool-error 与 abort 映射；Chat Completions 不再盲目 cast SDK stream，规范化错误结果、步数上限与完成原因。Responses parser 仅在完整 completed 响应后发布可执行函数调用；EOF、failed、incomplete 和协议错误均结束本轮，不执行半成品函数。单个函数的 JSON/schema 错误成为其失败输出，使模型能修复；已经取消的 turn 不会把取消当普通错误继续下一步。

最大步数保持有限，并在最后一个工具步骤完成后发明确 limit reason；两条 adapter 对上限结果一致。无额外重试层。SSE reader 退出时释放/取消 reader，取消 signal 到达时不得继续解析后续可执行工具。

## 代码落点

- src/agent/orchestrator.ts、src/agent/orchestrator.test.ts：turn 生命周期、ledger、系统提示词集成。
- src/agent/guarded-tools.ts、src/agent/guarded-tools.test.ts：串行执行、调用去重、取消隔离。
- src/agent/conversation-context.ts、src/agent/conversation-context.test.ts：纯函数上下文压缩与配对边界。
- src/agent/runtime/：共享事件及两个 adapter 的规范化与回归测试。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-RUNTIME-02 | 完整取消链、当前pending有限投影、模式真实状态、导出同schema预检、Responses完整输出原序回传 |
| R-RUNTIME-01 | turn ownership、工具串行包装、ledger 完整提交、上下文预算、adapter 明确终止 |

## 验证与风险

使用可控延迟的 async generator、工具 Promise、fetch SSE fixture 验证跨会话迟到事件、取消前后副作用接纳及中断历史，不访问真实模型/文件。预算测试使用大量完整 call/result 组与长文本，断言上限及最新请求不被截断。adapter 测试覆盖正常完成、截断流、incomplete、坏参数、失败工具、取消与上限。

实际生产兼容性仍依赖 provider 流格式；仅使用已有 Responses/Chat Completions 标准事件，不新增实验性能力。单元测试证明运行时边界，不冒充真实供应商联调或 Electron UI 验收；页面相关交互由 workspace 模块集成验证。
