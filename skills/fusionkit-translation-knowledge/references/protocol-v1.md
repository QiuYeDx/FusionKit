# FK-TK/1 文件协议

Skill 版本 1.0.0；支持 schemaVersion 1；CLI 最低 Node.js 18。

文件为 UTF-8（导出无 BOM）、单个严格 JSON 对象，扩展名 `.fktk.json`。不要注释、重复键、NaN、尾随逗号或代码围栏。全部核心对象拒绝未知字段；`extensions` 仅保存反向域名命名空间下的非执行性 JSON 元数据，不用于扩展翻译行为、文件访问或本机授权。未知扩展原样保留。

同目录 `knowledge-v1.schema.json` 是 Draft 2020-12 Schema；随 Skill 的 `scripts/validate.mjs` 同时执行引用、语言、范围、摘要和冲突校验。文件内引用必须完整、类型正确，不能依赖接收应用现有资料补齐。导入后仍需用户在本机审核采纳，状态 `ready` 不构成信任。

资源限额：文件 32 MiB，全部实体（含 package）20,000，单个字符串或键 32 KiB UTF-8，根深度为 0、最大深度 32，每个 `extensions` 64 KiB。诊断最多分别输出前 100 个错误/警告，`stats.errorCount`/`warningCount` 是未截断总数。

实体 ID 为小写 UUID v4；首次 revision 为 1，实际修改保留 ID 并递增 revision，重新打包或排序不提升实体 revision。同包跨类型全局唯一。绝对路径、凭据、API key、私有任务或 cue 绑定不得输出。

新增会改变翻译行为的字段/枚举必须升级协议版本，不能放入 extensions 让旧应用执行；遇到更高版本文件，使用支持版本的工具，不能删除未知字段强行降级。

## 生成与核对派生摘要

`derivedFrom` 可省略父条目正文，但必须随包提供 `evidenceSourceId` 的充分脱敏证据。不能自引用或有可见父链循环。若包含同修订父条目，摘要必须匹配。若包含的是另一修订，工具提示证据变化。

不手算摘要或用任意排序 JSON 代替 JCS。在包含父条目的合法包上执行：

```sh
node scripts/validate.mjs parent.fktk.json --digest <父条目UUID> --json
```

结果为父条目的 `id`、`revision`、RFC 8785 JCS + SHA-256 `digest`。每个摘要含实体的 ID、revision、extensions；空白和字段排序不影响它。来源 `contentDigest` 则是所描述原始字节的 SHA-256，两者不能混用。

## 离线检查的边界

术语潜在冲突返回 `TERM_TRANSLATION_CONFLICT` 警告，允许不同资料集保留官方与个人译名，不擅自合并或设优先级。只有实际任务同时选用且范围/原文命中时才能决定冲突。参考译文的人工确认、来源事实和权限不能通过 JSON 自动证明。

## 附录 A：FK-TK/1 字段契约

以下 TypeScript 用于表达判别联合与必填字段，**不是运行时校验实现**。同版本正式 JSON Schema 要覆盖类型与基础限制；引用、语种匹配、状态、条件及冲突由语义校验器补充。所有标 `?` 的字段可省略，其余必填；空列表用 `[]`，无值省略可选字段，核心字段不使用 `null`；非执行性 extensions 可保存合法 JSON null。

### A.1 包、对象、资料集与来源

