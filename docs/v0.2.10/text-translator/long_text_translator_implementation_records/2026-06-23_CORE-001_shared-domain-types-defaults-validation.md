# 工作包 CORE-001：共享领域类型、默认值与校验

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：`CORE-001`

## 本次实现内容

- 新增长文本翻译共享领域类型模块 `src/type/textTranslation.ts`。
- 固化首版核心类型：
  - 文件格式、执行模式、输出模式、项目模式。
  - 任务状态，包含 `partially_completed`。
  - 任务阶段，包含 `detecting_encoding` 等错误定位阶段。
  - 文件引用、任务、进度、恢复摘要。
  - 创建任务请求、运行期模型配置、持久化任务 DTO。
- 固化 Final Design 默认值：
  - `executionMode = parallel`
  - `outputMode = target_only`
  - `projectMode = independent_files`
  - `sliceTokenLimit = 3000`
  - `semanticMemoryTokenLimit = 8192`
  - `modelContextTokenLimit = 32768`
  - `outputTokenReserve = max(4096, sliceTokenLimit * 2)`
  - `parallelSliceConcurrency = 3`
- 固化 PRE-004 资源边界：
  - TXT 单文件 50 MB 软警告、200 MB 硬限制。
  - Markdown 单文件 5 MB 软警告、10 MB 硬限制。
  - 项目总量 200 MB 软警告、1 GB 硬限制。
  - 成功任务保留 7 天，非成功任务 30 天后建议清理。
- 实现纯函数：
  - `createTextTranslationOptions`
  - `createInitialTextTranslationProgress`
  - `createTextTranslationTask`
  - `createPersistedTextTranslationTask`
  - `validateTextTranslationConfig`
  - `estimateTextTranslationWorkspaceDiskRequirement`
  - `assessTextTranslationDiskSpace`
  - `estimateTextTranslationRequiredContextTokens`
- 新增单元测试覆盖默认值、同名文件隔离、稳定错误码、资源限制、磁盘估算、持久化 DTO 不含敏感字段。

## 修改文件

- `src/type/textTranslation.ts`
- `src/type/textTranslation.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_CORE-001_shared-domain-types-defaults-validation.md`

## 接口或数据结构变化

- 新增共享领域类型，不修改既有字幕翻译类型。
- 新增 `TextTranslationRuntimeModelConfig` 用于运行期请求，包含 `apiKey`。
- 新增 `PersistedTextTranslationTask` 和 `TextTranslationPersistedModelRef`，明确持久化结构不包含 `apiKey`、Authorization 或完整 model profile。
- `validateTextTranslationConfig` 返回稳定 `TextTranslationErrorCode`，后续 IPC 和 UI 可直接复用。

## 验证结果

执行命令：

```text
pnpm exec vitest run src/type/textTranslation.test.ts
pnpm exec vitest run src/type/textTranslation.test.ts test/text-translation/resource/workspaceStrategyProbe.test.ts test/text-translation/encoding/encodingProbe.test.ts test/text-translation/markdown/markdownAstProbe.test.ts
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- CORE-001 定向测试：8 tests passed。
- CORE-001 + 已有 PRE 相关组合测试：37 tests passed。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm build` 通过，包括 Renderer、Electron main/preload 和 macOS arm64 DMG/ZIP 打包；仅保留现有的动态/静态导入混用、chunk 偏大、缺少 package description 和本机无签名身份等非阻断警告。
- `git diff --check` 通过。
- 没有启动前端服务。

## 未完成事项

- 本工作包只建立共享领域契约，不注册 IPC channel。
- 运行期模型凭据的 IPC 入参校验和脱敏错误返回由 CORE-002 实现。
- 受控 workspace root 路径校验和真实磁盘检查由 BE-001 接入。

## 下一步建议

- 进入 CORE-002：Namespaced IPC DTO 与事件序列契约。
- CORE-002 应直接复用 `src/type/textTranslation.ts` 的 request、error、progress 和 persisted-safe 类型。
