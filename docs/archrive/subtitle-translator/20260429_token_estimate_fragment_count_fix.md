# 字幕翻译 Token 预估与分片数量修复说明

日期：2026-04-29

## 背景

字幕翻译任务在敏感模式下会出现严重高估，例如日语转中文双语字幕、敏感模式、DeepSeek 模型时，任务详情可能显示：

- 分片数量：649 个分片
- Token 预估：输入 130.4K / 输出 974

这类结果和实际翻译分片数量不符，会放大费用预期，也会误导用户判断是否启用并发分片。

## 根因

旧预估逻辑直接用整份字幕 token 数计算：

```ts
fragmentCount = ceil(originalTokens / (maxTokens - promptOverhead))
inputTokens = originalTokens + fragmentCount * promptOverhead
```

其中 `promptOverhead` 固定为 200，而敏感模式 `maxTokens` 只有 100。分母变成负数后又被兜底为 1，导致 649 个原文 token 被估算为 649 个分片，输入 token 也被叠加为 `649 + 649 * 200`，因此出现 130K 级别的异常输入预估。

同时旧逻辑还有三处口径不一致：

- 实际翻译按 LRC 行或 SRT 字幕块切片，预估却按整文平均 token 切片。
- prompt 开销被错误地用于压缩分片容量，而真实切片逻辑不会从 `maxTokens` 中扣除 prompt。
- 自定义分片长度只参与前端预估，没有随任务传给主进程执行。

后续复查又发现一个残留问题：前端上传文件时会先写入 `estimateSubtitleTokensFast` 的同步启发式结果，再异步回填 `gpt-tokenizer` 的精确结果。如果用户在精确回填前点击开始，任务详情可能仍显示启发式分片数，例如 8 个分片；主进程开始执行后会用真实 tokenizer 切片，于是进度立刻变成 5 个分片。这说明“首屏预估”和“执行切片”仍不是同一口径。

## 修复方案

本次修复将预估口径改为贴近真实执行：

1. 新增 `src/utils/subtitleTokenEstimateCore.ts`，统一封装字幕 token 预估核心逻辑。
2. 分片数量按文件类型模拟实际切片：
   - LRC：逐行累计 token，超过上限后开新片。
   - SRT：按完整字幕块累计 token，不拆分单个块。
3. 输入 token 不再用固定 `promptOverhead` 倒推，而是对每个预估分片构造与翻译器一致的 prompt，再逐片累计 token。
4. 输出 token 按输出模式区分：
   - 仅译文：按原文 token 的翻译扩展量估算。
   - 双语字幕：按原文 + 译文估算。
5. `customSliceLength` 写入任务并传给主进程，保证自定义分片长度的预估和实际翻译一致。
6. 前端同步预估不再使用字符启发式 tokenizer，改为直接使用 `gpt-tokenizer`，确保任务刚加入队列时的分片数就和主进程执行口径一致。
7. 编辑任务配置后立即重新计算预估，避免任务详情继续显示旧配置下的成本。
8. 队列收到主进程 `update-progress` 后，会用真实 `totalFragments` 同步修正 `costEstimate.fragmentCount`，作为防御性兜底，避免任务详情和进度条显示不同分片数。

## 验证

已新增 `src/utils/tokenEstimate.test.ts` 覆盖敏感模式下的异常分片场景：

- 60 行 LRC、敏感模式下，分片数量保持在真实切片同量级，而不是旧逻辑下按 token 数膨胀出的数百片。
- 双语输出 token 预估大于仅译文输出。
- 同步预估和异步预估使用同一 tokenizer，分片数和输入 token 保持一致。
- `translatorQueueService` 覆盖进度回传时用真实 `totalFragments` 修正任务预估分片数的兜底逻辑。

本地验证结果：

```bash
pnpm exec vitest run src/utils/tokenEstimate.test.ts src/services/subtitle/translatorQueueService.test.ts
pnpm exec tsc --noEmit
```

以上均通过。

全量 `pnpm exec vitest run` 中，非 E2E 测试均通过；`test/e2e.spec.ts` 在当前沙箱中因 Electron/Playwright 无法启动桌面进程失败，错误为 `electron.launch: Process failed to launch`，与本次 token 预估逻辑无关。