```ts
type UUID = string;       // 小写 UUID v4，文件内全局唯一
type Revision = number;   // 正的安全整数
type UTCDateTime = string;// 有效 RFC 3339 UTC，导出统一使用 Z
type LanguageTag = string;// 规范化 BCP 47；禁止 auto/und/mul 和通配符
type SHA256 = string;     // 64 位小写十六进制
type JsonValue = string | number | boolean | null | JsonValue[]
  | { [key: string]: JsonValue };
type Extensions = Record<string, JsonValue>; // 键为反向域名式命名空间

interface RecordBase {
  id: UUID;
  revision: Revision;
  extensions?: Extensions;
}
interface CatalogBase extends RecordBase {
  archived: boolean;      // 默认创建为 false；备份/导入须保留
}
interface LanguagePair {
  source: LanguageTag;
  target: LanguageTag;
}
interface KnowledgePackage {
  format: 'fusionkit.translation-knowledge';
  schemaVersion: 1;
  package: RecordBase & {
    name: string;
    description: string;
    purpose: 'share' | 'backup';
    createdAt: UTCDateTime;
    generator: { name: string; version?: string };
    author?: string;       // 声明，非经过验证的签名
    sharingNote?: string;  // 共享/来源权利说明，不是授权证明
  };
  subjects: Subject[];
  collections: Collection[];
  sources: Source[];
  entries: Entry[];
  styles: Style[];
  recipes: Recipe[];
  preferenceTemplates: PreferenceTemplate[];
  extensions?: Extensions;
}
interface Subject extends CatalogBase {
  kind: 'person' | 'work' | 'domain' | 'other';
  name: string;
  aliases: string[];
  tags: string[];
  description: string;
}
interface Collection extends CatalogBase {
  name: string;
  description: string;
  aboutSubjectIds: UUID[];
  defaultLanguagePair?: LanguagePair; // 仅新建表单默认，不重解释现有条目
}
interface Source extends RecordBase {
  kind: 'user_note' | 'web' | 'document' | 'reviewed_subtitle' | 'ai_proposal';
  title: string;
  excerpt: string;         // 必要证据摘录/用户原要求，不是整篇抓取正文
  url?: string;            // 只允许无凭据的 http/https，不自动访问
  accessedAt?: UTCDateTime;
  attribution?: string;    // 作者、出处/版本等声明
  contentDigest?: SHA256;  // 所引用原始文件/片段 UTF-8 字节摘要，须注明对象
  digestDescription?: string;
}
```

`web` 来源必须有 url/accessedAt，必须实际读过所声称核对的页面；协议只能检查格式，真实性由审核判断。`reviewed_subtitle` 必须在 excerpt/attribution 说明原译片段、确认来源和对齐情况；它依旧只是外部声明。`contentDigest` 与 `digestDescription` 成对出现，不将来源文件字节摘要和实体 JCS 摘要混为一谈。

所有数组的集合性 ID/别名/标签不重复；展示顺序保留，但不等于冲突优先级。名称/原词/译法/规则文本不能为空白；`description` 可为空。语言标签大小写按 BCP 47 规范化，`zh` 在知识语言对中必须进一步明确为 `zh-Hans` 或 `zh-Hant`；显式区域标签如 `zh-Hans-CN` 不自动等于 `zh-Hans`，v1 精确匹配。

### A.2 范围、证据与五种条目

```ts
type SubjectRole = 'present' | 'topic' | 'speaker' | 'mentioned';
type Condition =
  | { mode: 'none' }
  | { mode: 'advisory' | 'requires_confirmation'; text: string };
interface Scope {
  languagePair: LanguagePair;
  requiredSubjects: Array<{ subjectId: UUID; role: SubjectRole }>;
  condition: Condition;
}
interface Evidence {
  sourceId: UUID;
  support: 'direct' | 'inferred';
  note?: string;
}
interface DerivedFrom {
  entryId: UUID;
  revision: Revision;
  digest: SHA256;          // 原父条目完整 JCS 摘要
  evidenceSourceId: UUID; // 必须随包提供的来源；父条目正文可省略
}
type EntryState = 'candidate' | 'ready' | 'needs_review' | 'rejected' | 'archived';
interface EntryBase extends RecordBase {
  title: string;
  collectionId: UUID;
  aboutSubjectIds: UUID[];
  scope: Scope;
  state: EntryState;
  evidence: Evidence[];   // 至少一个来源；手工输入由应用创建 user_note
  derivedFrom: DerivedFrom[];
}
interface Match {
  mode: 'whole_term' | 'literal_phrase';
  caseSensitive: boolean;
}
type RulePayload = {
  dimension: 'register' | 'honorifics' | 'person_reference' | 'fidelity' | 'other';
  text: string;
  strength: 'required' | 'preferred';
};
type Entry = EntryBase & (
  | { kind: 'context'; payload: {
      text: string;
      assertion: 'fact' | 'reported' | 'uncertain';
      core: boolean;
    } }
  | { kind: 'term'; payload: {
      source: string;
      target: string;
      aliases: string[];
      sense: string;
      match: Match;
      strength: 'required' | 'preferred' | 'keep_source';
    } }
  | { kind: 'expression'; payload: {
      sourcePhrase: string; // 字面原表达，不是正则或规则代码
      interpretation: string;
      targetExamples: string[];
      mustNotInventOccurrences: true;
    } }
  | { kind: 'memory'; payload: {
      source: string;
      target: string;
      beforeSource?: string;
      afterSource?: string;
      alignment: 'one_to_one' | 'reviewed_segment';
      directReuseAllowed: false;
    } }
  | { kind: 'rule'; payload: RulePayload }
);
```

