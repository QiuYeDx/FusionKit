# FIX-R05：文本转音频参数错误提示与 MiMo 音色约束

## 问题

文本转音频的偏好默认保存 `alloy`。当用户从 OpenAI 切换到 MiMo
`mimo-v2.5-tts` 后，页面仍把音色建模为自由文本并原样提交。MiMo 官方只接受固定的
预置音色，此时供应商会返回 4xx，但页面主要提示“请求被拒绝”或“请检查任务参数”，
无法看出错误字段是音色。

## 根因

- MiMo 音色列表只存在于页面快捷按钮，没有进入共享 speech route constraints。
- renderer 只校验 voice 非空，main 也只校验 route 是否支持 voice 字段，没有校验值。
- 跨 provider 持久化的 `alloy` 因此能进入 MiMo adapter。
- 共享错误文案忽略已有的 `AudioIpcError.field`；供应商 400 中安全的 `param/field` 也
  没有被映射到内部字段。

## 修复

- 按 MiMo 当前官方文档在 registry 定义 9 个预置音色：`mimo_default`、冰糖、茉莉、
  苏打、白桦、Mia、Chloe、Milo、Dean，并随 route constraints 克隆和传递。
- MiMo preset voice 改为下拉选择。遗留或跨 provider 的非法值不静默替换，而是在音色
  控件旁显示具名错误、禁用生成按钮，要求用户主动选择。
- renderer preflight、Electron main 与 MiMo adapter 复用同一 allowlist；绕过 UI 的
  `alloy` 也会返回 `invalid_task_parameters`，字段为 `intent.voice`/`voice`。
- 共享错误文案将受信字段映射为本地化参数名，例如“参数‘音色’无效或不受当前模型
  支持”。
- 对供应商 HTTP 400/422，只从结构化 `param/field` 或少数明确 error code 中映射白名单
  字段；不记录或展示完整响应体，也不从自由文本猜字段。

## 参考

- [MiMo-V2.5-TTS 官方文档](https://mimo.mi.com/static/docs/quick-start/usage-guide/audio/speech-synthesis-v2.5.md)

## 验证

```text
node_modules/.bin/vitest run src/lib/audio-provider-registry.test.ts src/store/tools/audio/audioToolConfig.test.ts src/store/tools/audio/speechSynthesizerConfig.test.ts test/audio/audioIpcService.test.ts test/audio/audioRuntimeClient.test.ts test/audio/audioErrors.test.ts src/pages/Tools/Audio/shared/audioErrorMessage.test.ts --reporter=dot
node_modules/.bin/tsc --noEmit
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'route-aware speech synthesis' --reporter=dot
git diff --check
```

结果：

- 聚焦 registry/config/main/adapter/HTTP/UI：7 files / 119 tests 通过。
- 完整音频相关回归：19 files / 255 tests 通过。
- TypeScript 通过。
- 四语言 i18n 完整性通过，`audio` namespace 各 355 keys；源码引用门禁通过。
- renderer、Electron main、preload 的 Vite test build 通过；仅保留既有 chunk size 和
  dynamic/static import 警告。
- Electron 聚焦 E2E：1 test 通过；覆盖 `alloy` 遗留值的字段错误、禁用生成、选择
  `mimo_default` 后恢复，以及 MiMo 三模式非流/流式请求。
- 已审查 1280×800 与 786×540 两张非法音色截图；错误提示完整换行，无横向溢出或
  控件重叠。
- `git diff --check` 通过。

全程未执行 `pnpm`，`pnpm-lock.yaml` 未修改；E2E 启动的 Electron/Vite 进程在结束前
检查并清理。
