# 工作包 PRE-003：模型响应协议与 Fake Server 验证

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：`PRE-003`

## 本次实现内容

- 核对现有字幕翻译、名称翻译和 AI SDK OpenAI Compatible 调用链。
- 新增可复用的本地 Fake OpenAI Compatible Server：
  - 使用随机回环端口。
  - 捕获请求 method、URL、headers 和 JSON body。
  - 支持排队静态响应或按请求动态生成响应。
  - 提供 OpenAI chat completions 响应构造器。
- 验证 OpenAI 风格 `content + usage + finish_reason` 返回。
- 验证 DeepSeek 风格独立 `reasoning_content` 和 usage 缺失返回。
- 实测 AI SDK `Output.object()` 会发送 `response_format`，部分兼容服务可直接拒绝该字段。
- 固定首版响应协议：
  - 普通翻译使用纯译文文本。
  - 串行翻译使用动态 translation / memory patch / end 三段边界。
  - `memoryPatch` 使用严格、受限 JSON schema。
- 实现协议探针：
  - 开头 think 标签清理。
  - finish reason 分类。
  - 动态边界唯一性与顺序验证。
  - memory patch 严格解析。
  - 非法 patch 时“译文成功、记忆未更新”。
  - Markdown 保护占位符缺失、重复、未知和乱序验证。
  - 生成明确列出期望占位符的加强约束重试指令。
- 对比单个严格 JSON 对象：其中 patch 非法时无法安全保留已经有效的译文，因此不作为首版基础协议。

## 协议决策

串行线协议示例：

```text
<<<FUSIONKIT_TRANSLATION:segment-42>>>
译文正文
<<<FUSIONKIT_MEMORY_PATCH:segment-42>>>
{"currentSceneSummary":"..."}
<<<FUSIONKIT_END:segment-42>>>
```

约束：

1. 边界 ID 与当前 segment/request 绑定，只允许字母、数字、`_`、`-`。
2. 三个边界各出现一次且顺序固定，前后不允许附加解释。
3. 边界或译文无效时整个响应重试。
4. 占位符无效时不接受译文，使用加强约束 prompt 重试。
5. 仅 memory patch 无效时，接受已经通过其他校验的译文，但不得更新稳定记忆或推进 memory version。
6. 首版不要求供应商支持 JSON Schema、tool calling 或私有结构化输出字段。

受限 `SemanticMemoryPatch` 只允许：

- 替换 document/chapter/scene summary。
- upsert characters 和 model terminology。
- 追加 style rules、unresolved context、recent continuity notes。
- 标识已解决的 unresolved context。

不允许模型直接修改 schema/version、声明用户术语来源或提交任意 JSON Patch 路径。

## 修改文件

- `test/text-translation/protocol/fakeOpenAICompatibleServer.ts`
- `test/text-translation/protocol/modelResponseProtocolProbe.ts`
- `test/text-translation/protocol/modelResponseProtocolProbe.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-003_model-response-protocol-validation.md`

## 接口或数据结构变化

- 未修改正式产品接口。
- 验证代码新增：
  - `SemanticMemoryPatch`
  - `TranslationProtocolError`
  - 普通/串行响应解析结果。
  - Fake server request/response 类型。
- Final Design 已把领域层 `SequentialTranslationResponse` 与实际线协议区分开。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/protocol/modelResponseProtocolProbe.test.ts
pnpm exec vitest run test/text-translation
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit --target ESNext --module ESNext --moduleResolution Node --strict --skipLibCheck --allowSyntheticDefaultImports --lib ESNext,DOM --types node,vitest/globals test/text-translation/protocol/fakeOpenAICompatibleServer.ts test/text-translation/protocol/modelResponseProtocolProbe.ts test/text-translation/protocol/modelResponseProtocolProbe.test.ts
pnpm build
git diff --check
```

结果：

- PRE-003 定向验证：11 tests passed。
- 文本翻译全量验证：34 tests passed（编码 16 + Markdown 7 + 协议 11）。
- Fake HTTP 测试需要允许监听本机 `127.0.0.1` 随机端口；不访问外部网络。
- 最后一次测试变量类型收紧后，协议测试文件的独立 strict TypeScript 检查通过，且无需监听端口的 8 个协议解析用例再次通过；受限沙箱未再次授权回环端口，3 个 HTTP 用例最近一次完整运行结果仍为 3/3 passed。
- 安装中的 `@ai-sdk/openai-compatible@1.0.34` 在 `ai@6.0.116` 下会输出 v2 specification compatibility warning，但本次验证的文本、reasoning、usage 和 finish reason 均可工作。是否升级 provider major 由 BE-004 实现时单独评估。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm build` 通过，包括 Renderer、Electron main/preload 和 macOS arm64 DMG/ZIP 打包；仅保留现有的动态/静态导入混用、chunk 偏大、缺少 package description 和本机无签名身份等非阻断警告。
- `git diff --check` 通过。
- 没有启动前端服务。

## 未完成事项

- Fake server 尚未覆盖 408/429/5xx、401/403、timeout、abort 和 `Retry-After`；这些属于 BE-004 通用模型客户端验收范围。
- 本工作包只验证 patch schema 与降级边界，实际 memory merge、用户术语冲突和版本推进由 MEM-002 实现。
- 未连接真实供应商，真实模型组合留给 QA-003。

## 下一步建议

- 继续 PRE-004：小说级资源与工作区策略验证。
- PRE-004 完成后进入 CORE-001，正式建立共享领域类型。
