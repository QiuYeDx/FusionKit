# 外部 Agent 接入：主进程桥接 需求

需求行为只在这里定义；业务目标见 ../../brd.md。不要在 tasks/record 另写一套期望。

## 目标与范围

主进程负责：外部接入设置的持久化、只监听本机的 MCP Streamable HTTP 端点与鉴权、MCP 会话与工具目录、把工具调用转发给渲染进程并回传结果；I3 起还负责端点发现文件与 stdio 桥。

## 范围外

工具的具体行为（module-tools）；设置界面（module-settings）；远程访问、OAuth、多用户。

## 需求

### R-BRIDGE-01 外部接入设置

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

设置保存在 `<userData>/external-agent/settings.json`，由主进程独占读写：是否开启（默认关闭）、端口（默认 47361，1024–65535）、令牌（32 字节随机数的 base64url，首次需要时生成）、信任档位（`read_only` / `confirm_writes` / `auto`，默认 `confirm_writes`）。渲染进程只能通过受限 IPC 读取/修改设置与读取运行状态，来源必须是应用自己窗口的主框架。

#### 验收标准

- AC-BRIDGE-01-1: 在全新的用户数据目录下启动应用，读取设置，得到 enabled=false、port=47361、trust=confirm_writes，且不监听任何端口。
- AC-BRIDGE-01-2: 在设置文件损坏或字段非法时启动，读取设置，回落为默认值且应用正常启动；合法字段被保留。
- AC-BRIDGE-01-3: 在应用窗口中开启接入、修改端口或档位，重启应用后读取设置，修改仍在；首次开启时生成 43 字符的 base64url 令牌并持久化。
- AC-BRIDGE-01-4: 在非应用窗口主框架（如子框架或无窗口的 webContents）调用设置 IPC，调用被拒绝且设置不变。
- AC-BRIDGE-01-5: 在接入运行中重置令牌，旧令牌的请求随即得到 401，现有会话全部关闭；新令牌可以重新连接。

#### 边界与异常

端口非法、档位非法的修改被拒绝并返回错误码，不部分写入。写入采用临时文件后替换；写盘失败返回错误、内存中设置不变。

### R-BRIDGE-02 本机 HTTP 端点与鉴权

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

开启后在 `127.0.0.1:<port>` 监听，只服务 `/mcp`。每个请求依次检查：Host、Origin、令牌、大小。关闭或应用退出时停止监听。

#### 验收标准

- AC-BRIDGE-02-1: 在接入开启时，用带正确 `Authorization: Bearer <令牌>` 的 MCP 初始化请求访问 `http://127.0.0.1:<port>/mcp`，得到成功的 initialize 结果与会话 ID。
- AC-BRIDGE-02-2: 在接入开启时，缺少令牌或令牌错误的请求得到 401 和 `WWW-Authenticate: Bearer`，不创建会话。
- AC-BRIDGE-02-3: 在接入开启时，带任何 `Origin` 请求头的请求，或 Host 不是 `127.0.0.1:<port>` / `localhost:<port>` 的请求，得到 403。
- AC-BRIDGE-02-4: 在接入开启时，访问 `/mcp` 以外的路径得到 404；请求体超过 4 MiB 得到 413。
- AC-BRIDGE-02-5: 在接入运行中关闭开关，端口随即不再接受连接；再次开启后恢复。
- AC-BRIDGE-02-6: 在端口已被其他程序占用时开启，运行状态为 error 且错误码为 `port_in_use`，应用其余功能正常。

#### 边界与异常

端点只绑定 IPv4 回环，不绑定 0.0.0.0。令牌比较使用定长时间比较。端口冲突不自动换端口（客户端配置写死了地址），由用户改端口。

### R-BRIDGE-03 MCP 会话与工具目录

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

每个 MCP 会话独立；初始化时记录客户端名称与版本。服务端信息名为 `fusionkit`、版本为应用版本，并附带使用说明（instructions）。工具目录来自共享目录模块，含名称、标题、说明、输入 JSON Schema 与只读/破坏性标注。

#### 验收标准

- AC-BRIDGE-03-1: 在完成初始化的会话中，读取服务端信息与说明，得到名称 fusionkit、应用版本和非空说明。
- AC-BRIDGE-03-2: 在会话中列出工具，得到与共享目录一致的工具集合，每个工具都有输入 JSON Schema 和 readOnlyHint/destructiveHint 标注。
- AC-BRIDGE-03-3: 在会话中以不符合输入 schema 的参数调用工具，得到 isError 结果，错误码 `invalid_arguments` 且列出问题，请求不转发到渲染进程；调用不存在的工具得到协议错误。
- AC-BRIDGE-03-4: 在已有 8 个活动会话时再初始化，被拒绝；客户端发出 DELETE 或会话闲置超过 2 小时后，该会话被移除，用旧会话 ID 的请求得到 404。
- AC-BRIDGE-03-5: 在会话建立和关闭时，渲染进程收到的运行状态中会话列表相应增减，包含客户端名称。

