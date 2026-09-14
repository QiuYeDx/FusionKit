---
name: fusionkit-translation-knowledge
description: 为 FusionKit 字幕 AI 翻译制作或更新可导入的 FK-TK/1 知识文件，按用户资料和可访问来源整理术语、背景、表达、参考译文与规则，并用随包工具校验。用于字幕翻译资料准备与知识包维护，不用于执行翻译任务或连接应用私有资料库。
metadata:
  version: 1.0.0
---

# FusionKit 字幕翻译知识

交付 UTF-8 `.fktk.json` 知识包和简短准备报告。支持 FK-TK/1（`schemaVersion: 1`）；不需要启动 FusionKit、应用 token 或云端服务。脚本最低 Node.js 18，依赖已打包，无需安装 npm 包。

## 准备内容

- 从用户指令确定作品/人物/领域、版本/平台、明确语言方向和译名偏好；仅在关键同名歧义妨碍整理时询问。先整理少量稳定姓名、术语和必要背景。
- 阅读 [protocol-v1.md](references/protocol-v1.md) 的字段和语义；[knowledge-v1.schema.json](references/knowledge-v1.schema.json) 是可机读字段约束。用 [minimal.fktk.json](examples/minimal.fktk.json) 理解最小闭环，用 [multi-subject.fktk.json](examples/multi-subject.fktk.json) 查看五类条目、人物范围、风格和方案。示例全部虚构，不能作为真实作品资料引用。
- 需要查证时读 [research-and-evidence.md](references/research-and-evidence.md)。只记录实际访问或用户提供的证据；没有搜索能力就说明未联网核对。不要虚构网页访问、官方译名、字幕确认或审核记录。
- 默认新增条目为 `candidate`。用户指定译法是 `user_note`；未经证实的背景用 `uncertain` 且 `core: false`。没有明确用户要求，不建议 `required` 术语/规则或核心背景。
- 人物专用表达必须要求该人物为 `speaker`，原文未出现时不得凭空添加。只有被提及的人物不应获得说话口吻。自然语言场景不能假装已被机器验证；决定强制生效的场景用 `requires_confirmation`。
- 没有已确认且对齐的字幕材料就不创建 `memory`。角色说法标 `reported`；事实、推断和争议分别记录来源，不能拿模型自信程度代替证据。

## 更新与身份

对用户旧包先校验再更新。保留现有实体 UUID 和未知非执行性 extensions；实际修改才增加实体 revision，新增实体用新的小写 UUID v4。可用 Node `crypto.randomUUID()` 生成。改名、重排或重新打包不重建全部身份；未输出某条不代表删除。

[update.fktk.json](examples/update.fktk.json) 相对完整示例仅修改包 revision 和一条术语的 revision/义项。需要 `derivedFrom` 时用协议说明中的 `--digest` 命令获取父条目 JCS 摘要，并随包带充分脱敏证据。遇到更高协议版本，说明工具版本不支持并使用匹配工具，不删除字段降级。

## 验证与交付

以 Skill 目录为当前目录（也可用脚本的绝对路径）：

```sh
node scripts/validate.mjs /path/to/output.fktk.json --json
```

退出码 `0` 为结构/已知语义合法（可有警告），`1` 为无效文件，`2` 为工具/IO 错误。修复错误后再次校验；对潜在译法冲突保留差异并解释适用范围，不能擅自覆盖用户偏好或宣称全局无冲突。校验器只读、无网络，不导入应用。

报告说明范围/版本/语言、实际来源、候选和强制规则数量、疑点与实际校验结果。协议合法、来源已核对、本机已采纳是三件事；接收者仍需审核采纳。无可用运行时可交付草稿，明确“未运行校验”。输出不得包含本机绝对路径、凭据、任务私有绑定或用户未要求共享的字幕全文。
