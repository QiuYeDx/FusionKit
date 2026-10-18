# easy-setup 实施任务

设计见 [README.md](README.md)。每批完成后由独立审查复核，结果记录在本文件末尾。

| 批次 | 任务 | 对应验收 |
| --- | --- | --- |
| B1 网络层 | T1.1 新增 `electron/main/network/`：代理解析（无 / 系统 `session.resolveProxy` / 自定义）、HTTPS 隧道 Agent（CONNECT，SOCKS5）、`session.setProxy` 同步、主进程持久化代理设置并在启动时生效 | A6 |
| | T1.2 AI 调用、联网查证、安装包下载改用统一代理层；代理测试改测模型地址、下载源和 GitHub | A6 |
| | T1.3 下载传输：经资源管理器已有的 `downloadResource` 注入接入（原计划在 `resource-download.ts` 加默认传输入口，实施时改用现有注入，冻结引擎未改）；新传输实现多下载源映射、自动选择与换源、同一下载固定源、代理 | A4 |
| | T1.4 设置中的“下载源：自动 / 官方 / 国内镜像优先”；下载错误分类（网络、磁盘、校验） | A4、A3 |
| B2 模型配置 | T2.1 “前往设置”跳到 `?tab=model`；新建配置自动分配空角色；角色说明；OpenAI 预设保留 Responses（Agent 已支持，原计划改 Chat Completions，实施时取消，见 B2 记录）；Key 遮挡；高级设置折叠 | A2、A8 |
| | T2.2 主进程“测试连接”与错误分类；配置对话框加测试按钮；Agent、工作台、经典工具运行时错误复用分类文案 | A3 |
| | T2.3 首次启动欢迎向导（DeepSeek 推荐、获取 Key 与充值链接、测试并保存、外部 Agent 与仅本地路径、转写准备、示例任务） | A2 |
| B3 运行库与转写 | T3.1 `beforePack` 准备并校验 `vc_redist.x64.exe`；`win.extraResources`；NSIS `nsis.include` 安装脚本；打包合同与测试同步 | A5 |
| | T3.2 主进程 VC++ 运行库检测与一键修复；模型下载前、转写页与资源管理中、运行类错误时提示（原计划按 DLL 缺失退出码判断，冻结代码不提供退出码，见 B3 记录） | A5 |
| | T3.3 一键准备（推荐模型 + VAD）、友好名称、NVIDIA 显卡与驱动检测、导入文案、自动回落 CPU 原因 | A4 |
| B4 更新与瘦身 | T4.1 Windows 应用内下载并安装更新、进度、镜像回退；macOS 直达 DMG；更新错误文案；更新日志镜像 | A7 |
| | T4.2 渲染进程专用依赖移出生产依赖，打包后实际启动验证 | — |
| B5 文案与指引 | T5.1 术语改写与“原因 + 下一步”错误文案；去掉面向开发者的恢复建议 | A8、A3 |
| | T5.2 应用内帮助页；错误提示链接到帮助条目；修正旧首页文案 | A1 |
| | T5.3 README（中英）、官网下载区“打不开怎么办”与系统要求；DMG 内说明文件 | A1 |
| | T5.4 更新清单加固：经镜像得到的清单须由 GitHub 或第二个镜像印证才可应用内安装，否则只给手动下载链接 | A7 |

## 记录

### 2026-10-17 B1 网络层（T1.1–T1.4）

**做了什么**

- 新增 `electron/main/network/`：`settings.ts`（设置存于用户数据目录 `network-settings.json`，启动时同步读取，默认“系统代理 + 自动下载源”）、`proxy-resolver.ts`（无 / 系统 `session.resolveProxy` 按源站解析并缓存 10 秒、解析超过 5 秒按直连 / 自定义；回环地址永远直连）、`tunnel.ts` + `agent.ts`（HTTP CONNECT、HTTPS 代理、SOCKS5 无认证、PAC 的 `SOCKS` 按 Chromium 语义走 SOCKS4a；PAC 列表逐个回退；连接超时 20 秒；改设置后连接池换代并关闭空闲连接）、`errors.ts`（DNS / 超时 / 拒绝 / 中断 / 无网络 / 代理失败 / 代理要密码 / TLS / 取消，含 axios 包装、`cause`、AggregateError 与 Chromium `net::ERR_*`）、`download-sources.ts`（镜像表）、`download-transport.ts`、`connectivity.ts`、`runtime.ts`、`index.ts`。同时对默认会话和 electron-updater 自己的 `electron-updater` 分区调用 `setProxy`，渲染进程请求与检查更新也走同一设置（审查后修正，见下）。
- T1.2：AI 适配器与联网查证改用 `getAxiosProxyConfig()`（`proxy: false` + 代理感知 Agent；联网查证的公网地址校验作用于直连，审查后经代理的 http 页面也隧道到核准的地址）；安装包下载走同一 Agent，并补了相对重定向、断流与 60 秒无数据超时（审查后移到 `network/file-download.ts` 并补测试）。删除 `electron/main/proxy.ts` 与 httpbin 测试；新测试 IPC 只收模型服务地址（不传 Key），测模型服务、当前下载源（官方 / ModelScope）与 GitHub，返回每项是否连通、延迟、原因与“直连 / 经过哪个代理”。
- T1.3：模型、语音检测、CUDA 包下载都经新传输：自动模式并发发 `Range: bytes=0-0` 探测（6 秒），按“能续传 + 延迟”排序并按组记住；连接错误、超时、5xx、404 等以及镜像对 Range 请求返回 200（校验值未变）时换下一个源；官方地址原样交给引擎（含重定向，引擎照旧按白名单检查），其重定向目标失败也会换源；镜像的重定向在传输层内跟随（仅 https），交给引擎的是去掉 `location` 的最终响应。同一次下载固定一个源；重启后续传时按 `If-Range` 校验值找回原来的源；换源最多让该文件从零开始，不会卡死（有测试覆盖）。下载完成后按目录里的 SHA-256 核对（审查后改为边下边算，官方源也查），不符就删除并换一个这次没用过的源重下。另外：引擎重试改为 1/3/8/15/30 秒五次；一次尝试失败但部分文件变长时自动再续传（最多 8 轮）；下载 60 秒无数据会断开并续传。
- T1.4：设置“网络”页（原“网络代理”）新增“下载源：自动（推荐）/ 官方源 / 国内镜像优先”和说明；测试结果改为逐项列出并给一句下一步提示；自定义代理不完整时提示会直连。主进程是设置的唯一来源，旧版本存在 localStorage 的代理设置首次启动时迁移过去后删除。字幕工作台“本地资源”里下载失败按原因显示：网络（附“网络设置”按钮）、磁盘空间不足、文件校验失败；导入模型失败另有文案（审查后补充）。四种语言文案同步。

**与方案不同之处**

- 没有改冻结的 `engine/resource-download.ts`：三个资源管理器本来就接受 `downloadResource` 注入，`SpeechResourceService` 原样透传，所以在 `electron/main/index.ts` 组合时传入即可，提取审计不用重新登记。这样传输层还能拿到文件大小，用于探测时核对大小、给镜像文件提前做 SHA-256。README“实现约束”与 T1.3 一行已按此更正。
- 运行时确认：工作台与经典转写的下载都只经共享的 `SpeechResourceService`（引擎目录下的管理器）；`local-subtitle/` 与工作台 `native/` 里的下载代码运行时不再下载（验证用管理器的下载被禁用），所以没有接线。
- 经 HTTP 代理访问 http 目标按浏览器的做法用完整地址转发（审查后修正，原先用 CONNECT，只允许 443 的代理会拒绝）；联网查证的 http 页面例外，见下。自定义代理可写 `socks5://`。
- 行为变化：“系统代理”现在对主进程真正生效（以前主进程启动时是“无”，且只有打开代理设置页才同步）。如果系统设了代理但代理软件没开，主进程请求会像浏览器一样失败（PAC 中的 DIRECT 回退仍有效）。

**验证**

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（无新增警告）。
- 新增单元测试 58 个全部通过（`test/network/*` 7 个文件 + `src/store/useNetworkStore.test.ts`），全部用本机服务器或内存假源：解析与三种模式、CONNECT（含 407/502/代理不通/超时）、SOCKS5（含要密码、连接失败）、SOCKS4a、PAC 回退、直连自定义 lookup、连接池换代、错误分类、镜像映射、自动排序与按组复用、官方重定向目标失败换源、镜像重定向与 https 限制、Range 返回 200、换源不卡死、重启后按校验值续传、镜像 SHA-256 不符换源、弱网多轮续传、全部失败、取消、设置持久化与 IPC、渲染进程迁移与防抖同步。
- 相关已有测试：`test/web-lookup`、`test/ai`、`test/speech-resources`（engine、service、preload、迁移、integration）、`src/store` 等 42 个文件 352 个通过（7 个原本就跳过）；`test/windowChrome`、`overwriteProductionRuntime`、`transcription-controller` 通过。
- `pnpm pretest` 后静默窗口运行 `test/e2e.spec.ts` 的 startup 与设置页分段控件用例通过（网络页现在有两个分段控件，断言随之改为 2）；`FUSIONKIT_STUDIO_RESOURCE_UI=1` 的资源对话框用例通过（断言改为新的网络失败文案与按钮）。另用静默窗口手动走查：自定义代理指向本机未监听端口，设置写入 `network-settings.json`、Chromium `resolveProxy` 变为该代理、测试结果逐项显示“代理连接失败”和提示，786×540 无横向溢出，深浅色截图正常。
- 来源审计：重新登记 `electron/main/index.ts` 与 `electron/preload/index.ts` 的组合审计（两份 JSON）；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`test/subtitle-studio-provenance` 16 个文件通过、2 个跳过、233 个用例通过（与基线一致）。

**未做 / 未验证**

- 没有在真实网络上验证：Clash 系统代理与 PAC、中国大陆直连、各镜像的真实速度与重定向、`session.resolveProxy` 在 macOS 上的返回；验收 A4、A6 仍需按 README 的环境实测。
- 没有跑完整 `pnpm test`，没有打包。
- 经典转写页的下载错误文案在冻结文件里，没有改，留给 B5；更新清单与安装包的镜像回退（T4.1）未做，镜像表已可复用。
- 探测请求读完响应头即断开，没有复用连接给正式下载（每个源多一次 TLS 握手）。
- 代理用户名和密码仍不支持（环境变量里带的也不发送）；联网查证的 http 页面经代理时用 CONNECT 连到已核准的地址，只允许 443 的代理会拒绝这类页面。

### 2026-10-17 B1 审查后修正

三路审查共 25 条（electron-updater 不跟随代理一条被两路分别报告），逐条对照代码核实：22 条属实并已修正，3 条是 HEAD 上原有的问题或偶发失败，不属于 B1（`segmentedControlConsumers` 缺 `ExternalAgentPermissions.tsx`、CHANGELOG 缺 0.5.1 段、并行负载下的偶发超时），未改。

**网络层**

- electron-updater 走自己的 `electron-updater` 会话分区，原先只给默认会话设了代理。现在两个会话都设，并有测试核对分区名与 electron-updater 的 `NET_SESSION_NAME` 一致；静默窗口实测改成自定义代理后，该分区的 `resolveProxy` 变为所填代理。
- 改设置后，Chromium 在 `setProxy` 生效前回答的系统代理会被缓存 10 秒：现在生效后再清一次缓存，并在设置停止变化 1 秒后关闭两个会话的旧连接。只改下载源时不动 Chromium。
- 连接池：设置变化时正在用的连接，用完后会被放进新一代的池子继续复用，旧条目也不会清掉。现在池名固定为建立连接时的名字（Node 的 `_agentKey`），旧一代和用完即弃的连接不再放回池中。
- http 目标经 HTTP 代理改用完整地址转发（每个连接只发一个请求）；SOCKS 仍用隧道。
- 联网查证：系统代理模式下请求原本会经代理，由代理再次解析域名，绕过“只连公网地址”的检查。现在 http 页面经代理时先用联网查证自己的查询得到公网地址，再隧道到该地址；https 由证书按域名校验，代理即使解析到本机或局域网也连不上，所以仍由代理解析（避免国内 DNS 污染）。
- 系统代理模式在操作系统没有设代理时沿用 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（遵守 `NO_PROXY`），和改版前 axios 的行为一致。
- 自定义代理的格式检查放到 `src/network/proxy-address.ts`，主进程和设置页共用；支持中文输入法的全角冒号。

**下载传输**

- 所有源都校验失败时，原先会被“已有进展就再续传”的逻辑吞掉，最多再整文件下载 8 次。现在每个源在一次下载中最多用一次，全部不对时报校验失败（模型 `model_corrupt`，语音检测与 CUDA 包 `resource_signature_invalid`，与各管理器自己的校验失败码一致）。
- 选中的源反复读到一半就断、却没有留下进度时，原先永远不换源。现在连续两次没让部分文件变长就换下一个源。“再续传一轮”也改为看部分文件是否真的变长，而不是收到了多少字节。审查者的复现脚本：全部校验失败从 13 次整文件下载降到 4 次（每个镜像一次），全部截断从 36 次降到 4 次。
- 官方源模式下代理一次性拒绝（如 CONNECT 返回 502）原先立即失败，现在和自动模式一样当作“服务器忙”，按退避重试；代理要密码时不重试。
- SHA-256 改为边下边算，下载完不再整文件重读一遍（重启后续传等无法边下边算的情况才重读镜像文件）；官方源下的文件也一起核对，不对时同样换源。
- 安装包下载移到 `electron/main/network/file-download.ts` 并补测试（相对重定向、经代理、中途断开删除残留且只失败一次、无数据超时、非 200、跳到 http、重定向过多）。

**界面与文案**

- 测试结果的提示按用途逐条说明：模型服务、模型下载（任一源可用即可）、检查更新（GitHub 不通只影响检查更新）；官方源模式下官方地址不通时建议换成“自动”；系统代理模式和代理要密码各有专门提示。
- 点“测试”前先把还在等待输入停顿的地址发给主进程；改了设置后，旧的测试结果不再显示。
- 自定义代理格式不对、带用户名密码时给出提示（以前只提示“没填完整”）。
- 字幕工作台资源行：导入模型失败有自己的文案（文件对不上 / 读不了），不再显示下载和“网络设置”按钮；下载失败文案改为“通常是……”；校验失败文案不再承诺“会换下载源”，改为建议仍失败时去网络设置换源。
- 繁体中文把“國內鏡像”改为“中國大陸鏡像”，“校驗”改为“驗證 / 檢查碼”。
- `scripts/subtitle-studio/boundaries.json`：删去已删除的 `proxy.ts`，登记网络层被工作台间接用到的文件（`runtime`、`agent`、`proxy-resolver`、`tunnel`、`src/network/contract`、`src/network/proxy-address`）。

**验证**

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 3644 个键，33 条“与源相同”警告都是旧字符串）。
- `pnpm exec vitest run test/network src/store src/pages/Setting test/web-lookup test/ai test/subtitle-studio/boundaries.test.ts test/subtitle-studio/transcription-controller.test.ts test/speech-resources/engine test/speech-resources/service.test.ts test/speech-resources/preload.test.ts test/speech-resources/integration test/windowChrome.test.ts`：46 个文件通过、1 个跳过；399 个用例通过、7 个跳过。新增用例覆盖上面每一项；其中连接池用例在去掉修正后会失败（已核对）。
- `node scripts/subtitle-studio/check-boundaries.mjs`：625 个文件，无错误。
- `pnpm pretest` 后静默窗口：`test/e2e.spec.ts` 5 个通过；`FUSIONKIT_STUDIO_RESOURCE_UI=1` 的资源对话框用例通过；`FUSIONKIT_AGENT_WEB_E2E=1` 的 `agent-web` 与 `external-agent-settings` 通过。另用静默窗口走查设置页（代理指向本机未监听端口，不连外网）：输入端口后立刻点测试，结果显示的就是刚填的代理；切换模式后旧结果消失；格式不对、带密码、全角冒号三种输入的提示正确；786 宽无横向溢出。
- 来源审计：本轮没有改 `electron/main/index.ts`、`electron/preload/index.ts` 或冻结文件，组合审计不用重新登记；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`test/subtitle-studio-provenance` 16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。
- 仍未在真实网络上验证（Clash、PAC、国内直连、镜像实际表现、macOS），也没有跑完整 `pnpm test` 和打包；打包配置未改，未跑打包测试。

