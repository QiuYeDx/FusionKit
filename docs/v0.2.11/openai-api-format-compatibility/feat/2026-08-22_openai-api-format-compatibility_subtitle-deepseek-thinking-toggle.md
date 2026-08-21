# 字幕 DeepSeek Thinking 开关

## 背景

DeepSeek V4 的 Thinking 模式由服务端默认开启。字幕翻译此前未发送控制字段，因此
deepseek-v4-flash 实际使用 Thinking，用户无法选择且供应商默认变化会直接改变任务行为。

## 预期行为

- 字幕翻译配置在 DeepSeek Chat Completions 模型下显示 Thinking Switch。
- 默认关闭；开启后仅影响之后创建或重新保存的字幕任务。
- 关闭与开启分别发送 thinking.type = disabled 和 thinking.type = enabled。
- 任务、自动导入和 checkpoint 恢复保持创建时的模式。
- OpenAI、Other 与 Responses 请求不附带 DeepSeek 私有字段。

## 实现摘要

- 字幕安全配置 Store 增加默认关闭的 thinkingEnabled 白名单字段。
- 字幕任务 execution binding、自动导入 snapshot、checkpoint 和恢复 IPC 携带该值。
- Model runtime 的 Chat adapter 支持显式 DeepSeek Thinking 控制。
- 旧 DeepSeek 任务或 checkpoint 缺失字段时按关闭处理。
- 四种语言补齐配置与任务详情文案。

## 验证

- 17 个相关测试文件共 111 项测试通过，覆盖配置、runtime、任务绑定、自动导入、checkpoint 恢复与 Boolean 控件结构守卫。
- TypeScript、i18n 完整性和 diff whitespace 检查通过。
- 未启动前端服务。
