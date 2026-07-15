# FIX-R07：音频 Radio 组复用字幕文件翻译基线

> 日期：2026-07-15
> 状态：已完成
> 对应工作包：`FIX-R07`

## 背景与现象

`FIX-R06` 将音频配置面板的互斥按钮迁移到音频目录下新建的 `AudioSegmentedControl`。
虽然行为测试通过，但实际样式仍与字幕文件翻译工具不一致：音频控件自行定义了高度、字号、
边框、圆角和选项布局，没有复用字幕工具当前使用的 `ButtonGroup + Button` 视觉基线。

## 根因与设计缺口

- 验收时只比较了“无 gap、连续边框、键盘可用”等抽象属性，没有追踪字幕文件翻译页面的
  真实组件来源。
- `AudioSegmentedControl` 复用了 Radix primitive，却没有复用目标页面的共享
  `@/components/ui/button-group` 与 `Button(size="sm", className="flex-1")`。
- 自动化证明了音频组内部一致，但没有证明它与字幕文件翻译基线是同一个组件。

## 修复后行为

- 在工具页共享 UI 中新增 `ToolRadioButtonGroup`，内部直接组合现有 `ButtonGroup` 和 `Button`，
  默认样式与字幕文件翻译当前按钮组一致。
- 字幕文件翻译的输出模式、分片模式、输出路径、冲突策略与全部音频 Radio 组共同使用该组件。
- 删除 `src/pages/Tools/Audio/shared/AudioSegmentedControl.tsx`，音频目录不再保留私有 Radio 视觉规则。
- 共享组件补充 `radiogroup/radio`、roving tabindex、方向键、Home/End，不改变字幕基线外观。

## 影响文件

- `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.tsx`
- `src/pages/Tools/_shared/ui/index.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- 四个音频工具详情页
- `test/e2e.spec.ts` 与本主题设计、台账、实施记录

## 实现摘要

- 新增工具级共享组件 `ToolRadioButtonGroup`，视觉结构只使用字幕文件翻译原有的
  `ButtonGroup className="w-full"` 与 `Button size="sm" className="min-w-0 flex-1"`；
  未新增音频专用的高度、字号、间距、边框、圆角或颜色规则。
- 字幕文件翻译的四组配置项和 TTS、音频转文本、实时字幕、Realtime Voice 的全部 Radio
  按钮组均迁移到该组件，后续 `Button` / `ButtonGroup` 设计令牌调整会同步生效。
- 删除音频目录下的 `AudioSegmentedControl`。Realtime 音频格式显示使用紧凑的
  `PCM16 / PCMU / PCMA`，完整 G.711 含义保留在可访问名称中，窄配置面板不溢出。
- 共享组件集中维护 `radiogroup/radio`、`aria-checked`、`data-state`、单一可 Tab 项、
  Arrow/Home/End 焦点与选中态；TTS pointer 切换后的主字段聚焦行为保持不变。
- 新增组件合同测试与 Electron 跨页面对比：先读取字幕页面实际按钮组的计算样式签名，再与
  音频页面逐项比较，不再用两套独立的“近似一致”断言。

## 验证命令与结果

执行命令：

```text
node_modules/.bin/tsc --noEmit
node_modules/.bin/vitest run src/pages/Tools/_shared/ui/ToolRadioButtonGroup.test.tsx --reporter=dot
node scripts/check-i18n.mjs
node scripts/check-i18n-usage.mjs
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts -t 'subtitle and audio radio groups share the same ButtonGroup baseline|standalone audio settings|route-aware speech synthesis|route-aware audio transcription|route-aware realtime captions|route-aware realtime voice' --reporter=dot
git diff --check
```

结果：

- TypeScript 与共享组件合同测试通过：`1 file / 1 test`。
- 四语言 locale parity 通过，每种语言 1482 keys；源码 usage 检查为 1344 calls / 1376
  resolved keys。
- renderer/main/preload test build 通过，仅有既有 dynamic import 与 chunk size warning。
- Electron 最终 `6 passed / 2 skipped`：字幕基线对比、音频设置、TTS、音频转文本、实时字幕、
  Realtime Voice 均通过；Radio click/Arrow/Home/End、roving tabindex 与横向溢出断言通过。
- Electron 从字幕页面实际组件读取 slot、size、variant、高度、字号、字重、padding、前景色和
  背景色签名，音频组与其完全相等；截图输出到
  `test-results/fix-r07-subtitle-radio-baseline.png` 和
  `test-results/fix-r07-audio-radio-baseline.png`。
- `pnpm-lock.yaml` 未修改；测试结束后 FusionKit Vite/Electron 进程表为空。

## 后续建议

- 后续要求“与某页面一致”时，必须先定位并复用目标页面的真实组件，不得仅按截图或抽象 CSS
  属性重建近似实现。