### 2026-10-17 B2 模型配置与欢迎向导（T2.1–T2.3）

**做了什么**

- T2.1 模型配置页：首页、悬浮助手、长文本翻译里“前往设置”都改用 `settingPath("model")`（`settingNavigation.ts` 新增，内部用 `createSettingSearchParams`），直接打开“AI 模型”标签；工作台、文件名翻译原本就带 `?tab=model`，未改。`useModelStore.addProfile` 新增配置时把空着的角色（或指向已删除配置的角色）分给它，Agent 只在能用该 API 格式时分配；`assignRoles: "all"` 供向导使用。“模型分配”卡片给两个角色各加一句说明，并说明第一个配置会自动用于两项。配置对话框移到 `ModelProfileDialog.tsx`：服务商分段控件里 DeepSeek 标“推荐”，下方有“获取 Key / 充值”链接（`window.open` → 主进程已有的 `setWindowOpenHandler` → `shell.openExternal`）；密钥框默认遮挡，带“显示密钥 / 隐藏密钥”按钮（`ApiKeyInput`，有无障碍标签）；“API 格式”“输出 Token 参数”“价格”收进可折叠的“高级设置”，编辑与预设不同的配置时自动展开（`profileDiffersFromPreset`）；标签改为“密钥（API Key）”“接口地址”“模型名”，接口地址提示改为“一般不用改”；保存时去掉密钥首尾空白，新建后若自动分配了角色会提示。
- T2.2 测试连接：新增 `electron/main/model-setup/`（`connection-test.ts` + IPC `model-setup:*`，只服务应用自己的主框架）与预加载 `window.modelSetup`。测试走真实调用同一条路径（`sendModelRuntimeText` → 两个适配器 → B1 的代理 Agent），按配置的 API 格式与输出 Token 参数发一个最多 16 个输出 token 的请求、不重试、20 秒超时，返回 `{ok, latencyMs, category, httpStatus?, detail?}`；detail 截短并去掉密钥（包括 `Bearer …`、`sk-…`），主进程不记录密钥。分类统一在 `src/lib/model-error-category.ts`（主进程和渲染进程共用）：auth / balance / model_not_found / rate_limited / network / proxy / server / bad_url / unknown，网络类沿用 B1 的 `classifyNetworkError`（适配器现在把它写进 `details.networkCategory`，并标记非 JSON 回答 `nonJsonResponse`）。余额先于限流和 401/403 判断（OpenAI 的空账户是 429 `insufficient_quota`，DeepSeek 是 402 “Insufficient Balance”），DeepSeek 的 400 “Model Not Exist”算模型不存在，HTML 404/405 算接口地址不对，地区限制算网络。原因与下一步的文案和按钮只在 `src/services/ai-error-guide.ts` 一处（`common:model_error.*`，按钮：打开模型设置、打开网络设置、获取新的 Key、去充值；DeepSeek 配置才出现后两个），界面用 `ModelErrorGuide` 组件。配置对话框底部加“测试连接”（未填密钥时不可点），结果在表单下方：转圈、成功和用时、失败原因 + 下一步按钮 + 服务原话，并自动滚到可见处。
- T2.2 运行时错误复用分类（错误码保持不变，只附加分类）：Agent（首页与悬浮助手共用 `ConversationFeed`）出错消息带 `failure.category` 并在消息下显示指引，会话导入导出 schema 同步；字幕工作台翻译任务保存 `translation.errorCategory`（严格 schema 新增可选字段，重新开始或续跑时清除），修订、一致性检查经 `StudioError.category` 与 `StudioResult.category` 带回；经典字幕翻译 `task-failed` 附 `errorCategory`，提示语和错误详情弹窗显示原因与按钮；长文本翻译分段失败摘要带 `category`；文件名翻译 `NameTranslationError.category`，余额判断改用统一分类。
- T2.3 欢迎向导：`WelcomeWizard`（挂在 `App.tsx`）在“没有任何带密钥的配置且从未完成或关闭过向导”时启动即打开，状态存 `fusionkit-onboarding`（zustand persist）。四步：怎么用（DeepSeek 推荐 / Claude Code 等 → 跳到 `?tab=external` / 先只用本地）→ 连接 DeepSeek（获取 Key、充值、遮挡的密钥框、“测试并保存”走 T2.2，成功后保存 DeepSeek 预设并同时设为 Agent 和任务执行模型；失败显示原因和下一步；“使用其他服务”打开同一个配置对话框，保存后同样分配两个角色）→ 本地转写（推荐模型约 1.0 GB、语音检测、剩余空间由主进程 `statfs` 读取，空间不足时提示）→ 完成页三个示例（复用首页 `suggestion_*`，经 `fillSessionDraft` 填入首页输入框；没有 AI 模型时改为打开对应工具）。设置“AI 模型”页可“重新打开新手引导”。UI 测试的启动开关：主进程 `resolveModelSetupLaunchConfig` 在 `NODE_ENV=test` 时返回 off，`FUSIONKIT_TEST_ONBOARDING=1` 时返回 forced；渲染进程是 test 构建（`import.meta.env.MODE === "test"`，覆盖用 `NODE_ENV=development` 启动的 `e2e.spec.ts`）时也只在 forced 时打开。`FUSIONKIT_TEST_DEEPSEEK_BASE_URL` 只在 `NODE_ENV=test` 且是回环 http 地址时生效，供 UI 测试把 DeepSeek 预设指向本机假服务。
- “一键准备”暂时打开字幕工作台转写页的“管理资源”（审查后改为先进入完成页，由完成页第一项打开，见下；新增 `studioResourcesPath()` / `?resources=open`；工作台 `index.tsx` 与 `view` 提示一起读取并一起从地址里删掉，再让 `StudioTranscription` 打开对话框一次——两处各自删参数时会互相写回，已在 UI 测试中发现并改正），留给 B3 的接口是 `WelcomeWizard.tsx` 里的 `prepareLocalTranscription`。
- 四种语言新增 82 个键（`common:model_error.*`、`common:onboarding.*`、`setting` 中的角色说明、高级设置、测试连接等）。`scripts/subtitle-studio/boundaries.json` 登记工作台间接用到的新文件（`network/errors.ts`、`api-format-capability.ts`、`components/model-error/`、`ai-error-guide.ts`、`settingNavigation.ts`）。

**与方案不同之处**

- OpenAI 预设仍默认 Responses API，没有改成 Chat Completions：方案的理由是“Agent 不支持 Responses”，但代码里 Agent 早已支持（`isAgentApiFormatSupported` 对两种格式都返回 true，`orchestrator.ts` 按格式选 `ResponsesAgentAdapter`，272fd1c），任务执行各路径也都支持；而 OpenAI 的 Pro 型号（如 gpt-5-pro）只开放 Responses 接口，预设里的 GPT-5.5 Pro / GPT-5.4 Pro 改成 Chat Completions 后很可能不可用（未用真实账号核实）。README 第 2 节与 T2.1 一行已按此更正。Responses 仍可在“高级设置”中切换。设置里“Agent 暂不支持 Responses”的旧文案因此不会再出现，未删。
- 测试连接的输出上限用 16 而不是 1：Responses API 要求 `max_output_tokens` 至少 16；回答被上限截断（`length_truncated`）或内容为空都算连接成功（审查后只认形状像真回答的空回答，见下）。
- 帮助页属于 B5，指引里没有“查看帮助”按钮。
- 重新打开新手引导只放在“AI 模型”页（模型配置卡片标题旁），没有放在“常规”页。
- 工作台的续跑对话框（`StudioTranslationTask`）报的是排队类错误（缺密钥等），不会带模型失败原因，没有接指引；模型失败在任务状态行显示。

**验证**

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 3726 个键，比 B1 多 82 个；33 条“与源相同”警告都是旧字符串）；`node scripts/subtitle-studio/check-boundaries.mjs`：631 个文件，无错误。
- 新增单元测试：`src/lib/model-error-category.test.ts`（23，DeepSeek/OpenAI 的真实报文与各分类）、`test/model-setup/connection-test.test.ts`（14，本机假服务：两种 API 格式与输出参数、截断算成功、401/402/400/429/500/405、HTML 页面与 HTML 404、未监听端口、不回应的超时、经自定义代理且代理不通 → proxy、发送前的检查、密钥不出现在 detail）、`test/model-setup/ipc.test.ts`（5，启动开关矩阵、测试地址只认 test + 回环、非应用窗口和子框架被拒、空间读取、预加载 API）、`test/ai/model-error-category.test.ts`（5，真实适配器的 networkCategory / nonJsonResponse，文件名翻译与工作台的分类传递）、`src/services/ai-error-guide.test.ts`、`src/store/useOnboardingStore.test.ts`、`src/pages/Setting/components/modelProfilePreset.test.ts`；扩展 `useModelStore.test.ts`（自动分配 5 种情况、不支持的格式不分给 Agent）、`settingNavigation.test.ts`、Studio `navigation.test.ts`、`session-schema.test.ts`、`orchestrator.test.ts`（出错消息带分类）、`translation-service.test.ts`（402/401/DNS 的 errorCategory 写入并可重读）、`base-translator.test.ts`（task-failed 带 errorCategory）、`textTranslationService.e2e.test.ts`（失败摘要带 category）。
- 相关已有测试：`test/ai test/network test/model-setup src/store src/pages src/agent src/lib src/services src/components`、名称翻译、经典翻译、长文本翻译、联网查证与 14 个工作台翻译/修订/IPC/边界测试等，共 192 个文件通过、11 个跳过（1849 个用例通过）；另跑 agent-sessions、external-agent、speech-resources service/preload、translation-knowledge 等 50 个文件，只有 `test/projectMetadata.test.ts`（CHANGELOG 缺 0.5.1 段，B1 已记录的原有问题）失败。`segmentedControlConsumers.test.ts` 的设置页名单随对话框移文件改为 `ModelProfileDialog.tsx`，并补上 HEAD 起就缺的 `ExternalAgentPermissions.tsx`（B1 记录的原有失败），现在通过。
- `pnpm pretest` 后静默窗口：新增 `test/onboarding.electron.test.ts` 2 个通过（`FUSIONKIT_TEST_ONBOARDING=1` + 本机假 DeepSeek：向导自动打开 → 选 DeepSeek → 获取 Key / 充值链接指向官方页面（未点击）→ 密钥遮挡与显示切换 → 错误密钥显示“密钥不对”与“获取新的 Key”、不保存 → 正确密钥只发一次 16 token 请求后保存并同时分配两个角色 → 本地转写步 → 完成页示例填入首页输入框、发送按钮可用、未配置提示消失 → 重启不再打开；不设开关的全新配置不自动打开 → “前往设置”到“AI 模型”页、角色说明可见 → 重新打开并跳过 → 配置对话框：DeepSeek 推荐、密钥遮挡、高级设置收起、测试连接 402 显示“余额不足”与“去充值”且不显示“打开模型设置”、再测成功、保存后两个角色都分配 → 再开向导选“一键准备”打开工作台转写页的资源管理，地址里的提示参数被清掉）；`test/e2e.spec.ts` 5 个通过（设置页用例改为先展开“高级设置”再检查两个分段控件）；`external-agent-settings` 通过；`FUSIONKIT_STUDIO_RESOURCE_UI=1` 资源对话框、`FUSIONKIT_NAME_TRANSLATOR_E2E=1` 文件名翻译、`FUSIONKIT_HOME_COMPOSER_E2E=1` 首页输入框、`FUSIONKIT_STUDIO_E2E=1` 的 AI 修订与一致性检查、`FUSIONKIT_AGENT_DOCK_E2E=1` 悬浮助手均通过。截图（786×540 浅色、1080×786 深色，向导各步与配置对话框）在 `test-results/onboarding/`，人工看过：无横向溢出，失败指引会自动滚到可见处。
- 来源审计：重新登记 `electron/main/index.ts`、`electron/preload/index.ts`（两份组合审计）与 `electron/main/subtitle-studio/index.ts`（集成审计）；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`test/subtitle-studio-provenance` 16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。冻结的本地转写文件、`package.json`、`vite.config.ts` 未改。

**未做 / 未验证**

- 没有用真实 DeepSeek / OpenAI 账号验证各错误的真实回答（分类依据公开文档中的状态码与报文，单元测试用本机假服务）；验收 A2、A3 仍需真实账号实测。
- “一键准备”只是打开资源管理器，真正的一键下载在 B3。
- 没有跑完整 `pnpm test`，没有打包。

### 2026-10-17 B2 审查后修正

三路审查共 26 条（“使用其他服务”里点网络设置后向导盖回来、向导提示语与实际分配不符、开发服务器下的 UI 测试仍会自动打开向导三处各被两路分别报告）。逐条对照代码核实：去重后 18 项属实并已修正；5 条是本批没有改动的代码里的失败或偶发超时（`agent-sessions` 提示框残留、`tool-navigation` 在 `/external-agent` 按 Esc、`tool-file-drop`、CHANGELOG 缺 0.5.1 段、并行负载下 `transcription-task-service` 超时），不属于 B2，未改。

**错误分类与测试连接**

- 分类先看服务商的错误码，再看文字：`rate_limit_exceeded` 的 429 即使正文提到 billing（OpenAI 免费档限流原文）也算“请求太频繁”；余额文字去掉单独的 “billing”，新增 `exceeded_current_quota_error`。文件名翻译只在“余额不足且不可重试”时报 `model_quota` 终止整批，限流仍按原来的方式重试。
- 空正文的 401/403 算密钥不对（只有非空的网页或文本才算接口地址不对）；404 只在点名模型（错误码或“The model `x` does not exist”这类原话）时算模型名不对，其余算接口地址不对。适配器在没有 OpenAI 格式的 `error` 对象时也读顶层 `message` 与 FastAPI 的 `detail`（vLLM、Ollama 等）。分类用服务商原话而不是“Model request failed with HTTP …”包装（包装里的 “Model … Not Found / Unsupported” 曾被当成模型名错误）。
- HTTP 200 却带错误对象的回答（部分网关这样报错）在两个适配器里都按服务商错误处理（带错误码与原话，永久错误不再重试）；Responses 格式下既无 `output` / `output_text` 又不是 `object: "response"` 的回答（`{}`、`{"status":"ok"}`）报“回答格式不对”，测试连接不再把它算作成功。
- 密钥里有中文、全角符号或空格：Node 在连接前就拒绝请求头，原先被当成“网络不通”。现在适配器报密钥错误且不重试，分类也认 Chromium 的同类报错；测试连接在发送前检查；密钥框下方当场提示“可能多复制了别的文字”。
- 测试连接结果新增 `reason`（没填密钥、密钥含多余字符、没填 / 格式不对的接口地址、没填模型名、超时），界面用本地化的原因与下一步代替笼统的分类文案；`detail` 只放服务商原话（标“服务返回：”）或连接层报错（标“连接情况：”），不再显示应用自己写的英文句子。
- 下一步文案按显示位置区分：配置对话框里的测试不再让人“到‘AI 模型’设置里”或“点测试连接”，改为“检查上面填写的……”；向导里接口地址类错误改说“收到的回答不是来自 DeepSeek，可能被网络或代理拦截”，并给“打开网络设置”按钮。

**向导与配置对话框**

