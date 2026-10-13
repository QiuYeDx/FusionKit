# 外部 Agent 接入（MCP）业务范围与路线图

业务目标与范围的权威来源；具体 AC 在模块 requirements.md。滚动规划：当前批次展开到任务，后续批次只写目标与验收要点。

## 背景、目标与成功条件

FusionKit 内置的 FusionKit Agent 需要用户自己配置大模型 API（地址 + Key）才能用。多数用户日常用的是 Claude Code、Codex、Cursor 这类外部通用 Agent，它们自带模型与额度。

目标：让外部 Agent 通过标准协议（MCP）连接正在运行的 FusionKit，读取应用状态并执行操作，由外部 Agent 直接完成用户的字幕需求。

关键价值：**外部 Agent 自己就是译者。** FusionKit 提供读取字幕、写入译文、查翻译资料、导入导出等工具，翻译由外部 Agent 的模型完成，用户不必在 FusionKit 中配置任何 API Key。本地转写、导入、导出等不依赖大模型的能力同样开放。

成功条件：

1. 用户在 FusionKit 设置里开启「外部 Agent 接入」，复制一段配置到 Claude Code 或 Codex，外部 Agent 即可连接并看到 FusionKit 工具。
2. 不配置任何 API Key：外部 Agent 能把一份已导入字幕工作台的日文字幕翻译成中文、写回为新译文轨道，并导出双语字幕文件；FusionKit 界面实时可见，用户可审校、撤销。
3. 写入类操作默认需要用户在 FusionKit 中确认（可「本次连接内允许」）；破坏性操作（覆盖已有文件）在任何档位都需确认；只读档拒绝所有写入。
4. 未开启时不监听任何端口；开启后只监听本机回环地址，无正确令牌或来自浏览器网页的请求一律拒绝。

## 范围外

- 不做远程/局域网访问；不做多用户、OAuth；不对外网暴露端口。
- 不把内置 FusionKit Agent 的全部工具与各页面工具原样暴露（工具数量会挤占外部 Agent 上下文，且内置工具的授权模型基于用户亲手输入的消息）。
- 不在本功能内让 FusionKit 原有翻译流水线借用外部客户端模型（MCP sampling，各客户端支持不一）。
- 不改造经典页面（字幕翻译器/格式转换/语言提取/名称翻译）的队列为外部可控；外部 Agent 以字幕工作台为主战场。
- 不提交、推送、发布版本；最终验收由用户完成。

### BR-01 外部 Agent 可安全地连接正在运行的 FusionKit

| 字段 | 值 |
| --- | --- |
| 状态 | active |
| 批次 | I1 |

#### 说明

FusionKit 主进程提供 MCP Streamable HTTP 端点（仅 127.0.0.1），令牌鉴权并防 DNS rebinding；每个 MCP 会话对应一个外部连接。工具调用转发到渲染进程执行，与界面共享同一套数据与 IPC 访问控制。默认关闭。

#### 验收要点

开启后标准 MCP 客户端能完成握手、列出工具、调用读取工具并得到真实数据；未开启、令牌错误、浏览器来源的请求均被拒绝；FusionKit 窗口不可用时工具返回明确错误。

### BR-02 外部 Agent 能不依赖 API Key 完成字幕翻译与常用操作

| 字段 | 值 |
| --- | --- |
| 状态 | active |
| 批次 | I2 |

#### 说明

提供精选工具面：应用状态、工作台文档读取、按路径导入、新建译文轨道、批量写入译文（AI 来源、未审校）、导出、本地转写、翻译资料查询与变更、打开页面。写入按信任档位确认，确认在 FusionKit 内以全局浮层出现，可在本次连接内放行同类操作。

#### 验收要点

外部 Agent 无需 API Key 即可完成「导入→读取→写译文→导出」闭环；确认、拒绝、只读拒绝、破坏性必确认都有可观察结果；写入后工作台界面刷新、可撤销。

### BR-03 用户能方便地接入、观察和管理外部 Agent

| 字段 | 值 |
| --- | --- |
| 状态 | active |
| 批次 | I3 |

#### 说明

设置页提供开关、信任档位、端口与令牌（可重置）、各客户端一键复制配置、Skill 安装；应用内可见当前连接与最近操作并可断开。提供 stdio 桥：FusionKit 未运行时自动启动它再连接。随附一份很薄的 Skill，说明工作流与领域概念。

#### 验收要点

按设置页给出的配置，Claude Code / Codex 可接入；stdio 桥在应用未运行时能拉起应用并连接；断开、重置令牌后旧连接失效。

## 模块与契约索引

| 模块 | 职责 | 契约事实来源 |
| --- | --- | --- |
| module-bridge（BRIDGE） | 主进程：设置持久化、HTTP 端点与鉴权、MCP 会话、主↔渲染转发、端点发现文件、stdio 桥 | `src/agent/external/contract.ts`（通道、设置、调用信封）、`src/agent/external/catalog.ts`（工具目录） |
| module-tools（TOOLS） | 渲染进程：工具宿主、信任与确认、各工具实现；主进程 Studio 新增的轨道/译文写入能力 | `src/agent/external/catalog.ts`、`src/subtitle-studio/ipc-contract.ts`、`src/subtitle-studio/cue-edit-contract.ts` |
| module-settings（SETTINGS） | 设置页、连接指示与活动、客户端配置片段、Skill 与文档 | `src/agent/external/contract.ts` |

## 后续批次

- I2（BR-02）：工具面与确认。依赖 I1 的转发链路；风险在 Studio 新写入能力（新增 IPC 与编辑操作）与确认交互。
- I3（BR-03）：接入体验。依赖 I1/I2；风险在 stdio 桥（`ELECTRON_RUN_AS_NODE`、打包路径）与各客户端配置格式。
- 进入每个批次时细化对应模块需求、设计与任务；已登记的授权覆盖到 I3（见 spec.json）。