关键语义约束：

1. `requiredSubjects=[]` 表示没有主体限制，但仍受资料集选用、语言、本机信任限制；不是应用全局自动生效。
2. `speaker` 条件必须引用 person。表达有明确人物归属时必须有相应 speaker 条件；通用语言表达可无 speaker，但不能仅用 `aboutSubjectIds` 暗含人物专用限制。
3. 可移植 Scope 不含 documentId、cueIds、绝对路径或可执行条件。只适用于某一次文件的资料，在导出前需要转成明确的 `requires_confirmation` 场景条件，并创建可移植副本；否则排除并说明。任务私有绑定不进入知识协议。
4. `keep_source` 的 target 必须等于 source，含义为保留当前命中的原词/别名原样；别名只帮助命中，不替换成主词。`required` 的字面译法冲突和重叠须在实际任务同时启用资料、满足范围并命中原文时处理；离线校验只给潜在冲突警告，不按文件顺序自动覆盖。
5. 强制术语/规则不能仅依赖 `advisory` 场景条件：若额外场景决定强制生效，必须用 `requires_confirmation`；自然语言义项不能被当作已自动证明的条件。
6. `uncertain` 背景不得 `core=true`。模型提取产生的条目初始 candidate；除明确用户指定的建议之外，默认不建议 required/core。任何生命周期声明都不能替代本机采纳。
7. 参考译文必须有来源；`reviewed_segment` 的来源需说明确认过的片段对齐，不能擅自拆成一对一句子。它与 one_to_one 都不自动直贴答案。
8. `derivedFrom` 不能自引用；可见父链不能循环。同包父条目若修订与声明相同，摘要必须一致；若父条目当前为更新修订，保留历史来源摘录并提示证据已变化，不伪称仍是同版本。
9. `extensions` 中不得嵌入需要执行的规则、新语言通配语义或本机授权。导入器只保存和展示，不解释执行。

### A.3 风格、方案与偏好模板

```ts
interface Style extends CatalogBase {
  name: string;
  description: string;
  languagePair: LanguagePair;
  ruleEntryIds: UUID[]; // 至少一条 rule；完整包含其资料集/来源
}
interface Recipe extends CatalogBase {
  name: string;
  description: string;
  languagePair: LanguagePair;
  readCollectionIds: UUID[];
  subjectSuggestions: Array<{
    subjectId: UUID;
    role: 'topic' | 'speaker' | 'mentioned';
  }>;
  baseStyleId?: UUID;
  modifierStyleIds: UUID[];
  instructions: string;
  context: string;
  inheritGlobalPreferences: boolean;
  learningSuggestion: 'off' | 'save_reviewed';
  suggestedDestinationCollectionId?: UUID;
}
interface PreferenceTemplate extends CatalogBase {
  name: string;
  instructions: string;
}
```

风格只组合已定义的 rule，不能夹带任意系统 Prompt。文件允许风格引用 candidate 等尚不可用的规则，但导入预览显示该风格暂不可用；所有引用规则 ready 且本机采纳、相关对象/资料集未归档后，才可将此风格用于新任务。不能以「选择了风格」绕过条目审核。

风格引用规则的资料集必须在方案 readCollectionIds 中；UI 选风格时显示依赖并同步选择，不会隐式启用其他资料集。规则条目在所属集被选中时按自身范围生效；若同一资料集包含多套互斥风格，必须拆集，避免选择一种风格时连带激活另一种。

方案所有风格和写入目标引用必须在包内；写入目标不必是读取集。读取集可包含多种语言条目，但方案只用精确匹配语言对的条目；所选风格语言对必须与方案相同。`subjectSuggestions` 的 speaker 只接受人物，且永远不表示对新文件的确认。

`learningSuggestion=save_reviewed` 必须有建议目标；导入后实际学习仍关闭，直到用户本机启用。`off` 不允许带建议目标。方案不含模型密钥、外部路径、实际 cue 绑定或模型供应商配置；在本机选择模型。偏好模板须通过「应用到通用偏好」才能生效，不因导入被覆盖。

内置风格同样版本化进入快照；应用不得用更新后的内置文案重解释旧任务。导出使用内置风格的方案时，必须携带该风格与规则的可移植内容，不能留下外部安装才有的隐式依赖。