- 点失败指引里的“打开网络设置”不再丢掉已填内容：配置对话框把表单暂存在内存（`useModelProfileDraftStore`，不写盘），提示条“继续填写”回到“AI 模型”页并重新打开填好的表单；向导不再记为“已关闭”，保留粘贴的密钥（含“使用其他服务”表单），提示条“回到新手引导”或设置里“重新打开新手引导”都从 DeepSeek 一步继续，“使用其他服务”表单里点网络设置也不会再让向导盖回网络设置页。
- 向导分配角色：任务执行模型总是改用新配置；Agent 只在正在对话且当前模型可用（有密钥）时保留原模型，并改用“翻译任务会使用 DeepSeek；助手暂时还用原来的模型”的提示，不再一律声称两项都用 DeepSeek。
- 再次“测试并保存”（返回后重选 DeepSeek，或以后重开向导）复用已保存的同密钥同地址 DeepSeek 配置，不再新建重复配置；测试进行中按回车不再重复发请求。
- “一键准备”改为进入完成页（不再直接结束向导），完成页第一项“下载本地转写模型”打开工作台资源管理；B3 只需替换 `prepareLocalTranscription` 的返回与实现。
- 剩余空间提示阈值改为 2 GB，与文案中的数字取同一常量；完成页在没有 AI 模型时换用对应说明，并写明重新打开的位置（设置的“AI 模型”页）。
- 无障碍：选项卡与示例按钮外包 `role="listitem"`，按钮本身仍读作按钮；DeepSeek 分段项的无障碍名称改为四种语言各自的翻译。
- 文案：网络测试提示里的“地址（Base URL）”改为“接口地址”；服务商选“其他”时接口地址提示不再写“一般不用改”；经典字幕翻译失败提示改用当前语言（不再拼接主进程的中文“请求接口失败”）。四种语言各新增 32 个键（共 3758 个）。
- UI 测试开关：主进程在 `FUSIONKIT_TEST_WINDOW`（测试运行器总会设置）或 `FUSIONKIT_TEST_ONBOARDING=0` 时也返回 off，覆盖用 `NODE_ENV=development` + 开发服务器启动的 `development-ui`、`library-ui`。`scripts/subtitle-studio/boundaries.json` 登记 `src/model-setup/contract.ts`（工作台经 `ai-error-guide.ts` 间接用到）。

**验证**

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 3758 个键，33 条“与源相同”警告都是旧字符串，所有源码中的键可解析）；`node scripts/subtitle-studio/check-boundaries.mjs`：632 个文件，无错误。
- 单元测试：`src/lib/model-error-category.test.ts` 35 个（新增免费档 429、空正文 401/403、JSON 404、vLLM/Ollama 原话、包装句不误判、密钥字符）、`test/ai/model-error-category.test.ts` 8 个（本机服务器：空 401、FastAPI 404、200 带错误对象、Responses 非回答、中文密钥不发请求、文件名翻译限流不终止）、`test/model-setup/connection-test.test.ts` 16 个、`ipc.test.ts` 5 个、`ai-error-guide.test.ts` 6 个（按位置的下一步、每个原因与分类在中文里都有文案）、`useOnboardingStore.test.ts` 5 个、新增 `useModelProfileDraftStore.test.ts` 2 个。相关已有测试 `src`、`test/ai`、`test/network`、`test/model-setup`、翻译 / 长文本 / 文件名翻译 / 联网查证、工作台翻译与修订等：200 个文件通过、11 个跳过，1872 个用例通过。
- `pnpm pretest` 后静默窗口：`test/onboarding.electron.test.ts` 2 个通过（新增：密钥含全角冒号当场提示且不发请求；错误密钥的指引显示“服务返回：HTTP 401 · …”而非英文包装；连接被断开时“打开网络设置”离开向导、状态仍为未看过、提示条“回到新手引导”带回已填密钥；同一密钥再次测试并保存仍只有 1 个配置；“一键准备”进入完成页并由第一项打开资源管理；配置对话框空接口地址的原因、断开连接后“继续填写”带回已填内容）；`e2e.spec.ts` 5 个、`external-agent-settings`、`FUSIONKIT_STUDIO_RESOURCE_UI=1` 资源对话框、`FUSIONKIT_NAME_TRANSLATOR_E2E=1`、`FUSIONKIT_HOME_COMPOSER_E2E=1`、`FUSIONKIT_STUDIO_E2E=1` 修订与一致性检查、`FUSIONKIT_AGENT_DOCK_E2E=1` 均通过；`FUSIONKIT_AGENT_SESSIONS_E2E=1` 4 个中 1 个仍是提示框残留（与审查报告一致，侧栏与提示框不在改动范围内）。另对 `VSCODE_DEBUG=1 pnpm dev` 跑了一次 `development-ui.test.ts`：全新配置下向导没有出现，导入、重启、列表均通过，最后一步“已下载：exported.srt”提示未出现而失败（工作台导出，与本批无关，未进一步排查）；跑完后已停掉开发服务器并重新 `pnpm pretest`。
- 来源审计：本轮没有改组合文件或冻结文件，审计不用重新登记；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`test/subtitle-studio-provenance` 16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。打包配置未改，未跑打包测试；没有跑完整 `pnpm test`，没有打包。
- 仍未验证：真实 DeepSeek / OpenAI 账号与真实网络（Clash、中国大陆直连）下的报错原文；文件名翻译遇到不点名模型的 404 时，标题仍是原有的“找不到所配置的模型”，下方指引则按接口地址给出建议。

### 2026-10-17 B3 运行库与转写准备（T3.1–T3.3）

**做了什么**

- T3.1 打包：新增 `scripts/packaging/vc-redist.mjs`，由 `subtitle-studio-before-pack.cjs` 只在 Windows 目标上调用（两个冻结资源校验之后）。准备 `build/vc-redist/vc_redist.x64.exe` 的顺序：环境变量 `FUSIONKIT_VC_REDIST_PATH` 指定的文件（不合格直接拒绝，不改用下载）→ 已缓存的文件（不合格就重新下载）→ 从 `https://aka.ms/vs/17/release/vc_redist.x64.exe` 下载（跟随重定向，只走 https，可经构建环境的 `HTTPS_PROXY` / `HTTP_PROXY`，遵守 `NO_PROXY`，有大小上限与长度核对）。用 Windows PowerShell 的 `Get-AuthenticodeSignature` 校验：状态 Valid、签名者含 `O=Microsoft Corporation`、文件说明含 `(x64)`，并读出 ProductVersion（必须是 14.x）。写出 `vc-redist.json`（schemaVersion、fileName、version、minimumVersion、sha256、byteSize、signer，不写时间戳）和 NSIS 用的 `vc-redist-version.nsh`（随包版本 `VC_REDIST_MAJOR/MINOR/BUILD/VERSION` 与最低版本 `VC_RUNTIME_MIN_MAJOR/MINOR/BUILD`）。最低版本 `VC_RUNTIME_MINIMUM` 为 14.40.33810（见“审查后修正”），随包运行库低于它也拒绝。任一步失败都拒绝打 Windows 包（`vc_redist_invalid`）。`.gitignore` 新增 `/build/vc-redist/`；新增的 `build/installer.nsh` 未被忽略，需要纳入版本库（本批按规定没有 `git add`）。
- `electron-builder.subtitle-studio.json`：`win.extraResources` 把 `build/vc-redist` 中的 `vc_redist.x64.exe` 与 `vc-redist.json` 放到 `resources/vc-redist/`；`nsis.include` 为 `build/installer.nsh`，`perMachine` 仍为 false。`customInstall` 宏：`SetRegView 64` 读取 `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64` 的 Installed/Major/Minor/Bld 后恢复视图；只有未安装或低于最低版本 14.40.33810 时才 `ExecWait '"$INSTDIR\resources\vc-redist\vc_redist.x64.exe" /install /quiet /norestart'`（随包文件存在才运行；比随包版本旧但不低于最低版本的运行库不动）。运行前的状态行按安装程序的语言显示（简体、繁体、日文，其余英文），说明 Windows 会弹确认框、请选“是”。0、1638、3010 视为成功（并清除“曾拒绝”记录）；拒绝确认框（1602 / 1223）时在 `HKCU\Software\FusionKit\Setup` 写入 `VcRedistDeclined`，之后的更新（`--updated`）不再询问，手动重装仍会询问，真正卸载（不是更新）时删除该键；其余失败只写一行 DetailPrint。都不中止、不弹框、不设置错误码，用到的寄存器先压栈后恢复。electron-updater 用 /S 静默更新时同样只在需要时运行：运行库可用的电脑、以及曾拒绝过的电脑，都不会再弹确认框。
- 打包合同 `subtitle-studio-contract.mjs`：新增 `WINDOWS_RESOURCES`、`NSIS_INCLUDE`；Windows 的 `extraResources` 必须恰好是这一项（目录、目标、两个文件的 filter），macOS 仍不允许平台级 `extraResources`；`nsis.include` 必须是 `build/installer.nsh`、`perMachine` 必须为 false、不允许 `nsis.script`。macOS 打包流程不变（before-pack 只在 win32 准备运行库，有测试覆盖）。
- T3.2 运行库检测与修复：新增 `src/system-setup/contract.ts`、`electron/main/system/`（`vc-runtime.ts`、`gpu.ts`、`index.ts`）、预加载 `window.systemSetup`（`electron/preload/system-setup-api.ts`，旧的通用 IPC 通道禁止 `system-setup:` 前缀），只服务应用自己的主框架。检测用 `System32\reg.exe query … /reg:64`，64 位视图没有时再查 `/reg:32`，解析 Installed/Major/Minor/Bld（缺数字时读 Version 字符串），得出 ok / missing / outdated / not_applicable / unknown；要求的版本是转写程序能用的最低版本：打包版读随包 `resources/vc-redist/vc-redist.json` 的 `minimumVersion`（与 NSIS 的最低版本定义同源），源码运行用同值常量 `MINIMUM_VC_RUNTIME_VERSION` = 14.40.33810（有测试保证两处一致），低于它才算“过旧”。修复只在主进程解析路径：必须位于 `process.resourcesPath` 内、是普通文件、记录合法且字节的大小与 SHA-256 与记录一致，然后启动随包安装程序 `/install /passive /norestart`（自行请求管理员权限，用户会看到系统确认框和进度），结束后重新读注册表，结果为 installed / restart_required / cancelled / failed；没有随包文件（源码运行）或字节对不上时用 `shell.openExternal` 打开微软下载地址。一次只运行一个修复。
- 界面：渲染进程共享状态 `src/services/system-setup/system-setup-store.ts`，横幅组件 `src/components/system-setup/VcRuntimeNotice.tsx`（原因、下一步、“一键修复”；拒绝、失败、已打开下载页、需要重启各有说明，失败时有“手动下载”）。显示位置：字幕工作台转写页（媒体区上方）、资源管理对话框顶部（此时不再显示“本地运行环境已就绪”，配置栏的运行环境行改为“需要安装微软运行库”）、欢迎向导完成页；经典转写页已冻结，在 `App.tsx` 的路由里于页面上方挂 `VcRuntimePageNotice`，未改冻结文件。下载前检查：资源行“下载”先确认运行库（打开资源管理时会重新读取一次，10 秒内的结果直接使用，否则先查）；缺失或过旧时弹出“先安装微软运行库”对话框，修复成功后自动开始原来的下载，也可“仍要下载”。失败说明：只有转写程序启动或加载时崩溃、无响应（`runtime_crashed`、`runtime_unresponsive`）或下载的文件没通过加载检查（`model_incompatible`，导入的文件仍按“文件对不上”说明）时才重新读取运行库状态，缺失或过旧就改为显示“这台电脑缺少微软 VC++ 运行库或版本太旧……请先点上方的‘一键修复’”；校验失败、网络、磁盘、程序文件缺失、FFmpeg（不依赖运行库）等仍显示各自的原因。语音检测在推荐模型装好之前下载时显示“语音检测需要先装好‘标准’模型……”。配置栏运行环境行的“重新检查”也会重新读取运行库；修复失败后横幅也有“重新检查”，手动安装后点它即可。
- T3.3 一键准备：`src/services/subtitle-studio/local-preparation.ts`（与资源行共用 Studio 控制器的下载）。先查运行库（Windows），缺失就停在“需要先安装微软运行库”，在任何地方修复成功（状态变为 ok）后自动继续，等待时可点“取消”不再等待；然后依次安装推荐模型（目录的 `defaultRecommended`，即 large-v3-q5_0）、语音检测（它的加载检查要用推荐模型）。可加入已在进行的下载、可取消（下载刚开始还没有任务号时按取消，也会在任务出现后取消它）；某项失败就停下，后面的标为跳过；失败是运行类错误码时再查一次运行库，缺失就转为“需要先安装微软运行库”，修复后继续。最后报完成 / 失败 / 取消；完成后若当前选的模型没装好就改用推荐模型。资源管理顶部的“一键准备（推荐）”卡片（`StudioLocalPrepare.tsx`）显示需要下载的大小与剩余空间（`window.modelSetup.getFreeDiskSpace`）、空间不足提示（写出需要多少、还剩多少）、按大小加权的总进度条、当前项目和它自己的进度、结果；都装好时按钮为“已准备好”且不可点，之前的失败或取消提示不再显示。欢迎向导第 3 步的 `prepareLocalTranscription` 现在启动同一个任务（后台进行），完成页卡片显示进度 / 完成 / 失败，点它打开资源管理或转写页；需要运行库时显示修复横幅和“打开本地资源”。完成、失败或转为需要运行库时全局弹出提示（带“查看”）。
- 友好名称（界面映射，未改冻结清单）：`resource-names.ts`。large-v3-q5_0 →“标准（推荐，约 1.0 GB）”、large-v3 →“最高精度（约 2.9 GB，较慢）”、语音检测 →“语音检测（自动跳过静音）”、CUDA 包 →“NVIDIA 显卡加速”，原名放在资源行的说明行；模型下拉、开始栏、任务行（用短名，如“标准 · CPU”）、删除确认、重新识别字幕的模型下拉、下载进度条的无障碍名称都用新名称；加速包的类型标签为“显卡加速”，开始栏提示“请先安装‘NVIDIA 显卡加速’，或改用 CPU”，共享目录说明不再写“CUDA 资源”。
- NVIDIA 检测：先 `C:\Windows\System32\nvidia-smi.exe`（再试 `Program Files\NVIDIA Corporation\NVSMI`）`--query-gpu=name,driver_version --format=csv,noheader`，5 秒超时；失败时用 PowerShell 的 `Get-CimInstance Win32_VideoController` 名称与驱动版本（Windows 驱动号如 31.0.15.5161 换算为 551.61）；结果为 `{status, hasNvidia, gpuName, driverVersion, driverOk(≥551.61), source}`，每次运行只检测一次（“重新检查”会刷新）。资源行：有 N 卡时 CUDA 包标“推荐”；驱动低于 551.61 时提示“建议先更新 NVIDIA 显卡驱动”并给“更新驱动”按钮（https://www.nvidia.cn/drivers/lookup/ ）；没有 N 卡时标“此电脑不适用”并说明，点下载先弹确认框。设备选择下方说明：没有 N 卡只能用 CPU / 驱动较旧 / 装好显卡加速后可用显卡；没有 N 卡却选了“NVIDIA GPU”时，说明和开始栏都提示改选“自动”或“CPU”。
- 设备选“自动”而实际用了 CPU：控制器记录本窗口以“自动”提交的任务（`autoDeviceTaskIds`），任务行的模型标签写成“标准 · CPU · 未安装显卡加速”（或“没有检测到 NVIDIA 显卡”“显卡加速不可用”），提示框同文。
- 导入文案：工作台“本地资源”说明改为文件必须和列表中的某个模型完全一致；经典转写页（只改语言文件）的导入标题、说明与引导中“兼容的 GGML 模型”同步改正，导入说明不再出现“哈希”“CPU 加载能力”。四种语言共新增 67 个键，审查后再增 2 个（每种语言 3827 个）。
- `scripts/subtitle-studio/boundaries.json` 登记工作台间接用到的 `src/system-setup/contract.ts`、`src/services/system-setup/system-setup-store.ts`、`src/components/system-setup/`。

**与方案不同之处**

