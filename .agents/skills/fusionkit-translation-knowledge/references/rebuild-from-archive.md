# 从归档重建资料

FusionKit 升级到新版翻译资料后，如果检测到旧版本的资料库，会把旧文件原样移到资料目录下的 `archive/<时间戳>/` 文件夹，然后以空资料库开始。旧文件不会被读取或转换。本节说明如何把这些旧资料整理成新的 `.fktk.json`。

## 找到旧文件

资料目录位于应用数据目录下的 `translation-knowledge/archive/`。每个时间戳文件夹里有：
- `current.json`：指向当时的最新一代；
- 若干 `generation-<n>-<uuid>.json`：数字最大的那份就是最后的资料。

只需要读取最新那一份代文件，其中 `data` 字段是一份旧格式（FK-TK/1，`schemaVersion: 1`）的资料包；`approvals` 记录哪些条目当时已采纳。

## 旧字段怎样对应到新格式

| 旧内容 | 整理方式 |
| --- | --- |
| `collections` | 一个资料集对应一个新资料集。`defaultLanguagePair` 改写为必填的 `languagePair`；如果其条目跨越多个方向，按方向拆成多个资料集 |
| `term` | `sense` 改名为 `note`；别名、匹配方式、强度照搬 |
| `context` | `core` 改为 `required`；`assertion` 为 uncertain / reported 时，在正文前写明「（未证实）」或「（据称）」 |
| `rule` | `strength: 'required'` 改为 `required: true`；`dimension` 丢弃 |
| `expression` / `memory` | 旧版不参与翻译。确有价值时改写为背景说明，默认 `enabled: false` |
| `state` 与 `approvals` | 只有 `state: 'ready'` 且在 `approvals` 中的条目设为 `enabled: true`，其余设为 `false`，由用户再确认 |
| `subjects`、`scope.requiredSubjects`、`condition` | 新版没有对象。对象的名称、别名、描述有价值时，写成该资料集的一条背景说明；条目的对象或条件限制写进正文，例如「（仅当主播 A 说话时）」 |
| `recipes` | 改写为同 ID 的 `presets`：`readCollectionIds` → `collectionIds`，保留 `instructions`、`context` |
| `styles` | 丢弃；它引用的要求本来就在资料集里 |
| `preferenceTemplates` | 可改写为没有资料集的预设（只有 `instructions`） |
| `sources`、`evidence`、`derivedFrom` | 每条只保留一个可选的 `origin`：用户约定 → `manual`，网页 → `web`（保留 url、标题、访问时间），AI 建议 → `agent` |

## 交付

- 生成新的 `package.id`。
- 资料集和条目尽量沿用旧 ID，便于对照。
- 用校验器检查通过后，交给用户在「翻译资料 → 导入资料」中预览并导入。
- 报告中列出：拆分出的资料集，以及停用的条目数量和原因。
- 不要修改或删除归档文件夹中的原始文件。
