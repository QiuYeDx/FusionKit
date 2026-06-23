# LRC Translation Empty Result Investigation

日期：2026-04-29

## 背景

字幕翻译任务近期多次出现如下失败：

- 任务名称：`05_es_interview_dialogue.lrc`
- 错误消息：`请求接口失败`
- 错误详情：`Translation result is undefined`
- 典型日志：接口第 1 次请求已成功，但并发分片随后失败

日志中失败点示例：

```text
第 1 次翻译请求成功
[并发] 第 7 个分片翻译失败: Translation result is undefined
任务失败: Translation result is undefined
```

## 排查范围

本次只做问题定位和修复方案设计，未修改翻译实现代码。

已检查的关键路径：

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/class/lrc-translator.ts`
- `electron/main/translation/class/srt-translator.ts`
- `electron/main/translation/translation-service.ts`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/services/subtitle/translatorQueueService.ts`
- `test/subtitles/05_es_interview_dialogue.lrc`

## 结论

这类报错不是典型的 HTTP/API 请求失败。

实际链路是：

1. `axios.post()` 已成功拿到 `response.data`。
2. `translateFragment()` 记录“翻译请求成功”。
3. `LRCTranslator.parseResponse()` 从响应中提取 `choices[0].message.content`。
4. `cleanTranslatedContent()` 清洗 LRC 内容。
5. 清洗结果为空字符串。
6. 外层分片 worker 用 `if (!result)` 判断失败，抛出 `Translation result is undefined`。

也就是说，日志里的“请求接口失败”是上层统一失败文案；底层更准确的问题是“接口成功，但解析后的翻译结果为空”。

## 高概率根因

### 1. LRC 清洗规则过于严格

当前 LRC 清洗逻辑只保留严格以 `[` 开头的行：

```ts
.filter((line) => line.startsWith("["))
```

如果模型返回行首带空格，例如：

```text
  [01:54.80]我们记得自己想记得的东西。
```

该行会被过滤掉。

如果整个分片的有效 LRC 行都带缩进，最终清洗结果就是空字符串。

### 2. 空结果校验位置不合理

`translateFragment()` 的重试逻辑只覆盖接口调用和 `parseResponse()` 内部抛错。

空字符串校验发生在外层：

```ts
if (!result) {
  throw new Error("Translation result is undefined");
}
```

因此清洗为空时不会触发 5 次重试，而是直接让整个任务失败。

### 3. 错误信息不够精确

当前错误名为 `Translation result is undefined`，但实际结果可能是：

- `undefined`
- `null`
- 空字符串 `""`
- 清洗后为空

这些情况被同一个 `if (!result)` 合并，导致定位成本较高。

### 4. 并发模式会放大失败影响

并发分片模式下，任一分片失败都会设置 `failed = true` 并导致 `Promise.all()` reject。

当前失败后已经发出的其它请求不会被主动取消，因此还可能产生额外 token 消耗。

## 本次样例的定位

`05_es_interview_dialogue.lrc` 在敏感分片模式下会被拆成 9 个分片。

失败日志指向第 7 个分片。按当前拆分逻辑，第 7 个分片大致对应：

```text
[01:54.80]Recordamos lo que queremos recordar.
[01:57.50]Y al recordar, inevitablemente inventamos.
[02:01.20]Por eso la literatura y la vida
[02:04.80]son inseparables.
[02:07.50]Maestro, una última pregunta.
[02:10.20]¿Qué consejo le daría a los jóvenes escritores?
```

这段内容本身没有明显非法格式，更符合“模型返回格式轻微偏离，清洗规则误杀”或“模型返回空内容”的场景。

## 建议修复方案

### 方案 A：必须修复

把空结果校验移入 `translateFragment()` 的重试循环内。

目标行为：

- API 成功但解析结果为空时，记录为空结果错误。
- 进入已有的 retry 流程。
- 最多重试 `maxRetries` 次。
- 达到最大重试次数后再失败。

这能直接解决“偶发模型返回格式异常导致整个任务立即失败”的问题。

### 方案 B：必须修复

放宽 LRC 清洗逻辑。

建议行为：

- 每行先 `trim()` 再判断是否以 `[` 开头。
- 代码块围栏移除支持 ` ```lrc `、` ```plaintext `、` ```text ` 和无语言标记。
- 保留清洗后的有效 LRC 行，不保留模型说明文字。

示例目标：

```text
  [01:54.80]我们记得自己想记得的东西。
```

应被清洗为：

```text
[01:54.80]我们记得自己想记得的东西。
```

### 方案 C：建议修复

增强日志，便于后续排查。

建议在解析结果为空时记录：

- 当前分片序号
- 原始返回内容长度
- 清洗后内容长度
- 原始返回内容预览，限制 300-500 字符
- 响应结构是否存在 `choices[0].message.content`

注意：日志里不要记录 API key 或请求 header。

### 方案 D：建议修复

强化 LRC prompt。

建议在 LRC prompt 中追加硬性输出约束：

```text
Output only valid LRC lines. Every output line must start with a timestamp or metadata tag in [] format. Do not add markdown formatting or explanations.
```

这能减少模型返回说明文字、markdown 包裹或漏时间戳的概率。

### 方案 E：可选优化

并发模式失败后取消剩余请求。

当前 `AbortSignal` 只在开始分片前检查，没有传给 `axios.post()`。后续可考虑：

- 为每个任务创建内部 `AbortController`
- 任一分片失败后 abort 其它进行中的请求
- 将 `signal` 传入 axios config

该优化主要减少失败后的 token 浪费，不是本次报错的首要修复点。

## 建议改动文件

首轮修复建议只触碰：

- `electron/main/translation/class/base-translator.ts`
- `electron/main/translation/class/lrc-translator.ts`

不建议在首轮修改队列状态、UI、IPC 或 SRT 翻译器，避免扩大影响面。

## 验证计划

修复后建议执行以下验证：

1. 对 `cleanTranslatedContent()` 做最小单元验证：
   - 正常 LRC 行
   - 行首带空格的 LRC 行
   - markdown 代码块包裹的 LRC
   - 混入说明文字
   - 完全无有效 LRC 行

2. 对空结果重试做最小验证：
   - mock 第一次返回空内容
   - mock 第二次返回有效 LRC
   - 确认任务最终成功且日志包含第一次空结果失败

3. 用 `test/subtitles/05_es_interview_dialogue.lrc` 做人工回归：
   - 敏感分片模式
   - 并发分片开启
   - 西班牙语到中文
   - 双语输出

4. 确认 SRT 翻译不受影响。

## 执行边界

本文档仅记录排查结论和拟定修复方案。

在用户明确确认开始修复前，不修改翻译实现代码。
