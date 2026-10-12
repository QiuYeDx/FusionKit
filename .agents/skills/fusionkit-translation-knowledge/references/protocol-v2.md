# FK-TK/2 文件协议

Skill 版本 3.0.0；只支持 `schemaVersion: 2`；CLI 需要 Node.js 18+。翻译时哪些内容会被用到，见 [应用中的使用方式](application-usage.md)。

文件为 UTF-8（导出无 BOM）、单个严格 JSON 对象，扩展名 `.fktk.json`。不允许注释、重复键、NaN、尾随逗号或代码围栏。所有核心对象都拒绝未知字段。`extensions` 只能保存反向域名命名空间下的非执行性 JSON 元数据，不能用来扩展翻译行为；导入时原样保留。

同目录的 `knowledge-v2.schema.json` 是 Draft 2020-12 Schema。随 Skill 的 `scripts/validate.mjs` 还会额外检查引用、语言标签、预设方向和术语冲突。文件内引用必须完整，不能依赖接收方已有的资料补齐。

资源限额：
- 文件 32 MiB；
- 全部实体（含 package）20,000 个；
- 单个字符串或键 32 KiB UTF-8；
- 嵌套深度最多 32；
- 每个 `extensions` 64 KiB。

诊断最多各输出前 100 个错误／警告，`stats.errorCount` / `warningCount` 是未截断的总数。

实体 ID 是小写 UUID v4，在同一个包内跨类型全局唯一；首次 revision 为 1，实际修改时保留 ID 并递增。不得输出绝对路径、凭据、API key、私有任务或字幕绑定信息。

其他 `schemaVersion` 的文件一律报 `UNSUPPORTED_SCHEMA_VERSION`，不做转换。旧版资料的整理方法见 [从归档重建](rebuild-from-archive.md)。

## 字段契约

以下 TypeScript 只用来表达结构和必填字段，**不是运行时校验实现**。标 `?` 的字段可以省略，其余必填；空列表写 `[]`；核心字段不使用 `null`。

```ts
type UUID = string;        // 小写 UUID v4
type Revision = number;    // 正的安全整数
type UTCDateTime = string; // RFC 3339 UTC，以 Z 结尾
type LanguageTag = string; // 规范化 BCP 47；中文必须写 zh-Hans / zh-Hant；禁止 auto/und/mul
type Extensions = Record<string, JsonValue>; // 键为反向域名式命名空间

interface KnowledgePackage {
  format: 'fusionkit.translation-knowledge';
  schemaVersion: 2;
  package: {
    id: UUID; revision: Revision; extensions?: Extensions;
    name: string;            // 非空
    description: string;
    createdAt: UTCDateTime;
    generator: { name: string; version?: string };
    author?: string;
    sharingNote?: string;
  };
  collections: Collection[];
  entries: Entry[];
  presets: Preset[];
  extensions?: Extensions;
}

interface Collection {
  id: UUID; revision: Revision; extensions?: Extensions;
  name: string;              // 作品 / 主播 / 系列名，非空
  description: string;
  languagePair: { source: LanguageTag; target: LanguageTag };
  archived: boolean;         // 归档的资料集不出现在工作台选择列表中
}

interface EntryBase {
  id: UUID; revision: Revision; extensions?: Extensions;
  collectionId: UUID;        // 必须指向包内资料集；方向取资料集的方向
  enabled: boolean;          // 停用的条目保留但不参与翻译
  origin?: {
    kind: 'manual' | 'revision' | 'agent' | 'web' | 'import';
    note?: string;           // 简短依据：用户原话、字幕行、网页摘要
    url?: string;            // web：实际读过的 http(s) 页面，不含凭据
    title?: string;
    at?: UTCDateTime;        // web：读取时间
  };
}
type Entry =
  | EntryBase & { kind: 'term'; payload: {
      source: string;        // 原词，非空
      target: string;        // 译法；keep_source 时必须与 source 完全相同
      aliases: string[];     // 其他写法，不得与 source 相同、不得重复
      note: string;          // 词义说明，给 AI 看
      strength: 'required' | 'preferred' | 'keep_source';
      match: { mode: 'whole_term' | 'literal_phrase'; caseSensitive: boolean };
    } }
  | EntryBase & { kind: 'context'; payload: { text: string; required: boolean } }  // 背景
  | EntryBase & { kind: 'rule';    payload: { text: string; required: boolean } }; // 要求

interface Preset {
  id: UUID; revision: Revision; extensions?: Extensions;
  name: string;
  languagePair: { source: LanguageTag; target: LanguageTag };
  collectionIds: UUID[];     // 必须是包内同方向的资料集，可为空
  instructions: string;      // 本次翻译要求
  context: string;           // 内容说明
}
```

## 语义规则（校验器检查）

| 错误码 | 含义 |
| --- | --- |
| `MISSING_REFERENCE` / `REFERENCE_TYPE` | 条目或预设引用的资料集不存在，或 ID 指向别的类型 |
| `PRESET_LANGUAGE_MISMATCH` | 预设方向与其资料集方向不同 |
| `LANGUAGE_TAG` | 语言标签不规范，或中文未写明文字 |
| `KEEP_SOURCE_TARGET` / `ALIAS_IS_SOURCE` | 保留原文的术语译法与原词不同；别名与原词相同 |
| `ORIGIN_URL` | 来源网址不是不含凭据的 http(s) 地址 |
| `DUPLICATE_ID` / `DUPLICATE_VALUE` | ID 重复；列表内值重复 |

| 警告码 | 含义 |
| --- | --- |
| `DUPLICATE_TERM` | 同一资料集里有相同原词（不分大小写，规范化后比较） |
| `TERM_DISAGREEMENT` | 不同资料集对同一原词给出不同译法；提醒用户不要同时勾选 |

## 摘要

`node scripts/validate.mjs file.fktk.json --digest <UUID> --json` 输出实体的 `id`、`revision` 与 RFC 8785 JCS + SHA-256 `digest`，可用来核对两份文件中的同一实体是否完全一致。
