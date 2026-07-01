# 工作包 PRE-002：Markdown AST 与双语输出验证

## 基本信息

- 日期：2026-06-23
- 状态：已完成
- 对应执行计划工作包：`PRE-002`

## 本次实现内容

- 调研并比较 Unified/mdast、`mdast-util-from-markdown`、Markdown-it 和 Marked 的源码位置与扩展能力。
- 选择与当前应用渲染器同生态的显式依赖：
  - `unified@11.0.5`
  - `remark-parse@11.0.0`
  - `remark-gfm@4.0.1`
  - `remark-frontmatter@5.0.0`
  - `@types/mdast@4.0.4`
- 建立复杂 Markdown fixtures，覆盖：
  - YAML/TOML frontmatter
  - 标题与普通段落
  - strong / emphasis / delete
  - 行内代码和代码块
  - 普通链接、autolink、图片 alt
  - 嵌套列表
  - 引用与嵌套引用
  - GFM 表格及对齐
  - Raw HTML
  - thematic break
  - emoji
- 验证所有主要块节点具备稳定字符 offset，并可直接用原始字符串 `slice()` 取回源码。
- 建立从后向前的 source-span replacement probe，证明无需 AST 全量序列化即可替换自然语言文本，同时保护代码、URL、HTML、frontmatter 和图片地址。
- 验证图片 alt 需要在 image 节点源码范围内单独定位；mdast 不提供 alt 子节点。
- 建立静态双语输出 fixture，并验证：
  - 标题/段落后跟同级译文引用。
  - 原列表后跟“引用中的译文列表”。
  - 原引用后跟更深一层的译文引用。
  - 原表格后跟“引用中的译文表格”。
  - 保护块不生成空译文。
- 使用应用同款 `ReactMarkdown + remark-gfm` 引擎，并附加 frontmatter 插件进行服务端静态渲染验证。

## 依赖评审结论

### 采用 Unified/mdast

- 与项目已有 `react-markdown@10.1.0`、`remark-gfm@4.0.1` 使用同一解析生态。
- mdast 节点提供 1-based line/column 和 0-based character offset。
- GFM、frontmatter 等能力通过小型插件组合，不需要自建 Markdown parser。
- 解析树只用于识别结构和位置，不使用 stringify 回写原文件。
- 依赖均为 ESM 和 MIT License，符合当前 `"type": "module"` 项目。
- 官方文档：
  - `https://github.com/unifiedjs/unified`
  - `https://github.com/remarkjs/remark/tree/main/packages/remark-parse`
  - `https://github.com/remarkjs/remark-gfm`
  - `https://github.com/remarkjs/remark-frontmatter`
  - `https://github.com/syntax-tree/mdast`

### 不采用 Markdown-it 作为主解析器

- Markdown-it 的 token `map` 主要提供行范围，不直接提供所有内联自然语言 span 的稳定字符 offset。
- 项目实际渲染器不是 Markdown-it，双语结构可能存在解析差异。

### 不采用 Marked 作为主解析器

- token `raw` 适合快速转换，但类型化 AST、插件组合和精细 source-span 替换不如 mdast 直接。
- 与现有 ReactMarkdown 渲染管线不一致，会增加“双解析器行为差异”风险。

### 不直接使用 `mdast-util-from-markdown` 作为顶层入口

- 该底层方案同样可提供 mdast，但需要手动组合 syntax/mdast extensions。
- Unified + remark plugins 对项目更易维护，也更接近现有渲染配置。

## 最终结构契约

### 仅译文

- 基于 text node offsets 从后向前替换。
- link label 和 table cell 的 text node 可直接定位。
- autolink URL 不翻译。
- image alt 使用 image 节点范围内的受控扫描器定位。
- inline code、code block、URL、HTML、frontmatter 等保护节点不进入翻译 span。
- 不使用 `remark-stringify` 或其它 AST 全量序列化方式。

### 双语对照

- 标题/段落：后置一个 blockquote。
- 列表：整个列表后置一个包含译文列表的 blockquote。
- 原引用：译文引用深度增加一层。
- 表格：完整原表格后置一个包含同结构译文表格的 blockquote。
- 无法安全形成完整结构时保留原块并 warning。

## 修改文件

- `package.json`
- `pnpm-lock.yaml`
- `test/text-translation/markdown/markdownAstProbe.ts`
- `test/text-translation/markdown/markdownAstProbe.test.ts`
- `test/text-translation/markdown/fixtures/complex-source.md`
- `test/text-translation/markdown/fixtures/complex-bilingual-expected.md`
- `docs/v0.2.10/text-translator/long_text_translator_final_design.md`
- `docs/v0.2.10/text-translator/long_text_translator_execution_plan.md`
- `docs/v0.2.10/text-translator/long_text_translator_implementation_records/2026-06-23_PRE-002_markdown-ast-bilingual-validation.md`

## 接口或数据结构变化

- 新增生产依赖：
  - `unified: 11.0.5`
  - `remark-parse: 11.0.0`
  - `remark-frontmatter: 5.0.0`
- 继续复用已有：
  - `remark-gfm: ^4.0.1`
- 新增开发依赖：
  - `@types/mdast: 4.0.4`
- 本工作包没有新增正式产品 API。
- `markdownAstProbe.ts` 是 PRE 验证代码，MD-001/MD-002/MD-003 应根据结论实现正式 parser/assembler，不能让生产代码从测试目录导入。

## 验证结果

执行命令：

```text
pnpm exec vitest run test/text-translation/markdown/markdownAstProbe.test.ts
pnpm exec vitest run test/text-translation
pnpm exec tsc --noEmit
pnpm build
git diff --check
```

结果：

- Markdown probe：7 tests passed。
- 覆盖 source offsets、YAML/TOML、保护范围、反向替换、双语 fixture、AST 结构和 ReactMarkdown 静态渲染。
- `test/text-translation` 全量验证：23 tests passed（编码 16 + Markdown 7）。
- TypeScript 类型检查通过。
- 完整 Electron 构建与 macOS arm64 打包通过；仅保留现有的动态/静态导入混用、产物 chunk 偏大、缺少 package description 和本机无有效签名身份等非阻断警告。
- `git diff --check` 通过。
- 没有启动前端服务。

## 未完成事项

- 正式 Markdown parser 和 placeholder 模块由 MD-001 实现。
- 正式仅译文 assembler 由 MD-002 实现。
- 正式双语 assembler 由 MD-003 实现。
- 大型 Markdown 的内存上限由 PRE-004 / QA-002 验证。
- 数学公式需要未来按实际插件选择决定；未识别时应作为保守保护文本处理。

## 下一步建议

- 优先认领 `PRE-003：模型响应协议与 Fake Server 验证`。
- 随后完成 `PRE-004：小说级资源与工作区策略验证`，关闭 M0 技术方案冻结。