- `win.extraResources` 用目录加两个文件的 filter，同时带上 `vc-redist.json`，应用据此知道随包版本，并在修复前核对字节。
- 方案写“转写程序以 `0xC0000135` / `0xC0000139` 退出时检查”：冻结的转写代码不把退出码交给界面，只给错误码，所以改为遇到运行类错误码就重新读注册表（README 第 1 节与 T3.2 一行已更正）。没有按退出码区分“缺 DLL”和其他崩溃。
- 一键准备先装推荐模型再装语音检测。最初的实现反过来，想借约 1 MB 的语音检测提前发现运行库问题，但语音检测的加载检查要用已装好的推荐模型（共享引擎 `vad-manager.ts` 在下载前就解析模型，没装时以 `model_missing` 失败，已有引擎测试固定了这一点），全新电脑上会先失败、再下 1 GB 模型。运行库问题的提前发现只能靠注册表检查。
- “过旧”以转写程序能用的最低版本 14.40.33810 为界，不是方案写的“低于随包版本”：`aka.ms` 的随包版本会随微软更新变新，按随包版本判断会让运行库可用的用户每次更新都看到确认框。
- 自动回落 CPU 的原因放进任务行原有的模型标签（单行，超长省略），没有另起一行：队列行“两行信息”的界面测试要求保持这一点。
- 测试开关只在未打包运行（`app.isPackaged` 为 false）且 `NODE_ENV=test` 时生效，安装版即使环境里设了 `NODE_ENV=test` 也不理会：`FUSIONKIT_TEST_VC_RUNTIME=ok|missing|outdated|real`、`FUSIONKIT_TEST_VC_REPAIR=installed|cancelled|failed|restart_required`、`FUSIONKIT_TEST_GPU=none|nvidia|nvidia_old_driver`。不设开关时运行库固定为 ok、显卡固定为“未知”，所以界面测试在任何电脑上表现相同；`real` 读本机注册表，但修复什么都不做（不启动安装程序、不打开网页）。欢迎向导的界面测试默认报告“缺少运行库”且修复被拒，保证一键准备在测试里不会真的下载模型。

