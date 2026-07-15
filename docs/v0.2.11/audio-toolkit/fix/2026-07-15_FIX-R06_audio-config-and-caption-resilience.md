# FIX-R06：音频配置状态、分段控件与字幕静音容错

> 日期：2026-07-15
> 状态：已完成
> 对应工作包：`FIX-R06`
> 后续变更：本工作包中的音频私有分段控件实现已由 `FIX-R07` 删除并替换为字幕文件翻译与音频工具共同使用的 `ToolRadioButtonGroup`；verification 与字幕静音容错结论保持有效。

## 背景与现象

验收发现三项相关体验问题：

1. 音频 API 列表和工具配置摘要显示“未验证”，但产品没有测试连接或 route 验证入口，
   用户无法理解或改变该状态。
2. 四个音频工具配置面板中的互斥按钮组来自不同实现；TTS 使用普通 Button 模拟 radio，
   模式组还带 `gap-1`，与字幕/设置页的连体分段控件不一致。
3. MiMo 分块近实时字幕在一段时间没有说话时，ASR 返回空文本；通用转写链路把它映射为
   `empty_response`，页面将其当成致命错误并停止录音。

## 根因与设计缺口

- `verification` 是旧配置迁移遗留字段。当前 Store 只有手工写入方法，没有任何产品流程调用；
  UI 却把缺失值默认解释为“未验证”，main 还会用旧 `failed` 值阻断真实请求。
- 各工具分别复制了 RadioGroup 样式，TTS 则使用 `ButtonGroup + Button` 自行维护 radio 语义，
  导致间距、边框、键盘焦点和响应式表现漂移。
- 普通文件转写的空结果确实应报错，但固定时长的实时分块天然可能全是静音。两种上下文共用
  同一个空响应策略，缺少可信 main 路径传入的“允许空片段”语义。

## 修复后行为

- 不再展示没有验证动作支撑的“未验证/已验证”状态；旧 verification 数据仅保留迁移兼容，
  不再作为请求门禁。用户发起实际任务后，供应商返回的鉴权、余额、模型和参数错误继续明确提示。
- 本工作包先统一了音频工具的互斥按钮行为；其音频私有视觉实现随后由 `FIX-R07` 替换为
  字幕文件翻译与音频工具共同使用的 `ToolRadioButtonGroup`。
- recorded-chunk 转写允许供应商成功返回空文本；页面把它视为静音片段并继续录音和处理队列。
  普通文件转写仍拒绝空响应，非空的鉴权、余额、限流、网络和格式错误仍停止字幕会话。

## 影响文件与接口

- 音频设置与共享摘要：`src/pages/Setting/components/AudioApiConfig.tsx`、
  `src/pages/Tools/Audio/shared/AudioToolShell.tsx`、相关 model/tests。
- 分段控件（本工作包历史实现）：`src/pages/Tools/Audio/shared/AudioSegmentedControl.tsx`；该文件
  已在 `FIX-R07` 删除，当前实现位于 `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.tsx`。
- 字幕链路：`src/pages/Tools/Audio/RealtimeCaptions/index.tsx`、
  `electron/main/audio/audio-runtime-client.ts`、`electron/main/audio/ipc.ts`、
  `electron/main/audio/adapters/mimo-chat-audio-adapter.ts`。
- 不扩大 public renderer IPC；允许空结果只存在于 main 构造的 runtime request options 中。

## 实现摘要

- 删除设置页 verification badge、工具摘要 verification 行、对应聚合 helper 与四语言死文案；
  main route resolver 不再读取旧 `verification.failed` 作为请求门禁。
- 本工作包曾新增 `AudioSegmentedControl` 统一音频工具行为；该音频私有组件及其视觉规则已由
  `FIX-R07` 废止，相关页面现与字幕文件翻译直接复用 `ToolRadioButtonGroup`。
- 共享控件统一等宽 grid、`gap: 0`、边框拼接、首尾圆角、换行策略、roving tabindex 与
  Home/End；pointer 切换可聚焦模式主字段，键盘切换不会被合成 click 抢走焦点。
- recorded-chunk 调用由 main 设置 `allowEmptyTranscriptionResult: true`；MiMo adapter 只在
  此可信上下文允许空文本，renderer 跳过空行并继续队列。普通文件转写仍返回
  `empty_response`，402、鉴权、网络、参数和格式错误均未被吞掉。
- 新增 runtime/IPC/route/Electron 断言，并在 pitfall guard 中新增 `FK-PIT-0017/0018`。

## 验证命令与结果

执行命令：

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run src/pages/Setting/components/audioApiConfigModel.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts test/audio/audioRuntimeConfig.test.ts test/audio/audioRuntimeClient.test.ts test/audio/audioIpcService.test.ts --reporter=dot
node_modules/.bin/vitest run test/audio src/type/audioIpc.test.ts src/services/audio/audioServices.test.ts src/store/tools/audio src/pages/Setting/components/audioApiConfigModel.test.ts src/lib/audio-provider-registry.test.ts src/lib/audio-api-migration.test.ts src/store/useAudioApiStore.test.ts src/store/audioStoreBootstrap.test.ts --reporter=dot
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'standalone audio settings|route-aware speech synthesis|route-aware audio transcription|route-aware realtime captions|route-aware realtime voice' --reporter=dot
git diff --check
```

结果：

- TypeScript 通过；focused `6 files / 108 tests`、音频回归 `31 files / 342 tests` 通过。
- 四语言均为 1482 keys，其中 `audio` 354、`setting` 209；usage 1343 calls / 1376 keys 通过。
- renderer/main/preload test build 通过，仅保留既有 dynamic import 与 chunk size warning。
- Electron 最终 `5 passed / 2 skipped`：设置、TTS、ASR、字幕、Realtime Voice 全通过；
  断言 verification 文案不可见、历史 failed 不阻断生成、五组分段控件无 gap 且键盘可用。
- 人工审查 1280×800、786×540 最新截图，无文字溢出、重叠或分段控件视觉漂移。
- `git diff --check` 通过；测试结束后 FusionKit Vite/Electron 进程表为空。

## 后续建议

- 若未来确需“测试连接”，应单独设计按 route 执行、可取消、结果可追溯的验证 IPC；在此之前
  不恢复验证 badge 或失败门禁。
- 真实 MiMo 设备验收应覆盖“静音多个 chunk 后继续说话”，且不得记录 Key、Base64 音频或完整响应。
