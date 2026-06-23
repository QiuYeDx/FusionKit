# 工作包 PRE-004：小说级资源与工作区策略验证

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：`PRE-004`

## 本次实现内容

- 新增资源 benchmark 脚本，用临时目录生成并清理大样本，不提交大文件。
- 测量 1 MB、10 MB、50 MB TXT 的读取、解码、抽样 token 估算、分片规划和内存。
- 测量代表性 5 MB Markdown 的 Unified/remark AST 解析成本。
- 新增工作区策略 probe：
  - TXT/Markdown/项目总量软警告与硬限制。
  - 工作区磁盘需求估算。
  - `fs.promises.statfs` 可用空间检查。
  - 原子 JSON 写入。
  - NDJSON append。
  - 独立 segment result 写入。
  - 单片完成不重写大型 manifest/index。
  - 清理候选只允许受控 workspace root 内路径。
- 根据实测结果更新 Final Design 的首版资源边界。

## 关键实测结果

环境：

- Node：v20.19.5
- 平台：darwin arm64
- 临时目录：系统 `/tmp`/`TMPDIR`
- GC：`--expose-gc`

TXT：

| 大小 | 读取 | UTF-8 解码 | 64KB 抽样 token 估算 | 分片规划 | segment 数 | 观测 RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 MB | 0.25 ms | 2.27 ms | 7.26 ms | 0.28 ms | 63 | 114.59 MB |
| 10 MB | 1.43 ms | 19.57 ms | 6.10 ms | 1.42 ms | 622 | 135.59 MB |
| 50 MB | 12.32 ms | 93.13 ms | 5.83 ms | 5.43 ms | 3,110 | 247.39 MB |

Markdown：

| 大小 | 读取 | UTF-8 解码 | AST parse | AST 节点 | 观测 RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5 MB | 0.56 ms | 7.62 ms | 67,907 ms | 404,150 | 1,463.88 MB |

工作区模型：

- 10,000 segment 的 `segments/index.ndjson`：约 880,000 bytes。
- 单片独立 result 写入：约 12,000 bytes，0.75 ms。
- 单片 event append：217 bytes，0.62 ms。
- 对照单体 JSON manifest：约 1,150,968 bytes，单次写入 3.77 ms；若每片完成都重写，会产生明显写放大。

## 设计决策

首版资源边界：

- TXT 单文件软警告：50 MB。
- TXT 单文件硬限制：200 MB。
- Markdown 单文件软警告：5 MB。
- Markdown 单文件硬限制：10 MB。
- 项目总量软警告：200 MB。
- 项目总量硬限制：1 GB。

Token 估算：

- 准备阶段不得同步精确 token 化整本小说。
- 默认抽样 64 KB 做精确 token 计数，再按字节/字符比例估算全文。
- 对正式 segment 可再做局部更精确预算。
- 执行后以模型 usage 修正真实消耗。

磁盘空间：

```text
minimumRequiredBytes = sourceBytes * 2 + 64 MB
recommendedAvailableBytes = sourceBytes * 3.5 + 128 MB
```

- 低于 minimum：准备阶段硬阻断。
- 低于 recommended：允许继续，但显示警告。
- 优先使用 `fs.promises.statfs(workspaceRoot)`；不可用时退化为软警告。

清理策略：

- 成功任务默认保留工作区 7 天，到期可自动清理。
- 失败/取消/部分完成任务默认不自动清理，30 天后标记为建议清理；高级设置可允许自动清理。
- 删除只允许作用于受控 workspace root 内的 task 目录。

## 修改文件

- `test/text-translation/resource/resourceBenchmark.mjs`
- `test/text-translation/resource/workspaceStrategyProbe.ts`
- `test/text-translation/resource/workspaceStrategyProbe.test.ts`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-004_resource-workspace-strategy-validation.md`

## 接口或数据结构变化

- 未修改正式产品接口。
- 验证代码新增资源边界常量和策略函数，供 CORE-001 正式类型与默认值实现时参考：
  - `assessSourceSize`
  - `estimateWorkspaceDiskRequirement`
  - `assessDiskSpace`
  - `getAvailableDiskBytes`
  - `atomicWriteJson`
  - `appendNdjson`
  - `completeSegment`
  - `selectCleanupCandidates`

## 验证结果

执行命令：

```text
node --expose-gc test/text-translation/resource/resourceBenchmark.mjs
pnpm exec vitest run test/text-translation/resource/workspaceStrategyProbe.test.ts
pnpm exec vitest run test/text-translation/resource/workspaceStrategyProbe.test.ts test/text-translation/encoding/encodingProbe.test.ts test/text-translation/markdown/markdownAstProbe.test.ts
pnpm exec tsc --noEmit --target ESNext --module ESNext --moduleResolution Node --strict --skipLibCheck --allowSyntheticDefaultImports --lib ESNext,DOM --types node,vitest/globals test/text-translation/resource/workspaceStrategyProbe.ts test/text-translation/resource/workspaceStrategyProbe.test.ts
node --check test/text-translation/resource/resourceBenchmark.mjs
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- Benchmark 完成，结果见上文。
- PRE-004 策略测试：6 tests passed。
- 编码 + Markdown + 资源策略组合测试：29 tests passed。
- 资源策略测试文件 strict TypeScript 检查通过。
- Benchmark 脚本语法检查通过。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm build` 通过，包括 Renderer、Electron main/preload 和 macOS arm64 DMG/ZIP 打包；仅保留现有的动态/静态导入混用、chunk 偏大、缺少 package description 和本机无签名身份等非阻断警告。
- `git diff --check` 通过。
- 没有启动前端服务。

## 未完成事项

- 本次 benchmark 使用合成样本，不替代 QA-002 的更多真实小说/真实 Markdown 语料性能验收。
- 未实现生产 `WorkspaceRepository`，只验证策略和 I/O 模型。
- 未测试 Windows 实机 `statfs` 行为；正式实现需 feature detection 并在 QA-003 做跨平台确认。

## 下一步建议

- 进入 CORE-001：共享领域类型、默认值与校验。
- CORE-001 应直接固化本记录中的资源边界、磁盘估算、清理默认值和错误 code。