#### 边界与异常

所有响应使用 JSON（不使用 SSE 流）。工具结果统一为一段 JSON 文本；失败时 isError=true，文本为 `{ "error": 错误码, ... }`。

### R-BRIDGE-04 工具调用转发到渲染进程

| 字段 | 值 |
| --- | --- |
| 来源 | BR-01 |
| 状态 | active |
| 批次 | I1 |
| 优先级 | P0 |

#### 说明

主进程把通过校验的调用（调用 ID、会话 ID、客户端信息、工具名、参数）发给应用主窗口的渲染进程，等待其回传结果。只接受该窗口主框架的回传。

#### 验收标准

- AC-BRIDGE-04-1: 在主窗口已就绪时调用读取工具，得到渲染进程回传的真实数据。
- AC-BRIDGE-04-2: 在渲染进程尚未声明就绪时调用，等待至多 15 秒；仍未就绪则得到 `fusionkit_window_unavailable`；窗口在调用途中重载或销毁时，进行中的调用得到同一错误。
- AC-BRIDGE-04-3: 在调用进行中客户端取消请求（取消通知或断开连接），渲染进程收到该调用的取消，工具的中止信号被触发。
- AC-BRIDGE-04-4: 在渲染进程超过 150 秒未回传时，调用得到 `tool_timeout`。
- AC-BRIDGE-04-5: 在非主窗口主框架回传结果，或回传未知调用 ID 时，回传被忽略，不影响进行中的调用。

#### 边界与异常

回传结果超过 4 MiB 序列化长度时改为 `result_too_large` 错误。

### R-BRIDGE-05 端点发现文件

| 字段 | 值 |
| --- | --- |
| 来源 | BR-03 |
| 状态 | active |
| 批次 | I3 |
| 优先级 | P1 |

#### 说明

监听成功后写 `<userData>/external-agent/endpoint.json`（`{ version: 1, url, token, pid, appVersion }`，仅当前用户可读写），停止监听或应用退出时删除，供 stdio 桥发现端点。

#### 验收标准

- AC-BRIDGE-05-1: 在接入开启且监听成功时，端点文件存在，其中 url 与令牌与当前设置一致；重置令牌或改端口后文件随之更新。
- AC-BRIDGE-05-2: 在关闭接入、端口冲突或应用退出后，端点文件不存在。

#### 边界与异常

写文件失败不影响 HTTP 端点本身（stdio 桥会报告找不到端点）。

### R-BRIDGE-06 stdio 桥与自动启动

| 字段 | 值 |
| --- | --- |
| 来源 | BR-03 |
| 状态 | active |
| 批次 | I3 |
| 优先级 | P1 |

#### 说明

随应用提供 `fusionkit-mcp-stdio.cjs`，由 FusionKit 可执行文件以 `ELECTRON_RUN_AS_NODE=1` 运行（无需单独安装 Node）：从 stdin 逐行读取 MCP JSON-RPC 消息，读取端点文件后转发到 HTTP 端点，把响应逐行写到 stdout。传入 `--launch <可执行文件>` 时，若找不到端点或连接被拒，先启动 FusionKit 并等待端点出现（最多 60 秒）。FusionKit 重启导致会话失效时，桥自动重新初始化并重试该请求。

#### 验收标准

- AC-BRIDGE-06-1: 在 FusionKit 运行且接入开启时，用 SDK 的 stdio 客户端启动桥，能完成握手、列出工具并调用读取工具。
- AC-BRIDGE-06-2: 在 FusionKit 未运行、传入 `--launch` 时，桥启动 FusionKit（不继承 `ELECTRON_RUN_AS_NODE`），端点出现后完成同一次握手。
- AC-BRIDGE-06-3: 在找不到端点且无法启动（或 60 秒内未出现端点）时，客户端的请求得到 JSON-RPC 错误，消息说明需要打开 FusionKit 并开启外部 Agent 接入；桥不崩溃。
- AC-BRIDGE-06-4: 在会话建立后 FusionKit 重启时，下一次请求由桥重新初始化后成功返回。

#### 边界与异常

桥不打印任何非协议内容到 stdout（诊断写 stderr）；收到的通知（无 id）转发后不回写。

## 约束

- 只用 Node 内置 `http` 与 MCP 官方 SDK（`@modelcontextprotocol/sdk@1.30.1`，开发依赖，由 Vite 打包进主进程，不增加运行时 node_modules）。
- 修改 `electron/main/index.ts`、`electron/preload/index.ts`、`electron/main/app-shutdown.ts`、`electron/main/subtitle-studio/index.ts` 后，按项目惯例重新登记两个溯源审计 JSON 的 blob。
- 新 IPC 前缀 `external-agent:` 必须加入 preload 旧通道桥的拒绝列表。
- 自动化测试只使用临时用户数据目录，不在真实 userData 上运行；Electron 测试保持安静窗口模式。