**验证**

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 3825 个键，33 条“与源相同”警告都是旧字符串，所有源码中的键可解析）；`node scripts/subtitle-studio/check-boundaries.mjs`：641 个文件，无错误。
- `node --test scripts/packaging/*.test.mjs`：33 个全部通过（原 23 个。新增 `vc-redist.test.mjs` 8 个：版本解析与 NSIS 定义；签名判断，含伪 Microsoft 签名者、x86 包、非 14.x；用本机 PowerShell 读取真实签名，notepad.exe 为 Valid 但不是运行库，随手写的文件不为 Valid；首次下载与缓存复用；缓存不合格时重下、下载不合格时拒绝；环境变量指定的文件；本机 http 服务器上的重定向、长度不符、404、拒绝 http、重定向过多；经本机代理与 `NO_PROXY`。打包测试新增 2 个：只有 Windows 准备运行库且在两个资源校验之后、失败时拒绝打包；NSIS 宏逐行核对且不含 Abort/MessageBox/SetErrorLevel、压栈出栈成对。合同篡改用例新增 14 种）。
- 在本机真实下载并校验了一次运行库：14.44.35211.0，25,635,768 字节，SHA-256 `cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b`，Microsoft 签名有效（没有运行它）。
- 打包：`pnpm exec tsc --noEmit && pnpm exec vite build && node scripts/check-preload-bundle.mjs && pnpm exec electron-builder --config electron-builder.subtitle-studio.json --win nsis --publish never -c.directories.output=test-results/easy-setup-pack` 成功（before-pack 通过，makensis 编译通过；`builder-debug.yml` 中有 `!include build\installer.nsh`，`customInstall` 由 electron-builder 的安装段插入）。安装包 321,757,587 字节（`release/0.5.1` 中的为 297,080,984，未被改动），`win-unpacked/resources/vc-redist/` 含两个文件，哈希与记录一致。用打包出的资源目录运行主进程检测代码：随包文件完整，本机已装 14.51.36247，状态 ok。没有运行安装包与运行库安装程序。
- 单元测试：`test/system` 20 个（`vc-runtime` 11：注册表输出解析、版本比较、64/32 位视图、不可读算 unknown、随包文件只认资源目录内的普通文件与合法记录、修复的各退出码、同时只运行一个、源码运行与字节不符时打开下载页；`gpu` 6：nvidia-smi 与 Windows 显卡列表解析、驱动号换算、先 nvidia-smi 后 PowerShell、本机真实检测；`ipc` 3：只服务应用主框架、测试开关只在 test 生效且不会启动安装程序、预加载方法固定）、`src/services/system-setup/system-setup-store.test.ts` 5、`src/services/subtitle-studio/local-preparation.test.ts` 9（审查后为 12，见下）、`resource-names.test.ts` 7（名称映射与回退、四种语言都有名称、运行类错误码、自动回落 CPU 的原因、设备说明、CUDA 包适用性）。
- 较大范围：`pnpm exec vitest run src test/system test/model-setup test/network test/speech-resources test/ai test/external-agent test/app-shutdown.test.ts test/windowChrome.test.ts test/subtitle-studio --maxWorkers=4 --minWorkers=1`：282 个文件通过、56 个跳过，3389 个用例通过；1 个失败是 `transcription-task-service` 在并行负载下超时（B2 已记录的偶发问题），单独重跑 42 个全部通过。
- `pnpm pretest` 后静默窗口：`FUSIONKIT_STUDIO_RESOURCE_UI=1` 资源对话框 3 个通过（原用例改为固定“有运行库、有 N 卡”，并检查新名称、原名说明行、“推荐”、全部装好后一键准备不可点、删除确认用新名称；新增用例覆盖：缺运行库时工作台与对话框横幅、设备说明、CUDA 包“此电脑不适用”与确认框、单项下载先弹运行库对话框且取消不下载、“仍要下载”后加载失败显示运行库原因、一键准备停在需要运行库、在上方横幅修复后自动依次安装模型与语音检测（审查后的顺序）并显示进度和完成、完成提示、786×540 深色无横向溢出、以“自动”提交的任务标签为“标准 · CPU · 没有检测到 NVIDIA 显卡”；另一个新增用例：驱动过旧时“推荐”加“更新驱动”按钮指向 NVIDIA 驱动页（未点击）、有 N 卡时直接下载不弹确认）；`test/onboarding.electron.test.ts` 2 个通过（一键准备进入完成页、缺运行库时显示修复横幅、修复被拒的说明与“打开本地资源”，重开后进入资源管理且一键准备停在需要运行库）；`FUSIONKIT_STUDIO_T06_UI=1` 转写页 2 个通过；`FUSIONKIT_STUDIO_E2E=1` 重新识别字幕 1 个通过（模型下拉改为新名称，断言随之更新）；`test/e2e.spec.ts` 5 个通过。截图在 `test-results/studio-t06-ui/controlled-*/prepare-*.png`、`driver-old.png` 与 `test-results/onboarding/`，人工看过；看图后改正了重复的运行库横幅、完成时重复的文字、中文句子间多出的空格、排队中却写“已用 CPU”等问题。另用静默窗口截图看过经典转写页上方的横幅。
- 未通过的界面测试（审查确认都是原有问题：在 HEAD 76d60bd 的 `git archive` 快照上以 `vite build --mode=test` 构建后，三个用例在同一行以同样方式失败）：`FUSIONKIT_STUDIO_I6_QUEUE_UI=1` 队列外观在“悬停停止按钮应出现‘取消任务’提示”处失败（`interaction-queue-ui.test.ts:201`，提示框没有出现）；`FUSIONKIT_STUDIO_I5_TRANSCRIPTION_UI=1` 在打开“转写完成后自动翻译”后第三次拖入文件时没有出现媒体行（`experience-transcription-ui.test.ts:103`）；`FUSIONKIT_STUDIO_I3_QUEUE_UI=1` 的提示框严格模式失败（`acceptance-queue-overview-ui.test.ts:177`）。I6 中带 CPU 原因的模型标签在 786×540 深色下的行高与不溢出，另用跳过停止按钮提示一步的临时副本跑过（见下）。
- 来源审计：重新登记 `electron/main/index.ts`（`0e26a2801b4ba90013b80b69fcca3afbc03929ad`）与 `electron/preload/index.ts`（`43334cddfdad8c981de7a439708e0b67b653e968`）的两份组合审计；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`：16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。冻结的本地转写文件、Studio 复制文件、资源清单、`package.json`、`electron-builder.json` 未改。

**审查后修正（2026-10-17）**

三个角度的审查共 19 条，逐条对照代码核实后改了 16 条；I3、I5、I6 三条界面测试失败核实为 HEAD 76d60bd 上就有的问题，只更新记录。

- 一键准备的顺序改为“模型 → 语音检测”（高）：语音检测的加载检查要用推荐模型，原顺序在全新电脑上必然先失败。UI 测试的替身也照引擎行为，在推荐模型没装好时让语音检测以 `model_missing` 失败，资源行给出“先下载‘标准’模型”的说明。
- 某项失败就停下，不再接着下载；失败码是运行类时再查运行库，缺失就转为“需要先安装微软运行库”（中）。
- 运行库以最低版本 14.40.33810 判断（中）：打包脚本把它写进 `vc-redist.json` 与 NSIS 定义，NSIS 只在低于它时运行随包安装程序，应用也只在低于它时提示；随包版本低于它时拒绝打包。依据：`whisper-server.exe` 只导入 `_Mtx_lock` / `_Mtx_unlock` 而不导入 `_Mtx_init_in_situ`，说明用了 VS 2022 17.10 起的 constexpr `std::mutex`，在 14.40 之前的 msvcp140 上会崩溃。安装程序记住用户拒绝过确认框，之后的更新不再询问。
- 运行库原因改为只认 `runtime_crashed`、`runtime_unresponsive`、`model_incompatible`（低）；校验失败、程序文件缺失、加速包不可用、FFmpeg 启动失败等不再被说成缺运行库。
- 等待运行库的一键准备可以“取消”，只在运行库状态变为 ok 时自动继续；单项下载的运行库对话框在修复进行中被取消后，不会再开始下载；刚开始下载时按取消也会取消新下载（低）。
- 测试开关要求未打包运行；不设开关时运行库固定为 ok（中、低）。
- 界面：都装好后不再显示旧的失败 / 取消提示；配置栏“重新检查”与修复失败后的横幅都会重新读取运行库；加速包相关文案改用“NVIDIA 显卡加速”；选了“NVIDIA GPU”而没有 N 卡时提示改选；空间不足写出需要与剩余的大小；经典导入说明去掉术语；NSIS 状态行按语言显示（中、低）。
- 记录更正：`/reg:32` 的写法、一键准备顺序的理由、测试开关“任何电脑上表现相同”的说法。

审查后运行的检查：

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 3827 个键，33 条“与源相同”警告都是旧字符串）；`node scripts/subtitle-studio/check-boundaries.mjs`：641 个文件，无错误。
- `node --test scripts/packaging/*.test.mjs`：33 个全部通过（`vc-redist.test.mjs` 增加最低版本的定义、记录与拒绝；NSIS 用例改为核对最低版本比较、更新时跳过已拒绝、拒绝记录与卸载清理、按语言的状态行）。
- `pnpm exec vitest run test/system src/services/system-setup src/services/subtitle-studio src/pages/Tools/Subtitle/SubtitleStudio test/subtitle-studio/transcription-controller.test.ts src/components`：19 个文件、165 个用例通过（`test/system` 21：最低版本、记录必须带最低版本且不高于随包版本、与打包脚本常量一致、打包版忽略测试开关、不设开关固定为 ok；`local-preparation.test.ts` 12：新顺序、失败即停并跳过语音检测、运行类失败转为需要运行库、取消等待、启动中取消）。
- 打包：`pnpm exec vite build`、`node scripts/check-preload-bundle.mjs`、`pnpm exec electron-builder --config electron-builder.subtitle-studio.json --win nsis --publish never -c.directories.output=test-results/easy-setup-pack` 成功（makensis 以警告即错误编译通过，安装段与卸载段都包含新宏）。安装包 321,756,833 字节；`win-unpacked/resources/vc-redist/vc-redist.json` 带 `minimumVersion: 14.40.33810`；`release/0.5.1` 未被改动。安装包、运行库安装程序与 NSIS 分支仍没有执行。
- `pnpm pretest` 后静默窗口：`FUSIONKIT_STUDIO_RESOURCE_UI=1` 资源对话框 3 个通过（新增：推荐模型没装时下载语音检测的说明；一键准备从模型开始、模型失败即停且没有下载语音检测；行里补齐后旧失败提示消失、显示“都已就绪”；等待运行库时“取消”与再次准备；修复后先模型后语音检测）；`test/onboarding.electron.test.ts` 2 个、`FUSIONKIT_STUDIO_T06_UI=1` 转写页 2 个、`FUSIONKIT_STUDIO_E2E=1` 重新识别字幕 1 个、`test/e2e.spec.ts` 5 个、`FUSIONKIT_TRANSCRIPTION_EMPTY_UI=1` 经典页 2 个通过。I6 原用例仍在第 201 行同样失败；去掉这一步的临时副本（跑完即删）浅色 1280×860 与深色 786×540 两轮全部通过，包括带 CPU 原因标签的行高与不溢出。
- 来源审计：审查没有改动受审计文件；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact，`electron/main/index.ts`、`electron/preload/index.ts` 的 blob 仍为已登记的 `0e26a280…`、`43334cdd…`；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`：16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。

**未做 / 未验证**

- 没有运行安装包和 `vc_redist.x64.exe`：NSIS 宏的分支（缺失 / 过旧 / 已有更新版本）、静默更新时的表现、拒绝确认框后的退出码只经代码审阅与编译，没有执行；应用内修复的真实 UAC 流程（`runInstallerProcess`）没有执行，界面测试用的是测试开关。验收 A5（全新 Windows 10/11 上无需另装即可本地转写）仍需在虚拟机上实测。
- macOS 没有打包（本机为 Windows），只靠合同测试确认 macOS 配置不变。
- 经典转写页本身已冻结：只在页面上方加了运行库横幅；它的资源行不做下载前检查，也不显示友好名称和显卡说明。
- `test-results/easy-setup-pack/` 约 1.4 GB 留作检查，可随时删除；`build/vc-redist/` 中缓存的运行库保留在本机（已被忽略）。
- 没有跑完整 `pnpm test`；I3、I5、I6 三个界面测试的原有失败没有排查原因（不在本批范围）。
- 随包运行库来自 `aka.ms/vs/17`（VS 2022 系列，本机下载到的是 14.44.35211），而随包转写程序是用 14.51 工具集（链接器 14.51、Rich 头构建号 36247）编译的。微软的一般要求是运行库不旧于编译工具集；审查时只核对了导入表：`whisper-server.exe`、`whisper.dll`、`ggml.dll`、`ggml-base.dll`、`ggml-cpu-*.dll` 从 msvcp140 / vcruntime140 / vcruntime140_1 导入的符号，在本机其他软件自带的 14.40.33816、14.44.35208、14.44.35211（x64）副本中全部存在。是否在 14.40–14.44 上真的能完成转写，要在 A5 的全新虚拟机上实测；若不行，需要把最低版本提到 14.50 并改用 VS 2026 系列的运行库下载地址。
- 审查发现的 B2 同类问题未改：`electron/main/model-setup` 的测试开关同样只看运行时的 `NODE_ENV`。

### 2026-10-17 B3 运行库版本修正（主会话）

- 审查发现随包转写程序由 MSVC 14.51 工具集编译（链接器 14.51、Rich 头构建号 36247），而 `aka.ms/vs/17` 给出的是 14.44.35211。按微软“运行库不旧于编译工具集”的要求，下载地址改为微软永久链接 `https://aka.ms/vc14/vc_redist.x64.exe`（2026-10-17 实测给出 14.51.36247.0，18,731,856 字节，SHA-256 `843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c`，Microsoft 签名有效，文件说明 “Microsoft Visual C++ v14 Redistributable (x64)”），最低版本 `VC_RUNTIME_MINIMUM` / `MINIMUM_VC_RUNTIME_VERSION` 改为 14.51.36247。代价：已装 14.40–14.50 运行库的电脑会在安装或使用转写时被提示升级一次。
- 已缓存的 14.44 安装程序低于新的最低版本，下次 Windows 打包时会被拒绝并自动重新下载。
- 测试夹具按同一映射更新（最低版本 14.51.36247、随包 14.52.36500、“过旧”14.44.35211）；`node --test scripts/packaging/*.test.mjs` 33/33 通过，`test/system`、`src/services/system-setup`、`src/services/subtitle-studio` 66/66 通过。

### 2026-10-17 B4 更新与安装包瘦身（T4.1–T4.2）

**做了什么**

- T4.1 主进程：新增 `electron/main/app-update/`。`provider.ts` 是 electron-updater 的自定义 provider：检查时按顺序读取各源的 `releases/latest/download/latest.yml`（macOS 读 `latest-mac.yml`），每个源 15 秒限时（用 electron-updater 自己的 CancellationToken 取消），第一个给出可用更新信息的源胜出；HTML 页面、坏 YAML、没有文件或没有 SHA-512 的回答都算“没答上”，换下一个源；文件名只认单段文件名，不跟随清单里的完整地址；不再把 electron-updater 的持久 `x-user-staging-id` 发给镜像。下载按版本标签路径 `releases/download/v<版本>/<文件>` 取文件，这样 electron-updater 能用“替换路径里的版本号”找到旧版本的 blockmap（经镜像也可以），只下载变化的块；不支持多段 Range。`sources.ts` 由 B1 镜像表（`github-release` 组）生成源：自动 = github.com → ghfast.top → ghproxy.net，官方源只有 github.com，国内镜像优先 = 两个镜像在前。`errors.ts` 把 electron-updater 的错误归为 network / not_found / checksum / disk / unknown（网络类用 B1 的 `classifyNetworkError`；下载的 `status 404` 只出现在报错文字里，也认），技术信息只留一行：去掉查询串（GitHub 跳转地址带签名）、响应头和原始文件内容。`service.ts` 是状态机（idle / checking / up_to_date / available / downloading / downloaded / installing / error），下载从回答检查的源开始，连接失败、文件缺失、SHA-512 不符或 60 秒没有数据（看门狗取消）时换下一个源（审查后最后还会回头试排在前面的源，见下）；磁盘错误和用户取消不换源；取消回到“有新版本”且不报错；“立即重启安装”先停本地转写服务，再 `quitAndInstall(true, true)`（静默安装、装完重新打开，原来是非静默）；20 秒后还没退出就报“安装程序没有启动”（审查后改为提示“重启 FusionKit”，见下）。开发版（未打包）不创建 electron-updater、不联网，状态为 `unsupported`。
- IPC：`electron/main/update.ts` 改为通过 `window.appUpdate`（`src/app-update/contract.ts`、`electron/preload/app-update-api.ts`）提供 getState / check / download / cancelDownload / install / onState，只服务应用主框架；旧的通用通道 `check-update`、`start-download`、`quit-and-install` 和事件删除，`app-update:` 前缀在旧的通用 invoke/listen 桥上被拦截。没有调用方的 `download-installer` 保留原样（审查后删除，见下）。
- T4.1 界面（`src/components/update/`）：Windows 显示版本、安装包大小、更新日志和“下载并安装”；下载中显示进度条、已下载 / 总量、速度、“下载来源：GitHub / 国内镜像（ghfast.top）”和“取消下载”；下载完成显示“新版本已下载好”（已通过完整性检查，可“稍后”，退出时自动安装）和“立即重启安装”。macOS 给出“下载 DMG”（GitHub 标签路径，文件名以 `latest-mac.yml` 中本架构的 DMG 为准，没有时按 `${productName}_${version}_${arch}.dmg`）和“国内镜像下载”（ghfast；官方源模式不显示，镜像优先时排在前面），并说明替换后可能要在“系统设置 → 隐私与安全性”里点“仍要打开”。错误按“原因 + 下一步 + 按钮”显示（重试 / 打开网络设置 / 打开发布页），检查失败文案为“网络不通：连不上 GitHub，国内镜像也没有回应。可以稍后再试，或在“网络”设置中换下载源、开代理。”（官方源模式另有说法），技术信息折叠、可复制；启动时的自动检查失败不弹窗，只有发现新版本才弹；用户关掉对话框后，下载完成或失败会重新弹出。进度用项目的 `ui/progress`（模板遗留的 `update/Progress` 是固定 300px 宽、不适配深色，未用也未删）。更新日志依次试 raw.githubusercontent.com、jsDelivr、fastly.jsDelivr、ghfast（顺序随下载源设置，每个 8 秒，不是更新日志的页面算失败）。
- 四种语言新增 36 个键（每种语言 3863 个），改了 `start_download`、`install_now`、`downloading` 的文字；“网络”设置中下载源说明改为也用于应用更新，不再写“镜像不会改变文件内容”。
- T4.2：`vite.config.ts` 的主进程把 `package.json` 的 `dependencies` 全部设为外部模块；生产构建后主进程包只 `import` zod、yauzl、axios、chardet、iconv-lite、remark-frontmatter、remark-gfm、remark-parse、unified，并在运行时 `createRequire` 加载 electron-updater（及其旁边的 js-yaml）；预加载包除 electron 外全部打包。于是 `dependencies` 只保留这 10 个，其余 39 个（Radix、ai、lucide-react、mermaid、motion、shadcn、zustand 等）移到 `devDependencies`，写法不变。`gpt-tokenizer` 也被主进程用，但整包 52 MB、带全部编码，移到 devDependencies 后由 Vite 打进主进程包，只带用到的 o200k 编码（主进程包 3.9 MB → 6.2 MB）。`pnpm-lock.yaml` 用 pnpm 8.7.0 `install --lockfile-only --offline` 更新：lockfileVersion 仍为 6.0，结构对比确认没有新增、删除或重新解析的包，导入项只在两个分区之间移动（写法和版本相同），其余只有 668 处 `dev` 标记变化（生产包从 568 个降到 34 个，另有 44 个两边共用）。`node_modules` 没有重装（内容不变）。
- 来源审计：重新登记 `electron/preload/index.ts`（两份组合审计，`6e3e22c8…`），`package.json`（`8bb856e7…`）与 `pnpm-lock.yaml`（`3195d145…`）在 `current-source-audits.json`；`electron/main/index.ts` 未改（仍为 `0e26a280…`）。README 第 3 节表格与第 5 节已按实际实现更正。

**与方案不同之处**

- 没有沿用“GitHub provider 失败后切到 generic 源”：electron-updater 同一时间只允许一个检查，GitHub 卡住时没法按源限时，generic 源又按 `latest/download` 取文件，找不到旧版本 blockmap。改为一个自定义 provider 统一处理官方与镜像（官方同样走 `releases/latest/download/latest.yml`，与 GitHub provider 的 `releaseType: release` 一样只认正式版）。2026-10-17 用 curl 实测：github.com 与 ghfast.top 的 `latest/download/latest.yml`（带 `noCache` 查询）和 ghfast 的标签路径都返回正确文件；ghproxy.net 首页可达，但同样的文件 20 秒内没有回应（只影响它排在最后的回退）。
- 方案说“镜像靠 latest.yml 里的 SHA-512 保证安全”只对一半：检查由 GitHub 回答、下载改走镜像时，SHA-512 来自官方清单，镜像改不了安装包；但 GitHub 完全连不上、清单本身也来自镜像时，校验只能防止传输损坏和前后不一致，防不了镜像作恶。彻底解决要靠代码签名（D1 暂缓）。（审查后补充：“国内镜像优先”时镜像回答了就不会再问 GitHub，同样如此；清单里的管理员权限字段已改为忽略，见下。）
- 把主进程用到的 `gpt-tokenizer` 也移出了生产依赖（打包进主进程），见上。

**验证**

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 3863 个键，33 条“与源相同”警告都是旧字符串，所有源码中的键可解析）；`node scripts/subtitle-studio/check-boundaries.mjs`：641 个文件，无错误；`node --test scripts/packaging/*.test.mjs`：33 个通过（打包配置未改）。
- 新增单元测试 34 个全部通过：`test/app-update/service.test.ts` 14 个用真实的 electron-updater（Windows 更新器 + 测试用 app 适配器 + Node HTTP 客户端）对本机服务器：github.com 断开时经镜像检查并下载、校验文件 SHA-512 与请求的标签路径和 blockmap；官方源模式只连 github.com；镜像优先时不碰 github.com；单源限时与 HTML 页面换源；全部失败时逐源技术信息且不含查询串；全 404；已是最新；SHA-512 不符换源且不留下错误文件、全部不符报 checksum 后重试从头开始；中途断开与停止发数据换源；取消后可再下载；安装只调用一次静默安装；macOS 只给 DMG 链接、不下载；开发版完全不调用更新器。`sources.test.ts` 7 个（与 electron-builder 的 publish、mac artifactName 一致；各模式顺序；镜像下旧 blockmap 地址；更新日志镜像与 B1 表一致）、`errors.test.ts` 5 个、`ipc.test.ts` 3 个（只服务主框架、旧通道已删、测试开关只认未打包的 test 运行和本机 http、预加载方法固定）、`src/components/update/update-guide.test.ts` 5 个（各类错误都有中文原因、下一步和按钮；更新日志解析与逐个回退、超时）。
- 相关已有测试：`test/network test/app-update src/components test/projectMetadata.test.ts test/system test/model-setup src/store src/services` 共 54 个文件，53 个通过；`test/projectMetadata.test.ts` 仍因 CHANGELOG 缺 0.5.1 段失败（B1 起记录的原有问题），检查 `package.json` 中 electron / react 版本的用例通过。
- `pnpm pretest` 后静默窗口：新增 `test/update-dialog.electron.test.ts` 5 个通过（真实 electron-updater 走 Chromium 连本机服务器，更新日志请求在 Playwright 中本地应答，不连外网：启动检查经镜像发现新版本并自动弹窗 → 下载进度与来源 → 已下载 → 立即重启安装（只记录调用：静默、装完重开）；全部不可达时启动不弹窗，关于页手动检查显示网络原因、折叠的技术信息，“打开网络设置”跳到网络页；SHA-512 不符的说明与重试；macOS 的 DMG 与镜像链接、隐私与安全性说明、没有下载按钮；开发版说明）。截图在 `test-results/update-dialog/`，人工看过 786×540 浅色与深色：无横向溢出，看图后去掉了错误状态下底部重复的“打开发布页”。`test/e2e.spec.ts` 5 个、`test/onboarding.electron.test.ts` 2 个、`test/external-agent-settings.electron.test.ts` 1 个通过。
- 打包：`pnpm exec tsc --noEmit && pnpm exec vite build && node scripts/check-preload-bundle.mjs && pnpm exec electron-builder --config electron-builder.subtitle-studio.json --win nsis --publish never -c.directories.output=test-results/easy-setup-pack` 成功（缓存的 14.44 运行库被拒绝并自动重新下载 14.51.36247.0，18,731,856 字节，签名有效）。`app.asar`：299,310,342 字节、25,284 个文件（另 2,498 个目录）→ 26,122,277 字节、1,766 个文件（285 个目录）。安装包：B3 的包 321,756,833 字节（含 25.6 MB 的 14.44 运行库）→ 266,977,990 字节（含 18.7 MB 的 14.51 运行库），扣除运行库差异约小 48 MB；比 `release/0.5.1`（297,080,984 字节，没有运行库，未被改动）也小约 30 MB。
- 打包后实际启动（`test-results/easy-setup-smoke/smoke.mjs`，Playwright 以 `executablePath` 启动 `win-unpacked/FusionKit.exe`、`FUSIONKIT_TEST_WINDOW=quiet`、全新配置目录）：首页显示；网络、AI 模型、外部 Agent 三个设置页打开；字幕工作台资源管理列出 4 项资源；经典转换器把一个小 SRT 转成 VTT 且内容正确；关于页手动检查更新真实连到 GitHub，经自定义 provider 得到“已是最新版本”（最新 0.5.0，来源 official）；`resources/external-agent/fusionkit-mcp-stdio.cjs` 存在；主进程日志没有 “Cannot find module”，页面没有报错。结果与截图在 `test-results/easy-setup-smoke/`。
- 来源审计：`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`：16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。

**未做 / 未验证**

- 没有运行安装包，没有真的走一遍应用内更新（下载真实的新版本、静默安装、重新打开）；也没有用真实镜像下载安装包，没有验证真实 blockmap 的增量下载（单元测试里 blockmap 是 404，走的是整包下载的回退）。验收 A7 需要发布下一个版本后实测。
- macOS 没有打包和运行（本机为 Windows），macOS 流程只在测试开关下用 Windows 更新器模拟。帮助页（B5）还没有，macOS 说明暂时没有“查看帮助”链接。
- electron-updater 在下载被取消或中途断开时不关闭临时文件的写入句柄（直到进程退出）；下次下载会自动换一个临时文件名，不影响结果，单元测试在清理时关闭这些句柄。
- 打包冒烟时发现：`--user-data-dir` 用 8.3 短路径（如 `C:\Users\ADMINI~1\…`）时，共享语音资源的迁移检查会因真实路径不同而拒绝初始化（“Shared speech resource initialization failed.”，资源管理为空）；正常安装的配置目录是长路径，不受影响，冒烟脚本改用长路径。这是 HEAD 起就有的冻结代码行为，未改。另外冒烟中按拖放事件导入转换器文件没有生效，改用拖放区自带的文件选择框完成（B2 已记录 `tool-file-drop` 用例原有失败），未排查。
- `test-results/easy-setup-pack/` 已被本批的包替换（约 1.1 GB，可随时删除）；`dist/`、`dist-electron/` 现在是 `pnpm pretest` 的测试构建。没有跑完整 `pnpm test`。

### 2026-10-17 B4 审查后修正

三个角度的审查共 18 条，逐条对照代码核实。“检查失败原因只看最后一个源”与“安装没能开始后的处理”各被两路分别报告，合并处理，实际 16 个问题：14 个属实并已修正；1 个（镜像给的更新清单可信度，高）属实但只能部分修正，其余需要用户决定；1 个（`projectMetadata` 失败）是 HEAD 上原有的问题，不改。

- 镜像给的更新清单（高，部分修正）：核实属实。GitHub 连不上，或选了“国内镜像优先”且镜像回答了检查时，`latest.yml` 和其中的 SHA-512 都来自镜像，electron-updater 的校验只能防传输损坏，防不了镜像换成别的程序；原注释“镜像安全是因为 SHA-512”与此相反。已改：`provider.ts`、`contract.ts` 的注释照实说明；provider 交给 electron-updater 的文件信息一律把 `isAdminRightsRequired` 置为 false（安装包按用户安装，`nsis.perMachine: false` 由打包合同固定，electron-builder 从不写这个字段；原先一份伪造的清单能让安装程序经 `elevate.exe` 弹出管理员确认框；被换掉的安装程序自己仍可请求管理员权限，这一条只去掉了清单这条路）。没有照审查建议“镜像来的清单不许应用内安装”：这与验收 A7（GitHub 不可达时自动用镜像）和决定 D2 冲突。彻底解决要给 `latest.yml` 签名（发布时用私钥签，应用内置公钥核对，不需要买证书）或代码签名（D1），涉及私钥保管和发布流程，**需要用户决定**，已写入 README 第 5 节与“后续事项”。
- 检查失败的原因（低）：原来只按最后一个源的错误归类，GitHub 与 ghfast 都回答 404、ghproxy 超时时会说成“网络不通”。新增 `mostTellingFailure`（`errors.ts`）：明确回答“文件不存在”或“校验不符”的源优先，GitHub 的回答最优先，都没有时才说网络不通；检查和下载都用它，磁盘错误照旧立即报告。只在没有任何源回答时汇总；某个源回答了而 electron-updater 之后出错，仍按那个错误归类。
- 下载换源（低）：原来只往后换，排在回答检查的源前面的源（例如自动模式下检查时超时的 github.com）永远不试，注释却说“最后再试”。改为依次试后面的源，最后回头试前面的源。
- 安装没能开始（中、低）：“立即重启安装”先停下本地转写、字幕工作台、翻译资料等服务，之后安装失败时这些服务已不可用；而且安装程序一旦启动过，electron-updater 会忽略再次启动，原“重试”第一次什么也不做、第二次又开一个安装程序。改为：错误带 `installStage`，“没能先停下正在运行的功能”（`prepare`，还可以重试）与“安装程序没有启动”（`start`，不再给重试）分开说明，主按钮都是“重启 FusionKit”。新的 `appUpdate.restart`（`app-update:restart`，只服务主框架，只在安装失败后生效）关掉“退出时自动安装”后 `app.relaunch()` 并退出，避免安装程序与新进程抢；重启后启动检查会再次提示新版本。UI 测试用新开关 `FUSIONKIT_TEST_UPDATE_INSTALL_TIMEOUT_MS`（只认未打包的 test 运行）让记录下来的安装超时。
- 删除没有调用方的 `download-installer` 通道（低）：它接受清单里的完整地址、不检查调用方、旧版本信息也不清空。只为它服务的 `network/file-download.ts` 及其测试保留（B1 的走代理单文件下载，目前没有调用方）。
- macOS 说明（中）：改为先在程序坞里右键 FusionKit 选“退出”，再把新版本拖进“应用程序”并选“替换”；写出 macOS 12 的“系统偏好设置 → 安全性与隐私”；提示“已损坏”时给出与 CHANGELOG 相同的 `xattr -dr com.apple.quarantine /Applications/FusionKit.app`，带“复制命令”按钮。生产版本的应用菜单是空的，所以说明用程序坞，不用菜单栏“退出”。帮助页链接仍等 B5。
- 网络测试提示（低）：GitHub 连不上时，自动 / 国内镜像优先模式说“检查和下载更新会自动改用国内镜像”，官方源模式说“检查更新会失败，把下载源换成‘自动’”（新键 `test_hint_github_failed_official`）。
- 关于页（低）：原来固定显示“最新”。改为只在检查结果为“已是最新”时显示；发现新版本、下载中（百分比）、已下载时显示对应徽标，点击打开更新对话框（新事件 `UPDATE_OPEN_EVENT`，不重新检查）；没检查过或检查失败时不显示。
- 欢迎向导（低）：应用自己弹出的更新对话框（启动时发现新版本、下载在对话框关闭后结束）在向导打开时等它关闭再弹；向导后打开时也先让开。用户手动检查照常立即显示。
- 磁盘错误（低）：下一步补上“空间够时可能是杀毒软件拦截或文件被占用，重启电脑再试”，并加“打开下载页面”按钮。
- 安装前后的说明（低）：“新版本已下载好”写明正在进行的转写或翻译会被中断；“正在启动安装程序”写明安装时没有窗口、可能要一两分钟、装好会自动打开，请不要手动打开。
- 手动下载（低）：Windows 也按 `latest.yml` 算出安装包直链，下载或安装失败时在“打开下载页面”旁加“国内镜像下载安装包”（官方源模式不显示，检查失败时也不显示）；“打开发布页”改为“打开下载页面”，相关文案同步四种语言。
- 更新日志（低）：取不到时显示“更新内容暂时获取不到，可以到下载页面查看。”；取到的内容在本次运行内缓存，重新打开对话框不再等待。
- 测试缺口（低）：补上安装超时后只给重启、停服务失败后可重试、重启只在安装失败后生效、磁盘错误不换源、伪造的 `isAdminRightsRequired` 被忽略、下载回头试前面的源、多源失败时的原因汇总、`download-installer` 与旧通道已删除、对话框关闭后下载结束会重新弹出等用例。
- `gpt-tokenizer` 运行时（低）：新增 `test/main-bundle-tokenizer.electron.test.ts`，经主进程的 `estimate-subtitle-tokens` 算 token 预估，与直接用 gpt-tokenizer 包算的结果逐项相同，并且不同于编码出错时的粗略估算；设 `FUSIONKIT_PACKAGED_EXECUTABLE` 可改测打包后的 exe（配置目录里写入一个拒绝所有连接的自定义代理，不连外网），同时确认安装版加载了 electron-updater。
- 另：`download()` 原先靠上一轮下载的收尾回调放行，结束状态先于收尾送出，紧接着的重试会被忽略；改为只按阶段判断（下载开始前同步进入“下载中”）。
- 不改：`test/projectMetadata.test.ts` 因 CHANGELOG 没有 0.5.1 段失败，HEAD（76d60bd 已把版本改为 0.5.1）上就有，写发布说明时补。

审查后运行的检查：

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 3874 个键，新增 11 个；33 条“与源相同”警告都是旧字符串；源码中的键都能解析）；`node scripts/subtitle-studio/check-boundaries.mjs`：641 个文件，无错误；`node --test scripts/packaging/*.test.mjs`：33 个通过（打包配置未改）。
- `pnpm exec vitest run test/app-update src/components/update src/pages/Setting/components/networkTestHints.test.ts`：6 个文件、51 个用例通过；`test/app-update` 另跑 3 次，每次 38 个通过。`test/network test/app-update src/components test/projectMetadata.test.ts test/system test/model-setup src/store src/services src/pages/Setting`：57 个文件中 56 个通过，445 个用例中 444 个通过，失败的仍是上面的 `projectMetadata`。
- `pnpm pretest` 后静默窗口：`test/update-dialog.electron.test.ts` 7 个（新增：向导关闭后才弹出、更新日志取不到的说明、关于页徽标打开对话框且不重新检查；安装没能开始时只给“重启 FusionKit”且点击后记录一次重启；下载中关掉对话框、关于页显示“正在下载”、下载结束重新弹出；校验失败时的“打开下载页面”与“国内镜像下载安装包”；macOS 的退出、替换与复制命令）、`test/main-bundle-tokenizer.electron.test.ts` 1 个、`test/e2e.spec.ts` 5 个、`test/onboarding.electron.test.ts` 2 个、`test/external-agent-settings.electron.test.ts` 1 个，全部通过。截图在 `test-results/update-dialog/`（01–09），人工看过 786×540 浅色与深色，无横向溢出。
- 打包：`pnpm exec vite build && node scripts/check-preload-bundle.mjs && pnpm exec electron-builder --config electron-builder.subtitle-studio.json --win --dir --publish never -c.directories.output=test-results/easy-setup-pack` 成功；包内主进程包与当前构建逐字节相同（含 `app-update:restart`，不含 `download-installer`），`app.asar` 26,133,471 字节、2,051 项。`FUSIONKIT_PACKAGED_EXECUTABLE=…/win-unpacked/FusionKit.exe` 运行 tokenizer 用例通过（安装版的 token 预估与包本身一致，`appUpdate` 为 `in_app`）。之后重新 `pnpm pretest`，`dist/`、`dist-electron/` 恢复为测试构建。`release/0.5.1` 未被改动（297,080,984 字节，2026-10-17 15:07）。
- 来源审计：本轮没有改动受审计文件（`electron/main/index.ts` `0e26a280…`、`electron/preload/index.ts` `6e3e22c8…`、`package.json` `8bb856e7…`、`pnpm-lock.yaml` `3195d145…` 与登记值相同），无需重新登记；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`：16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。

**未做 / 未验证**

- 更新清单签名（或代码签名）没有做，等用户决定；在此之前，经镜像得到的清单仍只能防传输损坏。
- “重启 FusionKit”的真实 `app.relaunch()` 与退出、安装版里安装程序没有启动的情形、NSIS 静默安装都没有在本机执行；UI 测试用的是测试开关（记录重启、记录安装）。
- 没有重跑会连真实 GitHub 的打包冒烟脚本（`test-results/easy-setup-smoke/smoke.mjs`）；本轮的打包检查只连本机（代理拒绝所有连接）。没有生成新的 NSIS 安装包，`test-results/easy-setup-pack/` 里的安装包仍是 B4 的。
- macOS 仍未打包运行，程序坞“退出”与“替换”的说法按 macOS 的常规行为写，未在真机上核对各版本的按钮文字。
- 没有跑完整 `pnpm test`。

### 2026-10-18 B5 文案、帮助与安装指引（T5.1–T5.3）+ 更新清单加固（T5.4）

**做了什么**

- T5.4 更新清单加固（`electron/main/app-update/provider.ts`、`service.ts`，契约 `AppUpdateManifestTrust`）：检查由 github.com 回答时记为 `official`；先回答的是镜像时，同时向这次还没问过的源要 `latest.yml`（各自 15 秒限时，第一个足够的回答结束检查，其余请求取消）：github.com 的清单最优先（与镜像不一致时以它为准，下载仍从回答检查的镜像开始，镜像给的安装包过不了官方 SHA-512 就换源）；否则另一个镜像主机给出相同的 `releaseFingerprint`（版本 + 每个文件的名称、SHA-512、大小，忽略发布日期、说明、字段顺序和旧的单文件字段）记为 `mirrors_agree`；都没有记为 `unverified`。状态新增 `manifestTrust`（只在 Windows 应用内安装时有），`download()` 只接受 `official` / `mirrors_agree`，所以界面以外的调用也装不了未印证的版本。macOS 不做额外请求。更新对话框在 `unverified` 时显示“这次不能在应用内安装”和“为了安全，镜像来源无法互相印证时不会自动安装……”，底部只有“重新检查”“国内镜像下载安装包”“打开下载页面”，没有“下载并安装”；`data-trust` 供测试读取。镜像优先模式下现在也会向 github.com 要一次 `latest.yml`（只为印证，下载仍走镜像），原测试“镜像回答时从不连 github.com”随之改为“github.com 只收到一次清单请求、安装包不从它下载”。
- T5.2 帮助页：新增 `src/pages/Help/`（`index.tsx`、`helpNavigation.ts`）与 `help` 命名空间（四种语言各 82 个键）。路由 `/help`，底部导航新增“帮助”（主页、工具、帮助、关于、设置），`App.tsx` 的方向顺序同步。八个条目：三步上手（打开模型设置 / 打开本地资源 / 回到首页、“重新打开新手引导”）、打不开怎么办（macOS“无法验证开发者”→ 隐私与安全性 → 仍要打开，macOS 12 的写法；“已损坏”→ `xattr` 命令带“复制命令”并说明只去掉下载标记；Windows SmartScreen → 更多信息 → 仍要运行；更新后可能要再放行）、模型与费用（密钥是什么、推荐 DeepSeek 与获取 Key / 去充值、Token 和费用、哪些内容会发出去、用其他服务）、下载失败（下载源、镜像按校验值核对、更新须两源印证、还是下不动）、转写失败（VC++ 运行库一键修复、磁盘空间、显卡加速与驱动 551.61、CPU 也能转写）、代理设置（系统代理是什么、Clash、自定义代理格式、测试）、外部 Agent、系统要求。其他地方用 `helpPath(section)` 打开 `/help?section=<id>`（HashRouter，用查询参数），页面滚到 `#help-<id>` 并短暂高亮；目录按钮平滑滚动并更新地址。`open_help` 接入：`ai-error-guide`（只在真实请求的错误下：密钥 / 余额 → 模型与费用，网络 / 代理 → 代理设置；配置对话框与新手引导里不出现）、`update-guide`（网络与校验失败 → 下载失败）、macOS 更新说明的“查看帮助”（→ 打不开怎么办）、镜像未印证说明（→ 下载失败）、`VcRuntimeNotice` 新增 `onHelp`（经典转写页、工作台转写页与资源管理里显示，新手引导和下载前的运行库对话框里不显示）、工作台资源行的下载 / 校验 / 运行库失败、经典转写错误。`scripts/subtitle-studio/boundaries.json` 登记 `src/pages/Help/helpNavigation.ts`（工作台经 `ai-error-guide` 等间接用到）。旧首页 `/home-classic` 的“本地处理数据，无需上传云端”改为“本地转写不上传音视频，AI 翻译会把字幕或文本发送到你配置的模型服务”（标题“隐私可控”）。
- T5.1 文案与错误：经典转写页（冻结的只有 `index.tsx`，经核对 `LocalSubtitleErrorNotice.tsx`、`LocalSubtitleEnvironmentManager.tsx` 不在冻结清单里，`generate.mjs --check-worktree` 列出的变化文件里没有本批改动的文件，都是此前已在来源审计中登记的）：`LocalSubtitleErrorNotice` 改为按错误码显示原因与下一步（新增 `localSubtitleErrorGuide.ts`，为 `LOCAL_SUBTITLE_ERROR_CODES` 的 53 个码给出原因（环境、共享资源占用、翻译交接、无人声各用已有文案；审查发现其中 9 个只落到通用说明，审查后补齐，见下），下载 / 校验类带“打开网络设置”，下载 / 校验 / 运行类 / 显卡 / 磁盘带“查看帮助”，原文与 code、stage、field 收进折叠的“诊断信息”并可复制；没有错误码的消息照原样显示（审查后改为：只保留页面自己写给用户的两句话，其余放进诊断信息，见下）。“源码运行请重新组装……”拆成 `recovery_dev`，只在 `import.meta.env.DEV` 时附在后面。语言文件改写：经典转写的“语音活动检测 / VAD 资源 / VAD 静音 / Beam 数量 / 初始提示词 / 服务合同 / Whisper 运行器 / 运行时详情 / 后端探测 / 正在解析执行后端 / 未验证 / 托管资源 / 正在检查运行兼容性 / 正在提交资源 / GPU 加速组件 / CUDA 资源”和各环境错误、就绪提示；经典字幕翻译的用量提示（不再提 usage 字段，第一次出现处说明 Token）、“API 地址”“推理 Token”“Usage 覆盖请求”；字幕工作台的“上下文窗口（tokens）”“每批输出上限（tokens）”及相关提示、预计用量、实际用量、“tokens”单位、“API 密钥”，并在转写和翻译的“高级设置”顶部各加一句说明（搜索宽度 / 温度 / 最短静音；Token 是什么）；“已达每批输出上限……”改用新字段名；设置页“请先设置 API Key”等三条与外部 Agent 说明；长文本翻译的上下文窗口提示；文件名翻译的“模型鉴权失败”；Agent 用量面板新增一句 Token 与上下文占用的说明和“了解 Token 与费用”（→ 帮助）。四种语言同步，共新增 142 个键（每种语言 4016 个）。
- T5.3 文档与官网：README（中英）新增 0.5.1 开发版本提示（与 CHANGELOG 的“开发中”配套，`projectMetadata` 测试的要求）、“系统要求”“打不开怎么办”，“首次使用”改为新手引导、一键准备、下载源与镜像核对、VC++ 自动处理、系统代理、Windows 应用内更新；隐私表的“检查更新”一行写明镜像与印证规则。CHANGELOG 新增 `## [0.5.1] - 开发中（更新于 2026-10-18）`，按原有分类列出 B1–B5 用户可见的变化（`test/projectMetadata.test.ts` 自 B1 起的失败随之消除）。官网 `website/src/content.ts`（中英）三步上手改为新手引导流程，下载区新增“系统要求”和“打不开怎么办”（`Download.tsx` 新增两张卡片与可复制命令，锚点 `#cannot-open`）。DMG：新增 `build/dmg/打不开请看这里.html`（中英、无外部资源，命令可复制，复制不可用时可点选后 ⌘C），`electron-builder.subtitle-studio.json` 的 `dmg` 加 `window` 540×420 与三项 `contents`（应用 140,170；/Applications 链接 400,170；说明文件 270,320；审查后改为与默认背景对齐的 540×380，见下）；打包合同新增 `DMG_HELP_FILE`、`DMG_WINDOW`、`DMG_CONTENTS` 并要求完全一致。
- 设计文档 README 第 1、5、6 节与“后续事项”按实际实现更新：清单签名改写为待决定的 Ed25519 方案（维护者持私钥、发布时上传签名文件、应用内置公钥），在此之前用 T5.4 的印证规则；任务表新增 T5.4。

**与方案不同之处**

- 方案写帮助页是“lazy page like others”，实际其他页面都是直接引入（`App.tsx` 没有懒加载），帮助页照现有写法直接引入。
- 入口放在底部主导航（第 5 项），而不是关于页或设置页；786 宽下不拥挤。
- 工作台的搜索宽度、温度、上下文提示原本就在“高级设置”里，没有再移动，只加了一句说明；经典转写页这些参数的显示在冻结的 `index.tsx` 里，只改了名称。
- 镜像优先模式下 github.com 也会收到一次清单请求（为了印证）；B4 的“镜像优先时不碰 github.com”不再成立。
- 方案建议“官方发布页 + 镜像链接”作为手动下载入口，照做；镜像链接下载的安装包同样无法由 FusionKit 核对，说明里请用户能打开 GitHub 时优先从 GitHub 下载。

**验证**

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 4016 个键，33 条“与源相同”警告都是旧字符串，源码中的键都能解析）；`node scripts/subtitle-studio/check-boundaries.mjs`：642 个文件，无错误。
- 单元测试：`test/app-update` 5 个文件 46 个通过（新增 `provider.test.ts` 4 个：指纹忽略日期 / 顺序 / 旧字段、对版本 / 文件名 / SHA-512 / 大小 / 文件列表敏感、镜像主机互不相同且不是 github.com；`service.test.ts` 新增 5 个：单个镜像被篡改 → `unverified`、不下载、不安装、给出链接；两个镜像说法不一致 → `unverified`；两个镜像写法不同但内容相同 → `mirrors_agree` 且能下载；镜像优先时 github.com 的清单压过篡改的镜像，篡改的安装包过不了校验、换源后存下的是真安装包；官方回答时只请求一次清单 → `official`；原有用例按新行为补充断言）；`src/pages/Help/helpNavigation.test.ts` 3 个、`localSubtitleErrorGuide.test.ts` 5 个（全部错误码在四种语言都有原因、原因里没有错误码或开发者术语、按钮与帮助条目、开发提示只在 `recovery_dev`、诊断信息）、`ai-error-guide.test.ts` 7 个、`update-guide.test.ts` 8 个。较大范围 `pnpm exec vitest run src test/app-update test/network test/system test/model-setup test/projectMetadata.test.ts test/ai test/subtitle-studio/boundaries.test.ts --maxWorkers=4 --minWorkers=1`（只写 `--maxWorkers=4` 在 20 核的本机会报 `minThreads and maxThreads must not conflict`，一个测试也不跑）：157 个文件、1361 个用例全部通过（`projectMetadata` 现在通过）。
- `node --test scripts/packaging/*.test.mjs`：34 个全部通过（新增 DMG 说明页自包含、中英步骤与命令各一份的用例；合同篡改用例新增 9 种 DMG 改动，真实 electron-builder `getConfig` + `validateConfig` 接受新的 `dmg` 配置）。macOS 不能在本机打包，DMG 只经合同与配置校验。
- `pnpm pretest` 后静默窗口：新增 `test/help.electron.test.ts` 2 个通过（底部导航进入帮助、八个条目与锚点、目录跳转并写入地址、`?section=` 直达并在可视区内、复制命令后读剪贴板一致（测试前后保存并恢复剪贴板）、重新打开新手引导；经本机假更新源让手动检查失败，点指引里的“查看帮助”关掉对话框并停在“下载失败”且高亮；macOS 更新说明的“查看帮助”到“打不开怎么办”）；`test/update-dialog.electron.test.ts` 8 个通过（第一个用例改为三个源、断言 `mirrors_agree`；新增镜像未印证：说明、无“下载并安装”、发布页与镜像链接地址、无任何安装包请求、“查看帮助”）；`test/e2e.spec.ts` 5 个、`test/onboarding.electron.test.ts` 2 个、`FUSIONKIT_STUDIO_RESOURCE_UI=1` 资源对话框 3 个（失败行断言改为只比对说明文字并检查新增的“查看帮助”）、`FUSIONKIT_TRANSCRIPTION_EMPTY_UI=1` 经典页 2 个、`FUSIONKIT_STUDIO_E2E=1` 的翻译、翻译恢复、删除译文记录、AI 修订、结构修订 5 个文件 6 个用例通过（这些用例里写死的旧文案“上下文窗口（tokens）”“实际 tokens”“本次用量 … tokens”“原模型配置缺失……”等随文案改为新写法，结构修订里“不显示用量”的否定断言放宽为同时匹配 Token / tokens，没有删掉）。截图在 `test-results/help/`、`test-results/update-dialog/10-*`，人工看过 786×540 浅色与深色：无横向溢出。
- 官网：`cd website && pnpm build` 通过（含 `tsc --noEmit`）；用隐藏的 Electron 窗口截了 1280 浅色、786 深色、390 英文浅色的下载区，看图后把命令改为按空格换行、按钮在窄屏换到下一行。没有部署。
- 来源审计：本批没有改动受审计文件（`electron/main/index.ts` `0e26a280…`、`electron/preload/index.ts` `6e3e22c8…`、`package.json` `8bb856e7…`、`pnpm-lock.yaml` `3195d145…` 与登记值相同，经典转写页 `index.tsx`、`vite.config.ts` 未改），无需重新登记；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`：16 个文件通过、2 个跳过，233 个用例通过（与基线一致）。

**未做 / 未验证**

- 没有跑完整 `pnpm test`，没有打包；DMG 布局与说明文件在 macOS 上的实际显示（图标位置、中文文件名）没有验证。
- Agent 用量面板新增的说明行没有界面测试覆盖，只经类型检查（面板只在有过模型调用后出现）。
- 印证规则依赖第二个镜像：B4 实测 ghproxy.net 经常 20 秒内不回答，GitHub 连不上时 Windows 版可能常常只能手动更新；彻底解决要靠清单签名（待决定，见 README 后续事项）。镜像与 GitHub 的真实表现、中国大陆网络下的体验没有实测。
- 帮助页里各系统按钮的文字（如“仍要打开”“强制打开”“このまま開く”）按 macOS / Windows 的常见译法写，没有在各语言的真机上逐一核对。
- 经典转写页高级参数（搜索宽度、温度）的说明只能改名称，冻结的页面里没法加说明行。

### 2026-10-18 B5 审查后修正

三个角度的审查共 22 条，逐条对照代码核实。“经典转写错误提示丢掉页面自己的文案”被两路分别报告，“未印证时的镜像链接”也被两路分别报告，各合并为一项，实际 20 个问题：14 个属实并已修正（其中“未印证时的镜像链接”只改了说明，原因见下；报告里的测试命令缺 `--minWorkers=1` 已在上面的记录中改正）；5 个是本批没有改动的代码里的失败，不改；1 个（未纳入版本库的文件）留给提交时处理。

**经典转写的错误提示**

- 页面自己的文案被换掉（中）：冻结的 `index.tsx` 会带着错误码传入自己写好的中文，例如“本地字幕组件刚刚更新……请重新启动 FusionKit”（`runtime_protocol_mismatch`），原先被换成“转写程序损坏或版本对不上 + 请更新或重新安装”。冻结页面没法加参数，所以 `localSubtitleErrorView` 按当前语言的译文认出这两句：重启提示原样显示，不再给重装建议；“无法交接该字幕。”作为标题，下面是错误码的原因与下一步。环境检查（`EnvironmentErrorNotice`）改为传原始错误和自己的原因（`cause`），环境以外的码仍显示“无法完成本地运行环境检查。”，主进程原文进诊断信息（以前诊断里只有译文）。
- 9 个码只有通用说明（中、低）：`invalid_ipc_request`、`owner_released` → “页面和本地转写服务之间的连接已经失效，请重启”；`configuration_required`、`profile_unavailable` → 缺翻译配置，带“打开模型设置”“打开字幕翻译”；`duplicate`、`unsupported_format`、`import_failed` 各有说明；`estimate_failed`、`start_rejected` → “已加入字幕翻译，但没有自动开始”。交接类带“打开字幕翻译”。测试改为要求每个码都不是通用说明（原测试即使映射表为空也会通过）。`preview` 一组的原因改为不提“预览”，交接失败时也说得通。
- 没有错误码的英文原样显示（中）：抛出的异常（`Error invoking remote method …`）和页面里的英文占位句改为显示通用原因与下一步，原文只进可复制的诊断信息；产物预览对话框读取异常时原因为“无法读取字幕内容。”。
- “改用 CPU 重试”按钮常常不存在（中）：运行崩溃、显卡、转写三组的下一步拆成两种，只有任务详情里且该任务真有这个按钮（`cpuRetryAvailable`）时才提到它；页面上方的错误、资源下载错误都用不提按钮的说法（再试一次 / 把“计算设备”改成 CPU / 换个模型）。
- 术语与“标准”模型（中）：经典页资源列表改用字幕工作台的友好名称（`resourceDisplayName`，原名放在说明行，`data-testid="local-subtitle-catalog-name"`，导入匹配和删除确认也用友好名称）；模型说明 `model_details` 只写“模型大小：…”，不再显示 GGML、Q5_0（冻结页面仍传这两个参数，不影响）；内存不足的下一步改为“换一个体积较小的模型”。冻结页面的模型下拉框仍显示目录原名（如 `large-v3-q5_0`），改不了。

**更新**

- 镜像给的清单格式不对时主进程出现无人处理的 Promise 拒绝（低）：`parseUpdateInfo` 现在要求 `files` 存在时必须是带字符串 `url` 的对象列表（`files: [null]`、`files: "x"` 等整份不认）；印证时比较指纹的回调不再可能抛出，链尾加了 `catch`。新增解析测试 2 个，以及服务测试“第二个镜像清单格式不对 → 未印证、没有未处理的拒绝”；把修正临时撤回后这个用例失败（`TypeError: Cannot read properties of null (reading 'url')`），恢复后通过。
- 未印证时的镜像链接（低，两路）：属实，链接多半指向没被印证的那个镜像。保留链接（方案要求“官方发布页 + 镜像链接”，而这时多半连不上 GitHub，去掉后只剩“稍后重新检查”；换成另一个镜像也不更安全：两个镜像说法不一致时不知道哪个对），说明里加一句“‘国内镜像下载安装包’拿到的文件同样没有经过核对，能打开 GitHub 时请优先从 GitHub 下载”（四种语言），镜像按钮仍是次要样式。界面测试检查这句话。

**DMG、帮助页与文案**

- DMG 布局（低）：没设背景，dmg-builder 用自带的 540×380 背景图（箭头在 y≈223），原布局 540×420、图标在 y=170 与箭头错开，底部 40 px 没有背景。改为窗口 540×380，应用和“应用程序”回到默认的 (130,220)、(410,220)，说明文件在上方 (270,80)。打包合同同步，新增测试从 `dmg-builder/templates/background.tiff` 读出尺寸与窗口比对，并检查说明文件的图标和两行标题落在箭头上方的空白里。macOS 上的实际显示仍未验证。
- 从提示进入帮助后回不去（低）：带 `?section=` 且有历史记录打开帮助页时，标题上方显示“返回”（复用 `common:menu.back`），回到点“查看帮助”前的页面；目录跳转用 replace，不影响返回。从底部导航进入时不显示。帮助页界面测试补了这两种情况。
- “这一页可以直接转发给朋友”（低）：应用内页面转发不了，改为请用户把官网 fusionkit.vercel.app 发给朋友（下载区有“打不开怎么办”和系统要求；日文注明官网只有中英文）。
- 漏改的文案（低）：工作台 AI 修订与一致性检查的“输出上限”改为“每批回答的最大长度”（四种语言）；Agent 准备翻译卡片的“tokens”改为“Token”（日文“トークン”）；长文本翻译串行费用提示的“语义记忆 token”改为“记忆 Token”。
- 官网先于 0.5.1 上线（低）：官网在 `main` 更新时自动上线，而下载按钮给的是最新正式版。写入 README“实现约束”：`main` 只在发布 0.5.1 时快进，不能提前合并。

**不改**

- `experience-transcription-ui`（I5）第三次拖入失败：B3 审查已在 HEAD 76d60bd 的快照上复现同样失败，是原有问题。
- `shared-ui`（T09）在 esbuild 处失败：测试自己的构建没有 `?raw` 加载器，来自外部 Agent 的改动。另用加了加载器的临时副本（`test-results/b5-review/t09/`，未改仓库里的测试）跑通了 1 个用例，经典页资源行显示“标准（推荐，约 1.0 GB）”“最高精度（约 2.9 GB，较慢）”，说明行是原名。
- `tool-navigation`（`/external-agent` 按 Esc）、`tool-file-drop`（转换器拖入）、`agent-sessions`（提示框残留）：B2 审查已记录的原有失败。
- 未纳入版本库的文件：提交时要一起加入本批所有新文件，至少 `build/dmg/打不开请看这里.html`、`src/pages/Help/`、`src/locales/*/help.json`、`src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleErrorGuide*.ts`、`src/components/update/update-guide*.ts`、`src/services/ai-error-guide*.ts`、`electron/main/app-update/`、`src/app-update/`、`test/app-update/`、`test/help.electron.test.ts`，提交后用 `git show --stat` 核对。

审查后运行的检查：

- `pnpm exec tsc --noEmit` 通过；`pnpm i18n:check` 通过（每种语言 4032 个键，新增 16 个；“与源相同”警告从 33 条降到 31 条（`model_details` 不再是同一串）；源码中的键都能解析）；`node scripts/subtitle-studio/check-boundaries.mjs`：642 个文件，无错误。
- `pnpm exec vitest run src/pages/Tools/Subtitle/LocalSubtitleTranscriber`：7 个文件、65 个用例通过（`localSubtitleErrorGuide.test.ts` 12 个）；`test/app-update`：5 个文件、49 个用例通过；较大范围（命令同上，带 `--minWorkers=1`）：157 个文件、1371 个用例通过。
- `node --test scripts/packaging/*.test.mjs`：35 个通过。
- `pnpm pretest` 后静默窗口：`test/help.electron.test.ts` 2 个、`test/update-dialog.electron.test.ts` 8 个、`test/e2e.spec.ts` 与 `test/onboarding.electron.test.ts` 7 个、`FUSIONKIT_TRANSCRIPTION_EMPTY_UI=1` 经典页 2 个、`FUSIONKIT_STUDIO_E2E=1` 的 `i1-coexistence-ui` 与 `cue-revision-ui` 3 个，全部通过；另用临时脚本看了经典页 786×540 浅色中文与深色英文：环境错误显示原因、下一步和“诊断信息”，无横向溢出。
- 来源审计：没有改动受审计文件；`shared-resource-integration.mjs`、`shared-resource-extraction.mjs` 均 exact；`generate.mjs --check-worktree` 只列出此前已登记的文件；`test/subtitle-studio-provenance` 结果见下一行。
- `node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`：16 个文件通过、2 个跳过，233 个用例通过、3 个跳过（与基线一致）。
- 未验证：macOS 上 DMG 的实际显示；经典页没有界面测试覆盖“无法交接该字幕”与 CPU 重试两种说法的实际显示（只有单元测试）；没有跑完整 `pnpm test`，没有打包。

### 2026-10-18 收尾修正（完整测试与完整性审查之后）

输入有两份：一是完整测试。在 `pnpm pretest` 之后跑了全量 vitest、32 个界面开关下的 74 个界面测试文件，并在 HEAD 76d60bd 快照上对照。二是完整性审查，对照 A1–A8 和方案逐条核对，列出 25 条缺口。完整测试没有发现回归：全量里的 4 个失败都是负载下的超时或计时，单独重跑都通过。17 个门控界面失败和 `development-ui` 在 HEAD 快照上也是同一断言失败。审查标为“现在就能修”的缺口逐条处理如下。上一轮修正会话在 04:49–05:00 写完了大部分改动，随后异常中断，没有留下记录。本轮先逐个文件复核了那些改动（有改动的文件对照 `git status` 与修改时间找出），再补上其余部分，最后整体重新验证。

**字幕工作台的错误说明（中，两条）**

- 转写任务失败：新增 `src/pages/Tools/Subtitle/SubtitleStudio/transcription-errors.ts`，任务行改用 `TaskFailure`。错误码分成 19 组（转写程序不完整、系统不支持、程序崩溃或无响应、显卡加速、模型没装好、模型加载失败、不在允许列表、资源被占用、磁盘、内存、文件授权失效、读不出声音、没有音轨、原文件被改动、转写没完成、超出上限、结果没能保存、被中断、页面连接失效），每组有自己的原因和下一步。说法用工作台自己的控件名：“管理资源”“处理设备”“一键准备”。相关的组带“管理资源”“查看帮助”按钮，帮助分别对应“转写失败”或“系统要求”条目。缺微软运行库、而错误又可能由它引起时，先说运行库。只有这个版本不认识的错误码才显示原来的通用说明，并给出“复制诊断信息”：只复制错误码、模型和设备，不含路径或文件名。
- 资源行：`resourceErrorGuide` 保留原有的网络、磁盘、校验、导入、运行库、语音检测说法，新增几类各自的说明：显卡加速包（`accelerator_unavailable`、`backend_mismatch`、`backend_unverified`）、运行库正常时的加载检查失败（`runtime_crashed`、`runtime_unresponsive`、`model_incompatible`）、转写程序不完整、不在允许列表、内存不足、页面连接失效，以及资源被占用（沿用 `shared_busy_error`）。通用的“资源操作失败，请重试。”改为“资源操作没有完成……可以点‘复制诊断信息’”，只用于不认识的码。新增文案四种语言齐全（连同下面几条，每种语言的键数从 4032 增至 4081）；本轮把英文“一键准备”的按钮名改成与界面一致的“Prepare in one click”。
- 测试：`transcription-errors.test.ts` 共 7 个用例，覆盖两点。一是 `LOCAL_SUBTITLE_ERROR_CODES` 和工作台错误码里，凡是能让任务结束的码，都有自己的原因和下一步，四种语言里都没有错误码或开发者用语。二是资源行在下载、导入、语音检测、缺运行库四种情况下都有文案。界面测试两处：`interaction-queue-ui` 第 7 行的夹具以 `runtime_protocol_mismatch` 失败，检查行内显示原因、下一步、“查看帮助”，且不出现“复制诊断信息”；`transcription-empty-result-ui` 改为检查具体原因，不再检查通用句。

**其余缺口（低）**

- 更新下载中途断网：`update-guide.ts` 中，下载阶段的网络错误在“重试 / 网络设置 / 帮助”之外加上“下载页面”，镜像模式下另加“国内镜像下载安装包”。下一步用 `network_next_download` 的新说法（提到下载页面），四种语言；`update-guide.test.ts` 已覆盖。
- Agent：转写确认卡片把模型 id 显示为易懂名称（`resourceNameKey(..., 'short')`，如“标准”），不认识的模型保留 id。准备转写如果因为 `runtime_not_ready`、`model_not_ready`、`vad_not_ready` 或 `accelerator_not_ready` 失败，结果里附带 `nextAction`，告诉 Agent 可以提议打开资源管理用一键准备。`open_app_page` 新增三个去处：`subtitle_studio` + `studioView: resources`（即 `studioResourcesPath()`）、`network_settings`（`/setting?tab=proxy`）、`help`。本轮还补了一处：几个设置页共用 `/setting` 路由，原来停在“AI 模型”页时打开 `network_settings`（或 `agent_settings`）会被当作“已经打开”而不切换分页。现在按窗口地址里的 `tab` 判断，测试环境读不到地址时行为不变。这顺带修好了 `agent_settings` 的同一问题，属于同一机制里原有的小毛病。测试：`navigation-tools.test.ts` 新增 2 个，`modern-tools.test.ts` 新增 1 个（就绪检查的 mock 改为可以给出原因）。
- 新手引导：选“我用 Claude Code、Codex 或 Cursor”后不再直接离开，先进入本地转写一步，并说明外部 Agent 通过 FusionKit 转写时也要用到这些资源。完成页第一项是“连接 Claude Code、Codex 或 Cursor”，底部按钮改为“打开外部 Agent 设置”。`onboarding.electron.test.ts` 第二个用例补上这条路径：本地步骤显示说明 → 稍后 → 完成页卡片 → 进入“外部 Agent”分页，无横向溢出，并截图 `07b-external-done-zh-dark-1080x786`。
- 模型设置：删除已经不会运行的“Agent 暂不支持 Responses API”分支，以及它用到的 3 个键（四种语言）。刷新模型列表失败时，用 `classifyModelError` + `modelErrorGuide(..., 'connection_test')` 在提示里给出原因和下一步，与“测试连接”相同。安装版不再理会测试开关：`resolveModelSetupLaunchConfig` 增加 `packaged` 参数，默认取 `app.isPackaged`；安装版里 `NODE_ENV=test` 不算测试构建，`FUSIONKIT_TEST_DEEPSEEK_BASE_URL` 不会生效，向导的密钥只会发往 DeepSeek。`FUSIONKIT_TEST_WINDOW` 在安装版里仍让向导保持关闭，它只能关闭向导、不能改去向，打包冒烟测试要用它。`test/model-setup/ipc.test.ts` 补了这些情况。
- Token 帮助链接：工作台翻译的高级设置和经典字幕翻译的用量统计，各加一个“了解 Token 与费用”（`common:action.token_help`），指向帮助页“模型与费用”。
- NVIDIA 驱动链接：`nvidiaDriverUrl(language)` 让繁中、英、日打开 nvidia.com 对应语言的页面，简中和不认识的语言保留 nvidia.cn。测试在 `resource-names.test.ts`。
- 文档与官网：安装后的大小从“约 1.1 GB”改为“约 850 MB”，共 7 处：README 中英、官网中英、帮助页四种语言；设计文档同步。依据是本轮打包的 `win-unpacked` 实测 878,668,270 字节。README 隐私表（中英）新增“下载转写资源与更新日志”和“网络测试”两行，写明第三方镜像、只请求文件、按大小和 SHA-256 核对。CHANGELOG 有三处改动：“当前范围”补两条，一是默认跟随系统代理后，系统代理指向已关掉的代理软件时请求会失败、该怎么办，二是更新到 0.5.1 时可能弹一次运行库确认框；“优化”新增一条 Agent、模型列表、NVIDIA 链接的变化；新手引导和 Token 的描述同步。官网和帮助页中“macOS 更新以后”的歧义说法，改为“在 macOS 上换成新版 FusionKit 后”。官网的“无法验证开发者”补上 macOS 12 的“系统偏好设置”路径。DMG 说明文件的标题同步。
- DMG 说明文件的名字：仓库里的文件名不变，用 `dmg.contents` 的 `name` 在 DMG 里显示为中英双语的“打不开请看这里 Can't open.html”。dmg-builder 会为 dmgbuild 转义引号；electron-builder 的 schema 支持 `DmgContent.name`，本轮的 Windows 打包读取配置时通过校验。打包合同新增 `DMG_HELP_NAME`，篡改用例新增“改名”“删掉名字”两种。README 中英相应改了一句。
- 设计文档 `README.md`：第 1、2、4、6 节按以上实现更新，包括 DMG 名称、外部 Agent 路径、Agent 的出路、工作台错误说明。

**过时的原有测试（与 easy-setup 无关，只改测试）**

- `test/subtitle-studio/development-ui.test.ts`：3855c2c（2026-09-12）以后，“下载原文件”先打开对话框，默认保存到来源文件所在目录，而这个测试最后一次修改是 2026-09-11。现在测试在对话框里选“选择其他位置” → “保存原始文件…”，确认提示和文件内容，再点“完成”。产品代码没有改。

**不改（需要决定或真实环境）**

- A7 更新清单签名（Ed25519）待决定；在此之前 GitHub 连不上、ghproxy.net 又不回答时，Windows 版只能手动更新。
- 在真实环境里，以下都没有执行过：macOS 打包和 DMG 的实际显示（含新名字是否折成两行）、NSIS `customInstall`、`vc_redist` 静默安装、UAC 修复、静默更新与 `app.relaunch`、全新虚拟机上的转写（A5）、大陆网络不开代理的下载（A4）、真实 Clash/PAC（A6）、真实 DeepSeek 密钥（A2、A3）。没有运行任何安装包或运行库安装程序。
- 冻结的经典转写页：资源行下载前不检查运行库，模型下拉框显示目录原名，搜索宽度和温度没有说明，这些都没有改。工作台“仍要下载”的确认框已经写明“缺少它的话，下载完也用不了”。
- 0.5.1 写入的严格结构新增了可选字段，手动降级到 0.5.0 后可能读不了，算不算设计取舍需要决定；官网首次下载安装包是否提供国内镜像也需要决定。
- 发布时要去掉 README 的开发版本提示、给 CHANGELOG 标上日期。提交时要加入全部新文件：B5 列出的那些，加上本轮的 `src/pages/Tools/Subtitle/SubtitleStudio/transcription-errors.ts`、`transcription-errors.test.ts`、`resource-names.test.ts`，提交后用 `git show --stat` 核对。
- 原有失败（本轮未修，与 HEAD 快照相同）：`interaction-queue-ui`（现第 206 行，“取消任务”提示框没有出现；HEAD 上是第 200 行，测试文件在此之前多了 6 行）、`agent-sessions` 残留提示框、`tool-navigation` 在 `/external-agent` 按 Esc、`tool-file-drop` 转换器拖入、`tool-spacing` 的 6 px 标题内边距、`export-ui` 按 Esc 后焦点、`acceptance-files-ui` 静默窗口的 innerHeight、I3 / I5 / I7 的几处、`library-ui`、`transcription-bridge`、`materials-layout-electron`、`dialog-content-motion` 的帧阈值、T09 `shared-ui` 的 `?raw` 加载器。它们都涉及时序或产品行为，不属于“过时的期望”，没有改。

**验证**

- `pnpm exec tsc --noEmit`：通过，没有输出。`pnpm i18n:check`：通过，每种语言 4081 个键，31 条“与源相同”警告，源码中的键都能解析。`node scripts/subtitle-studio/check-boundaries.mjs`：644 个文件，没有错误。`website` 的 `tsc --noEmit -p tsconfig.json`：通过。
- `node node_modules/vitest/vitest.mjs run src test/app-update test/network test/system test/model-setup test/projectMetadata.test.ts test/ai test/subtitle-studio/boundaries.test.ts --maxWorkers=4 --minWorkers=1`：158 个文件、1383 个用例全部通过。文档改完后又跑了一次，结果相同。
- `node --test scripts/packaging/*.test.mjs`：35 个全部通过。
- 来源审计：本轮没有改动受审计文件，`electron/main/index.ts` `0e26a280…`、`electron/preload/index.ts` `6e3e22c8…`、`package.json` `8bb856e7…` 都与 B5 相同。`node node_modules/vitest/vitest.mjs run test/subtitle-studio-provenance`：16 个文件通过、2 个跳过，233 个用例通过、3 个跳过，与基线一致。
- `pnpm pretest` 之后跑静默窗口（`FUSIONKIT_TEST_WINDOW=quiet`）：
  - `onboarding`、`help`、`update-dialog`、`e2e.spec` 共 4 个文件、17 个用例全部通过。
  - 带开关 `FUSIONKIT_STUDIO_RESOURCE_UI`、`FUSIONKIT_STUDIO_I6_QUEUE_UI`、`FUSIONKIT_TRANSCRIPTION_EMPTY_UI`、`FUSIONKIT_AGENT_DOCK_E2E`、`FUSIONKIT_AGENT_WEB_E2E`、`FUSIONKIT_STUDIO_T06_UI`，跑 `resources-dialog-ui`、`interaction-queue-ui`、`transcription-empty-result-ui`、`agent-handoff`、`agent-web`、`transcription-ui`、`external-agent-tools`、`external-agent-classic`：8 个文件中 7 个通过，用例 11 个通过、1 个失败。失败的是 `interaction-queue-ui` 第 206 行，即上面的原有提示框问题；新加的错误说明断言在它之前，都通过了。
  - `VSCODE_DEBUG=1 pnpm dev`（127.0.0.1:7777）+ `FUSIONKIT_STUDIO_DEV_URL=http://127.0.0.1:7777/` 跑 `development-ui`：1 个通过。之后停掉开发服务器，重新 `pnpm pretest`。
- 全量（`pnpm pretest` 之后 `node node_modules/vitest/vitest.mjs run`）：513 个文件中 3 个失败、425 个通过、85 个按开关跳过；5736 个用例中 9 个失败、5616 个通过、111 个跳过；用时 228 秒。失败集中在 `serverSupervisor`（5 个）、`mediaNormalizer`（3 个）、`transcription-task-service`（1 个），都是启动期限、清理或 15 / 29 秒超时。三个文件单独重跑分别通过 56、47、42 个，与审查时记录的负载问题相同。
- 打包两次，第二次在大小文案改完之后，产物就是最终工作区。命令是 `pnpm exec vite build && node scripts/check-preload-bundle.mjs && pnpm exec electron-builder --config electron-builder.subtitle-studio.json --win nsis --publish never -c.directories.output=test-results/easy-setup-pack`，成功。安装包 266,986,350 字节，`win-unpacked` 878,668,270 字节，`app.asar` 26,256,725 字节，包内帮助页已是“850 MB”。`release/0.5.1` 没有被改动（297,080,984 字节，2026-10-17 15:07）。打包后执行了 `pnpm pretest`，`dist/`、`dist-electron/` 恢复为测试构建。
- 打包冒烟用 `test-results/easy-setup-smoke/smoke-final.mjs`：全新配置目录，`network-settings.json` 预设为指向本机一个没有监听的端口的自定义代理，所以没有任何请求离开本机。14 项全部通过：首页显示，静默启动时向导关闭、启动检查不打扰；网络、AI 模型、外部 Agent 三个设置页打开，代理设置读自主进程文件；资源管理用易懂名称列出 4 项资源并显示一键准备；帮助页“打不开怎么办”显示命令；转换器把 SRT 转成 VTT；手动检查更新时 official、ghfast、ghproxy 都报 `net::ERR_PROXY_CONNECTION_FAILED`，对话框显示网络错误和“网络设置”等按钮；外部 Agent 桥接脚本和运行库记录在资源目录里；主进程日志没有 “Cannot find module”，页面没有报错。截图与结果在 `test-results/easy-setup-smoke/final/`。没有运行安装包。

### 2026-10-18 更新清单第三个印证源（主会话）

- 收尾审查指出：GitHub 连不上时，镜像清单要靠 ghfast.top 与 ghproxy.net 两个下载镜像互相印证，ghproxy.net 常常不回答，应用内更新就会退回手动下载。新增只用于印证、从不用于下载的 `gh-proxy.com`（`manifestWitnessSources`，`electron/main/app-update/sources.ts`）：它不支持 Range，不进下载源表，但能返回 `latest.yml`；“仅官方源”模式不问它。印证规则不变：仍要求另一个主机给出相同的版本与每个文件的名称、SHA-512、大小。
- 2026-10-18 实测三个镜像（带 `noCache` 参数）返回的 0.5.0 `latest.yml` 一致。
- 测试：`test/app-update` 5 个文件 52 个用例通过（新增：见证主机在一个下载镜像不可用时完成印证且安装包从不经它下载；见证主机清单不一致时不印证；见证源列表与“仅官方源”）；`pnpm exec tsc --noEmit` 通过。测试替换源时默认没有见证主机，不会访问外网。

### 2026-10-18 发布

- 用户验收通过，随 0.5.1 正式发布：CHANGELOG 标题定为 2026-10-18，并补上本分支 easy-setup 之前的外部 Agent 权限（完全开放、自定义）、右上角连接面板与三处对话框修复；去掉 README 中英文的开发版提示；官网首页公告改为 0.5.1 的新手引导、国内下载源与应用内更新。

