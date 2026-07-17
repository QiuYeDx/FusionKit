# PRE-003 修正：长推理不使用默认 fetch 超时

## 背景与现象

Windows CPU official server + `large-v3-q5_0` 能在约 117 秒完成短日文视频，
但长日文音频连续两次都在请求运行约五分钟后由 Node 客户端报
`request_failed`。当时模型工作集约 2.5 GB，未出现 GPU 占用或明确 OOM 证据，
失败时间却高度稳定。

官方 `whisper-server` 在整次转写完成前不会发送 inference response headers。
Node 全局 `fetch` 的 Undici 默认 response-header timeout 因而先于长 CPU 推理完成
而触发；短 CPU 样本和快速 CUDA 样本都不会暴露这一边界。

## 修正后的实现

- PoC inference 改用 `node:http` 的流式 multipart request，不再依赖全局 `fetch`
  的隐式 response-header timeout。
- 媒体继续从文件流发送，不把完整音视频读进内存。
- 推理使用独立的 12 小时显式上限；health/readiness 仍保持秒级超时。
- response body 上限固定 64 MiB；HTTP status 与 `verbose_json` schema 继续校验。
- multipart filename 去除 CR/LF/引号，防止 header 注入；boundary 使用随机值。
- AbortSignal 继续中止当前 request；取消后的下一任务按另一份修正文档要求重启
  server。

## 验证

- Node 测试覆盖 multipart 字段、二进制文件流、filename 清洗和结构化响应。
- PRE-003 使用同一长日文音频再次跑过五分钟边界；最终实测结果记录在
  `2026-07-17_PRE-003_windows-cpu-cuda.md` 和脱敏 PoC report 中。
- 该修正不引入新 npm 依赖，也不需要 CMake、MSVC、C++ runner 或完整文件 Buffer。
