# 字幕 AI 翻译实际 Token 用量与费用显示最终设计

## 1. 背景

字幕翻译的 Chat Completions 与 Responses adapter 已能解析供应商响应中的 usage，
但 BaseTranslator 没有把 usage 传入任务状态、checkpoint 或 Renderer。当前页面始终读取
翻译前的 costEstimate，因此任务完成后仍显示误差较大的预估 Token 与费用。

DeepSeek V4 价格也已调整。2026-08-22 官方 Models & Pricing 页面显示：

- deepseek-v4-flash：cache miss 输入 / 输出的非高峰价为 $0.22 / $0.66，
  高峰价为 $0.44 / $1.32（每 1M Token）。
- deepseek-v4-pro：cache miss 输入 / 输出的非高峰价为 $0.66 / $1.98，
  高峰价为 $1.32 / $3.96（每 1M Token）。
- 高峰时段为 01:00-04:00 与 06:00-10:00 UTC；其他时段为非高峰。

FusionKit 的 TokenPricing 目前每个 profile 只能保存一组输入/输出价格，不能表达分时价和
cache hit/miss 价，因此内置模型默认采用高峰 cache-miss 价，避免低估。用户仍可在 profile
中改成适合自身使用时段的价格。

## 2. 目标

- 逐个累计供应商响应返回的实际 input/output/total/reasoning/cached input Token。
- 进度、成功、失败与恢复任务均保留已经发生的实际用量。
- 明确区分“API 报告的实际 Token”与“按配置单价计算的费用”。
- 页面汇总展示实际已消耗值，并保留未执行部分的预估成本。
- 更新 DeepSeek V4 Flash/Pro 内置价格与测试。

## 3. 非目标

- 不把按 profile 单价计算的费用声明为供应商最终账单。
- 本次不扩展 TokenPricing 为分时/cache hit 多价格结构。
- 不通过额外账单 API 查询真实扣费。
- 不改动其他 AI 工具的用量 UI。

## 4. 当前数据流

```text
Model adapter -> ModelRuntimeTextResult.usage
              -> LRC/SRT parseResponse 内部累计但不输出
              -> BaseTranslator progress event 不含 usage
              -> Renderer task 只保留 costEstimate
              -> UI 永远显示预估值
```

## 5. 最终数据流

```text
Model adapter
  -> ModelRuntimeUsage
  -> BaseTranslator.recordUsage()
  -> SubtitleTranslationUsage 累计值
  -> checkpoint manifest.usage
  -> update-progress / task-resolved / task-failed
  -> Renderer queue task.actualUsage
  -> 任务行、详情与汇总统计
```

## 6. 数据合同

SubtitleTranslationUsage 包含：

- inputTokens、outputTokens、totalTokens：供应商报告值的累计。
- reasoningTokens、cachedInputTokens：供应商提供时累计，缺失按 0。
- requestCount：收到模型成功响应的次数；即使后续内容解析失败也计数。
- reportedRequestCount：同时提供 input/output usage 的响应次数。
- calculatedCost：仅在任务冻结了有效 TokenPricing 时累计，单位美元。

当 reportedRequestCount 小于 requestCount 时，UI 必须标为“部分报告”，不得把累计值描述为
完整实际用量。旧任务没有 tokenPricing 时仍显示实际 Token，但计算费用显示不可用。

SubtitleTaskReadyExecutionBinding 新增可选 tokenPricing 快照。新建、编辑、Agent、自动导入
任务都通过现有 createSubtitleTaskExecutionBinding/createSubtitleTaskModelFields 冻结价格。

checkpoint v1/v2 读取保持兼容，usage 为可选新增字段。旧 checkpoint 缺失 usage 时按零用量
处理；恢复任务把 manifest usage 带回 Renderer，后续请求在原累计值上继续。

## 7. 聚合与并发

- usage 在 BaseTranslator 收到 ModelRuntimeTextResult 后、调用 parseResponse 前记录，因此模型
  已返回但字幕清洗失败并重试的请求也不会漏记。
- JavaScript 主线程中的单次同步累加作为并发分片的串行临界区，不跨 await 拆分读写。
- 任一并发 worker 失败后停止领取新分片，但通过 `Promise.allSettled` 等待所有已发出请求结束，
  再冻结失败事件与 checkpoint usage，避免漏计仍在途的响应。
- 每个分片写 checkpoint 前同步累计 usage；任务失败 flush checkpoint 前再次同步。
- totalTokens 优先累计供应商 totalTokens，缺失时回退 inputTokens + outputTokens。
- Renderer 任务与 checkpoint 同时存在 usage 时选择 requestCount/report coverage 更完整的快照，
  避免 checkpoint 写入失败后的旧快照覆盖内存中的新累计值。

## 8. UI 行为

- 未开始且无 actualUsage 的任务继续显示 `~预估 Token / ~预估费用`。
- 已收到 usage 的任务行显示实际累计 Token 与按配置单价计算的费用；部分报告附带状态提示。
- 展开详情同时展示“实际用量”和“任务预估”，便于比较偏差。
- 页面统计区改为：任务数、实际 Token、按配置价计算的已发生费用、剩余预估费用。
- 剩余预估费用：未开始/等待任务使用完整预估；运行中任务使用
  max(预估费用 - 已计算费用, 0)；已完成/失败任务不计入剩余。
- Tooltip 明确最终账单以供应商为准，DeepSeek cache hit 与分时价可能造成差异。

## 9. 兼容与安全

- 新字段全部可选，旧任务和 checkpoint 不因缺失而失效。
- usage 与 tokenPricing 不包含 API Key、请求正文或字幕内容。
- IPC 只传非负有限数值，并在主/Renderer 类型守卫中校验。
- 任务重试沿用已累计实际用量；任务编辑重新冻结当前 profile 单价但不重写已发生费用。

## 10. 验证

- Adapter usage 字段解析测试。
- BaseTranslator 顺序、解析重试、失败与 DeepSeek 请求集成测试。
- Queue progress/resolved/failed usage 合并测试。
- checkpoint 写入、旧版本默认与恢复测试。
- 任务绑定冻结 pricing、DeepSeek 价格测试。
- UI 源码合同、TypeScript、i18n source usage、根 Vite 三段构建和 diff check。
