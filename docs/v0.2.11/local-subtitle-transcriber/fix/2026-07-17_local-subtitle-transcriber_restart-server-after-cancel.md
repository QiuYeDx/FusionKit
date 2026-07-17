# PRE-003 修正：取消后重启 official server

## 背景与现象

PRE-002 使用小模型验证过：HTTP inference 被 `AbortController` 断开后，官方
`whisper-server` 返回 `/health = ok`，同一进程还能继续处理下一个文件。

PRE-003 在 Windows CPU official server + `large-v3-q5_0` 上执行更激进的
250 ms 取消时，客户端快速得到稳定 `aborted`，紧接着 `/health` 也返回 ok；但
立即复用同一进程处理下一个长文件时，请求连接失败。相同模型的 CUDA 运行没有
复现该问题，但这不能证明所有 backend、模型和取消时机都安全。

## 根因判断

`/health` 证明 HTTP server 仍存活，不证明被取消的底层推理线程、backend 工作或
请求资源已经完全收敛。客户端 request Promise 结算也只证明连接已断开，不能作为
下一次 inference 可安全复用的屏障。

## 修正后的合同

1. 正常完成的同 model/backend 任务继续复用同一 server 进程和模型 context。
2. 当前 inference 被取消后，先等待客户端请求稳定结算，再终止该 server，并在下一
   个任务开始前重启和重新加载模型。
3. `/health` 仍用于启动 readiness 与普通存活检查，但不再作为“取消后可复用”的
   唯一证据。
4. kill fallback、generation 丢弃、临时文件清理与 owner cleanup 仍按 Final Design
   执行；重启不能删除已经原子提交的字幕产物。
5. PoC 的取消探针放在完整样本之后，避免用未定义的取消后复用行为污染性能结果；
   production supervisor 在后续 `BE-001` 实现真正的 restart boundary。

## 影响与验证

- 取消会付出一次模型重载成本，但换来确定的下一任务隔离；取消不是常态路径，首版
  优先保证正确性。
- PRE-003 CUDA 仍证明 AbortController 能快速结算，正常任务仍在同一 PID 内复用
  模型。
- 后续 supervisor 测试需覆盖：abort 结算、child restart、新 generation、旧响应
  丢弃、下一任务成功和无 orphan/temp。
