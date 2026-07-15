# 工作包 FIX-R07：复用字幕文件翻译 Radio 按钮组

## 基本信息

- 日期：2026-07-15
- 状态：已完成
- 对应执行计划工作包：`FIX-R07`

## 本次实现内容

- 从字幕文件翻译的现有 `ButtonGroup + Button(size="sm")` 结构抽取工具级
  `ToolRadioButtonGroup`，未在音频目录复制视觉样式。
- 将字幕文件翻译的输出模式、分片模式、输出路径、冲突策略迁移到共享组件。
- 将 TTS 模式/输出位置、音频转文本输出位置、实时字幕输入格式和 Realtime Voice
  输入/输出格式迁移到同一组件。
- 删除音频私有 `AudioSegmentedControl`，集中维护 Radio 语义与键盘行为。
- 新增组件合同测试与 Electron 字幕/音频计算样式签名对比，并更新设计、fix、台账与 pitfall。

## 修改文件

- `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.tsx`
- `src/pages/Tools/_shared/ui/ToolRadioButtonGroup.test.tsx`
- `src/pages/Tools/_shared/ui/index.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/pages/Tools/Audio/{AudioTranscriber,SpeechSynthesizer,RealtimeCaptions,RealtimeVoice}/index.tsx`
- `test/e2e.spec.ts`
- `docs/v0.2.11/audio-toolkit/` 下的 Final Design、Execution Plan、FIX-R06/R07 文档
- `.agents/skills/fusionkit-pitfall-guard/references/`

## 接口或数据结构变化

- 不涉及 public IPC、持久化 schema 或供应商请求结构。
- 新增工具页内部泛型组件合同：`value`、`options`、`ariaLabel`、`onValueChange`，可选
  `onPointerValueChange`、`disabled`、`ariaLabel/testId` option metadata。
- 视觉唯一来源为通用 `ButtonGroup` 和 `Button`；共享组件只补充 Radio 语义、焦点管理和
  `min-w-0` 防溢出约束。

## 验证结果

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

- TypeScript、`1 file / 1 test` 组件合同测试通过。
- 四语言各 1482 keys；usage 1344 calls / 1376 resolved keys 通过。
- renderer/main/preload test build 通过，仅有既有构建 warning。
- Electron `6 passed / 2 skipped`；字幕与音频实际计算样式签名完全一致，五条音频链路的
  click/Arrow/Home/End、单一可 Tab 项、选中态及无横向溢出断言通过。
- 生成 `test-results/fix-r07-subtitle-radio-baseline.png` 与
  `test-results/fix-r07-audio-radio-baseline.png` 供视觉复核。
- `pnpm-lock.yaml` 未修改；FusionKit Vite/Electron 前端进程已清理。

## 未完成事项

- 无。真实供应商与设备验收仍属于既有 `QA-R02`，不影响本工作包的组件复用合同。

## 下一步建议

- 继续 `TEST-R01` 自动化矩阵审计；后续跨页面视觉一致性需求先抽取源页面真实组件，再增加
  跨消费者结构和计算样式对比。
