# 工作包 FIX-SILENT-001：长文本翻译静默失败全链路修复

## 基本信息

- 日期：2026-06-29
- 状态：已完成
- 触发原因：长文本翻译工具执行中断/失败时经常无任何报错提示，用户无法得知失败原因

## 问题分析

对 UI → IPC 服务 → 后端翻译服务 → HTTP 客户端 完整链路进行排查，发现 6 个导致"静默失败"的问题：

### 致命问题

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 1 | `partially_completed` 状态完全静默 | 后端 `startTask`/`runResumeTranslation` 对 `partially_completed` 返回 `ok: true`，且不发出 `task-failed` 事件 | 部分段落翻译失败时，前端完全无感知，用户以为成功但输出残缺 |
| 2 | `taskFailed` 事件处理器不弹 toast | 事件处理器只调用 `setLastError`（写入 Alert），不调用 `showToast` | 异步任务失败时，用户不盯着界面就不知道出错了 |

### 重要问题

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 3 | `handleStart` 不检查返回任务状态 | IPC 返回 `ok: true` 但 `task.status` 可能是 `partially_completed`/`failed`，前端不做检查 | 安全网缺失，依赖事件通知的单一路径 |
| 4 | HTTP 请求超时 60s 太短 | `sendOpenAICompatibleChatCompletion` 默认 `timeoutMs: 60_000`，长段落翻译 LLM 响应时间常超 60s | 频繁触发超时错误导致段落翻译失败 |

### 中等问题

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 5 | `length_truncated` 错误标记为可重试 | `retryable: true`，但相同请求重试必然再次截断 | 浪费 2 次重试 + 退避等待时间后仍失败 |
| 6 | `warning` 事件从未被前端订阅 | 后端发出语义记忆等运行期警告事件，但前端 `subscribeTextTranslationEvents` 未注册 `warning` 处理器 | 运行期诊断信息完全丢弃 |

## 修复内容

### 1. 后端：`partially_completed` 发出 `task-failed` 事件（致命修复）

**文件**：`electron/main/text-translation/text-translation-service.ts`

- `startTask` 和 `runResumeTranslation` 中，当翻译结果为 `partially_completed` 时，同样调用 `emitTaskFailed` 发出事件
- 错误消息包含段落级失败详情：`"3 of 10 segments failed during translation. First failure: [具体错误]"`
- 重构 `formatAllSegmentsFailedMessage` → `formatSegmentFailureMessage`，统一 `failed` 和 `partially_completed` 的消息格式

### 2. 前端：`taskFailed` 事件处理器增加 toast（致命修复）

**文件**：`src/pages/Tools/Text/TextTranslator/index.tsx`

- 在 `taskFailed` 事件回调末尾增加 `showToast(event.error.message, "error")` 调用
- 确保无论是同步 IPC 返回的错误还是异步事件推送的错误，用户都能立即收到 toast 通知

### 3. 前端：`handleStart` 增加状态安全网检查

**文件**：`src/pages/Tools/Text/TextTranslator/index.tsx`

- IPC 返回 `ok: true` 后，额外检查 `started.data.status` 是否为 `partially_completed` 或 `failed`
- 如果是，主动获取最新任务详情并更新 UI 状态

### 4. 后端：翻译请求超时提升至 180s

**文件**：`electron/main/text-translation/text-translation-service.ts`

- 新增常量 `TEXT_TRANSLATION_REQUEST_TIMEOUT_MS = 180_000`
- 所有 4 处 `sendOpenAICompatibleChatCompletion` 调用均传入 `timeoutMs: TEXT_TRANSLATION_REQUEST_TIMEOUT_MS`
  - 并行模式 txt 翻译
  - 并行模式 Markdown 翻译
  - 顺序模式 txt 翻译
  - 顺序模式 Markdown 翻译

### 5. HTTP 客户端：`length_truncated` 改为不可重试

**文件**：`electron/main/ai/openai-compatible-client.ts`

- `length_truncated` 错误的 `retryable` 从 `true` 改为 `false`
- 改进错误消息，提示用户降低分片 token 限制或使用更大上下文窗口的模型

### 6. 前端：订阅 `warning` 事件 + `showToast` 扩展 `warning` 类型

**文件**：`src/pages/Tools/Text/TextTranslator/index.tsx`、`src/utils/toast.ts`

- 在 `subscribeTextTranslationEvents` 中增加 `warning` 处理器，通过 `showToast(..., "warning")` 展示
- `showToast` 函数类型签名扩展支持 `"warning"` 类型，映射到 sonner 的 `toast.warning`

## 修改文件

- `electron/main/text-translation/text-translation-service.ts`
- `electron/main/ai/openai-compatible-client.ts`
- `src/pages/Tools/Text/TextTranslator/index.tsx`
- `src/utils/toast.ts`

## 接口或数据结构变化

- 无新增类型或接口
- `showToast` 函数 `type` 参数扩展：`"default" | "success" | "error" | "loading"` → `"default" | "success" | "error" | "warning" | "loading"`

## 验证结果

- Lint 检查：4 个修改文件均无 lint 错误
- 未执行运行时测试（需用户手动 `pnpm build` 验证）

## 下一步建议

- 执行 `pnpm build` 确认编译通过
- 执行 `pnpm exec vitest run test/text-translation` 确认回归测试通过
- 手动测试：使用一个较大的 txt/md 文件，配合故意设置较小的分片 token 限制或使用无效 API key，验证失败时 toast 正确弹出且 Alert 显示详细错误信息
