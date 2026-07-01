# 工作包 PRE-001：编码探测与解码依赖验证

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：`PRE-001`

## 本次实现内容

- 调研并比较 `chardet`、`jschardet`、`encoding.js`、`iconv-lite` 与 Electron/Node `TextDecoder`。
- 选择 `chardet@2.2.0` 作为统计编码探测器。
- 选择 `iconv-lite@0.7.2` 作为跨平台解码器。
- 建立独立于运行时生成过程的 Base64 二进制 fixtures，覆盖：
  - UTF-8
  - UTF-8 BOM
  - UTF-16 LE BOM
  - UTF-16 BE BOM
  - GB18030
  - Big5
  - Shift-JIS
  - EUC-JP
  - EUC-KR
  - Windows-1252
- 建立 PRE probe，验证以下决策链：
  - BOM 优先。
  - 无 BOM UTF-16 仅在奇偶字节 NUL 分布证据足够时启发式识别。
  - 严格 UTF-8 快路径必须同时通过文本质量检查。
  - 其余输入使用 `chardet` 候选、`iconv-lite` 解码和质量评分共同决策。
  - 低置信度和控制字符密集的二进制输入必须拒绝，并提供手动覆盖候选。
- 验证 Windows-1252 智能引号、破折号和欧元符号映射。
- 将依赖和阈值决策回填 Final Design。

## 依赖评审结论

### 采用

#### `chardet@2.2.0`

- 纯 TypeScript / JavaScript，无原生绑定。
- MIT License。
- 支持本需求涉及的 UTF、东亚多字节编码和 Windows-1252。
- `analyse()` 返回按置信度排序的候选，适合叠加本地质量评分。
- 官方仓库：`https://github.com/runk/node-chardet`

#### `iconv-lite@0.7.2`

- 纯 JavaScript，无本地编译步骤。
- MIT License。
- 覆盖 GB18030、Big5、Shift-JIS、EUC-JP、CP949/EUC-KR、Windows-1252 和 UTF 系列。
- 提供 Buffer/Uint8Array 解码及流式 API，后续 BE-002 可复用。
- 官方仓库：`https://github.com/pillarjs/iconv-lite`

### 不作为首选

#### Electron/Node `TextDecoder`

- Electron 33.4.11 搭载 Node 20.18.3，本地运行时 ICU 74.2。
- 目标编码标签均可创建 decoder。
- 但 Windows-1252 C1 区间实测没有进行 WHATWG 标点映射：
  - 输入 `80 91 92 93 94 97`
  - 输出码点仍为 `U+0080 U+0091 U+0092 U+0093 U+0094 U+0097`
- 因此只保留为严格 UTF-8 快路径验证器，不作为通用最终解码器。

#### `jschardet`

- 当前仓库主线宣称 v4 有较高准确率，但 GitHub release 页面仍显示较旧发布版本，发布状态与主线文档存在不一致。
- 官方性能数据表明模型体积和冷启动成本明显高于轻量方案。
- 本需求有本地质量评分和低置信度拒绝机制，不需要为首版引入更重的探测模型。

#### `encoding.js`

- 同时提供探测和转换，但能力重点更偏日本编码与 Unicode。
- 不如 `chardet + iconv-lite` 的职责拆分清晰，且首版需要覆盖中日韩和 Windows-1252。

## 初始置信度策略

- BOM：确定性结果，解码后仍需质量检查。
- 严格 UTF-8：解码成功且质量分 `>= 0.82` 时接受。
- 统计候选：
  - 探测置信度 `>= 0.55`。
  - 解码质量分 `>= 0.82`。
  - 最佳与次佳置信度差 `>= 0.15`，或最佳置信度 `>= 0.90`。
- 未通过门槛：拒绝自动决定，返回手动覆盖编码列表。
- 这些阈值是 PRE fixtures 的首版基线；BE-002 应将其定义为可测试常量，并通过更多真实语料扩展回归。

## 修改文件

- `package.json`
- `pnpm-lock.yaml`
- `test/text-translation/encoding/encodingProbe.ts`
- `test/text-translation/encoding/encodingProbe.test.ts`
- `test/text-translation/encoding/fixtures/encoding-fixtures.json`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-001_encoding-detection-dependency-validation.md`

## 接口或数据结构变化

- 新增生产依赖：
  - `chardet: 2.2.0`
  - `iconv-lite: 0.7.2`
- 本工作包没有新增正式产品 API。
- 新增的 `encodingProbe.ts` 是 PRE 验证代码，BE-002 应根据其验证结论实现正式 `electron/main/text-translation/input/encoding-detector.ts`，不能直接把测试目录当生产模块引用。
- 手动覆盖所需最小结果字段已验证为：
  - 自动决定状态。
  - 规范化编码名。
  - 是否存在 BOM。
  - 决策来源。
  - 综合置信度。
  - 候选编码及探测/质量得分。
  - 拒绝原因。
  - 支持的手动覆盖编码列表。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/encoding/encodingProbe.test.ts
pnpm exec tsc --noEmit
git diff --check
ELECTRON_RUN_AS_NODE=1 pnpm exec electron -e "<TextDecoder capability probe>"
```

结果：

- 编码 probe 测试通过：16 tests passed。
- TypeScript 类型检查通过。
- `git diff --check` 通过。
- Electron 运行时确认：
  - Node `v20.18.3`
  - ICU `74.2`
  - 所有目标编码标签均可创建 `TextDecoder`
  - Windows-1252 C1 标点映射不符合预期，因此采用 `iconv-lite`
- 没有启动前端服务。

## 未完成事项

- 正式编码检测模块由 `BE-002` 实现。
- 更大规模真实文本语料和截断采样策略由 `BE-002` / `QA-001` 扩展。
- 罕见无 BOM、纯 CJK UTF-16 文本缺少可靠字节结构证据时仍应低置信度拒绝，而不是强猜。

## 下一步建议

- 优先认领 `PRE-002：Markdown AST 与双语输出验证`。
- `PRE-003：模型响应协议与 Fake Server 验证` 可与 PRE-002 并行推进。
