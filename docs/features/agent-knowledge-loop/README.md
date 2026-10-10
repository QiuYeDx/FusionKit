# Agent 与翻译资料闭环

2026-10-10，基线 `45a88e0`（分支 v0.4.0），保留工作区原有 `artifacts/`。

起因是用户测试时，Agent 在修订「泰姆菲尔德家的大小姐」后无法把译法记入《绝区零》资料：它只能检索，还搜不到。用户希望：

1. Agent 与翻译资料模块真正打通：在对话中按用户想法检索、新建、修改资料，必要时联网查证；
2. AI 修订后能聪明地判断有没有值得沉淀的译法，并询问是否记入资料，让资料越用越丰富、越贴合用户习惯；
3. 一键检查一个或多个文档里写法不统一的术语/名称，确认后统一修订。

## 交付入口

- [I1 集成结果](records/i1/integration.md)：Agent 检索、整理并在确认后保存翻译资料；证据与截图在 `records/i1/`。
- [I2 / I3 集成结果](records/i3/integration.md)：AI 修订参考资料并在应用后询问记入；术语一致性检查、统一与撤销；证据在 `records/i2/`、`records/i3/`。
- [I4 集成结果](records/i4/integration.md)：免密钥联网查证（维基百科、萌娘百科镜像、百度百科、B 站游戏 Wiki、必应），设置 → Agent 开关，带网页来源的资料；证据在 `records/i4/`。

## 文档

- [业务范围与路线图](brd.md)：问题分析、目标、跨批次原则、BR-01..04 与 I1..I4。
- [总体设计](architecture.md)：现状盘点、「提案 → 核对 → 原子保存」核心链路、依据与可信度、写入边界，以及 I1 详细方案和 I2..I4 规划。
- 当前批次 I1 的可验收需求、设计与任务：
  - [module-knowledge](modules/module-knowledge/requirements.md)：原子批量保存、提案构造与预检、资料页上下文。
  - [module-agent](modules/module-agent/requirements.md)：检索与目录、准备资料变更、变更卡片、Agent 指引；修订应用回报（I2）、Agent 发起一致性检查（I3）。
  - [module-studio](modules/module-studio/requirements.md)：修订参考资料与可沉淀译法、应用后询问（I2）；术语一致性检查、统一与撤销（I3）。
  - [module-web](modules/module-web/requirements.md)：联网检索与读取、安全与隐私边界、联网设置（I4）；Agent 联网工具见 module-agent R-AGENT-07。
- `spec.json`：批次、批准与决策（Q-02 跨文档撤销按可逆默认处理；Q-01 联网来源已由用户确认：不接需密钥的通用搜索，维基百科优先，二次元优先萌娘百科、百度百科，可选 B 站游戏 Wiki、搜索引擎与官网）。

## 批次

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| I1 | Agent 检索与维护翻译资料 | 已实现，待用户验收 |
| I2 | 修订后沉淀译法、修订参考资料 | 已实现，待用户验收 |
| I3 | 术语一致性检查 | 已实现，待用户验收 |
| I4 | 联网查证 | 已实现，待用户验收 |

## 恢复工作

读 spec.json 的 `current_increment` 与批准，再读对应模块的 requirements → design → tasks；证据放在 `records/`。规格检查：

```bash
python <spec-driven-ai-coding>/scripts/check_spec.py docs/features/agent-knowledge-loop --stage ready
```
