# FIX-R04：MiMo 实时字幕余额错误诊断与提示

## 问题

MiMo Profile 启动实时字幕后，终端出现：

```text
SetApplicationIsDaemon: ... Code=-50 "paramErr"
```

页面随后只显示“实时字幕失败 / 音频服务拒绝了请求”，无法判断是麦克风、音频编码、
IPC、请求格式还是供应商账户状态导致失败。

## 排查结论

MiMo 实时字幕走的是分块近实时路径：renderer 先获取麦克风并编码 5 秒 WAV，随后由
main 进程调用 MiMo `POST /v1/chat/completions` ASR，并非 OpenAI Realtime/WebRTC。

使用当前音频 Profile 的 endpoint、Key 和同格式 WAV 做一次脱敏探测，真实响应为：

```text
HTTP 402
type: insufficient_balance
message: Insufficient account balance
```

探测只输出状态码和脱敏错误字段，没有输出 API Key、音频 Base64 或完整请求体。MiMo
官方错误码文档也将 402 定义为账户余额不足。因此，本次调用失败的直接原因是当前
按量付费音频 API 账户余额不足；`SetApplicationIsDaemon -50` 是麦克风初始化期间的
macOS/Chromium 日志，与供应商返回的 402 没有因果关系。

## 代码缺陷

`createAudioHttpErrorFromResponse()` 只单独分类 401、403、429、408 和 5xx，402 会落入
`http_non_retryable`。renderer 再把该错误统一翻译成“音频服务拒绝了请求”，丢失了可
操作的充值提示，也容易让排查方向错误地转向音频设备。

## 修复

- 新增稳定错误码 `http_payment_required`，将 HTTP 402 与普通不可重试的 4xx 分开。
- 保留脱敏的 `status` 与 `attempt` 错误详情，不记录 Key、Base64 或请求体。
- 四语言新增余额/套餐额度不足提示，并由共享 `getAudioErrorMessage()` 统一映射；实时
  字幕、音频转文本、TTS 和双向语音共享同一错误语义。
- 增加 MiMo ASR 402 adapter 回归测试和 renderer 错误映射测试，固定“不重试且提示
  余额/额度”的行为。

## 用户侧恢复条件

代码修复会把真实原因明确显示出来，但不能代替供应商账户充值。要让本次 MiMo 实时
字幕请求成功，需要为音频 Profile 当前使用的按量付费账户充值，或改用与有效 Key
匹配且支持 MiMo ASR 的计费入口。MiMo 官方明确说明 Token Plan 与按量付费 Key/Base
URL 不能混用。

## 参考

- [MiMo-V2.5-ASR 使用文档](https://mimo.mi.com/static/docs/quick-start/usage-guide/audio/Speech-Recognition.md)
- [MiMo 错误码](https://mimo.mi.com/static/docs/api/guidance/error-codes.md)

## 验证

```text
node_modules/.bin/vitest run test/audio/audioRuntimeClient.test.ts src/pages/Tools/Audio/shared/audioErrorMessage.test.ts
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/lib/audio-provider-registry.test.ts src/pages/Tools/Audio/shared/audioErrorMessage.test.ts
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 聚焦 MiMo adapter 与错误文案：2 files / 24 tests 通过。
- 完整音频相关回归：16 files / 187 tests 通过。
- TypeScript 通过。
- 四语言 i18n 完整性通过，`audio` namespace 各 353 keys；源码引用门禁通过。
- renderer、Electron main、preload 的 Vite test build 通过；仅保留既有 chunk size 和
  dynamic/static import 警告。
- `git diff --check` 通过。

全程未执行 `pnpm`，`pnpm-lock.yaml` 未修改；真实供应商探测使用的临时音频已删除。
