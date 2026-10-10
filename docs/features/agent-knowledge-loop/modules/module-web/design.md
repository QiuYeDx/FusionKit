# web 设计

## 现状与约束

- 应用此前没有任何联网检索；任务模型请求在主进程用 axios，代理配置由 `electron/main/proxy.ts` 的 `getAxiosProxyConfig()` 提供（渲染进程设置同步到主进程）。
- 2026-10-10 在本机实测（只读公开请求）：
  - 维基百科 `{zh,ja,en}.wikipedia.org/w/api.php`：search 与 TextExtracts 可用。
  - 萌娘百科官方 `zh.moegirl.org.cn`：API 返回 `Unauthorized API call`，页面为 Cloudflare 挑战 → 不可用且不绕过；镜像 `moegirl.uk/api.php` 的 search 与 TextExtracts 可用。
  - 百度百科 `baike.baidu.com/item/…`：页面为脚本挑战 → 不抓取；公开接口 `baike.baidu.com/api/openapi/BaikeLemmaCardApi` 返回词条描述、简介与信息栏。
  - B 站游戏 Wiki `wiki.biligame.com/{code}/api.php`：search 可用，无 TextExtracts → 用 `action=parse` 取 HTML 转纯文本。
  - 必应 `cn.bing.com/search`：返回可解析的 HTML 结果。
  - 百度网页搜索：跳转验证码 → 不提供；DuckDuckGo HTML：返回挑战 → 不提供。

## 方案与取舍

### 主进程服务 `electron/main/web-lookup/`

- `service.ts`：`search({ source, query, language?, game?, site?, limit })`、`read({ url })`；依赖注入 `get(url, options)`（默认 axios，`getAxiosProxyConfig()`、`maxRedirects: 0` 手动跟随、`responseType: 'arraybuffer'`、15 s 超时、`maxContentLength` 2 MiB、无 Cookie、UA `FusionKit/<version> (translation materials lookup)`）与 `lookup(host)`（默认 `dns.promises.lookup(all)`）。
- `sources.ts`：每个来源一个适配器，固定接口地址：
  - wikipedia：`list=search`（`srprop=snippet`）→ 结果链接 `https://{lang}.wikipedia.org/wiki/{title}`；读取 `prop=extracts&explaintext`。
  - moegirl：同 MediaWiki 适配器，主机 `moegirl.uk`，结果与证据标注「萌娘百科（镜像 moegirl.uk）」。
  - baidu_baike：`BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key={query}&bk_length=600`，返回描述/简介/信息栏；链接 `https://baike.baidu.com/item/{key}`；读取时从链接取词条名再调该接口。
  - biligame：`wiki.biligame.com/{code}/api.php` search；读取 `action=parse&prop=text` → HTML 转文本。
  - bing：`https://cn.bing.com/search?q={query}{ site:…}&setlang={zh-Hans|ja|en}`，解析 `li.b_algo` 中的 `h2 a`（标题、链接）与摘要段落，过滤 bing 自身链接；读取结果页走通用读取。
- `html.ts`：去除 script/style/noscript/nav/header/footer/aside/form 等，优先 `<main>`/`<article>`/`#mw-content-text`，块级标签换行，解码实体，压缩空白；`<title>` 作为标题。纯函数，便于用固定样本测试。
- `guard.ts`：URL 只允许 http/https、无凭据、端口 80/443/默认；主机名为 IP 字面量或解析结果落在私有/回环/链路本地/保留段（IPv4 与 IPv6，含 IPv4 映射）时拒绝；每次重定向重新校验，最多 3 次。
- IPC：`web-lookup:search` / `web-lookup:read`，按渲染来源校验（仅本应用主窗口），请求 zod 校验；preload 暴露 `window.webLookup`。

### 设置 `src/store/useWebLookupStore.ts` + 设置页「Agent」分组

- 持久化：`{ enabled: false, sources: { wikipedia: true, moegirl: true, baidu_baike: true, biligame: true, bing: true }, biligameWikis: string[] }`。B 站 Wiki 来源在未填写代号时不可用（检索返回 `web_source_unconfigured`）。
- 设置页 `AgentConfig.tsx`：沿用 `GeneralConfig` 的 `Card` 结构；开关行 + 说明；来源列表为紧凑行（名称、说明、Switch）；B 站代号为逗号分隔输入并即时校验。导航新增 `agent` 项（图标 `Bot`）。

### 取舍

- 萌娘百科使用镜像：官方站点限制程序访问，按用户要求优先萌娘百科时，镜像是唯一不绕过限制的途径；所有结果与证据如实标注镜像地址，用户可在设置中关闭该来源。
- 百度百科只用摘要卡片接口：页面有脚本挑战，不做绕过；卡片信息足以核对译名。
- 搜索引擎只接必应：百度搜索与 DuckDuckGo 均返回挑战。

## 代码落点

- `electron/main/web-lookup/{service,sources,html,guard,index}.ts`、`electron/main/index.ts`（注册）、`electron/preload/index.ts` 与 `electron/preload/web-lookup-api.ts`、`src/web-lookup/contract.ts`
- `src/store/useWebLookupStore.ts`、`src/pages/Setting/components/AgentConfig.tsx`、`src/pages/Setting/index.tsx`、`src/pages/Setting/settingNavigation.ts`、`src/locales/*/setting.json`
- 测试：`test/web-lookup/web-lookup.test.ts`；实网冒烟 `test/web-lookup/live.test.ts`（`FUSIONKIT_WEB_LIVE=1` 时运行，不进 CI）

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-WEB-01 | `sources.ts` 各来源适配器、`html.ts` 正文提取、`service.ts` 读取分派 |
| R-WEB-02 | `guard.ts`、手动重定向、大小/类型/超时限制、IPC 来源校验、渲染进程开关 |
| R-WEB-03 | `useWebLookupStore`、设置页「Agent」分组与导航 |

## 验证与风险

- 单元：来源适配器用固定响应样本（含实测结构）验证解析；守卫用注入的 DNS 结果与本地 HTTP 服务验证拒绝与重定向；正文提取用样本 HTML。
- 实网冒烟：`FUSIONKIT_WEB_LIVE=1` 运行 `test/web-lookup/live.test.ts`，对每个来源各做一次检索与读取，记录结果摘要；不进 CI。
- Electron：设置页开关、来源与代号截图；Agent 未开启时的提示；带网页来源的资料卡片。
- 风险：第三方站点结构或可用性随时变化（尤其镜像与必应页面）；以稳定错误码降级，Agent 改用其他来源。

## 实施中确定（2026-10-10）

- **fake-IP 网段**：本机代理为 fake-IP 模式，维基百科、moegirl.uk、游戏官网都解析到 198.18.x.x。守卫不再把 198.18.0.0/15 视为内网（见 R-WEB-02 边界）；其他私有、回环、链路本地、CGNAT、组播、IPv6 ULA/链路本地/NAT64/6to4/Teredo 仍拒绝。
- **IPv4 映射地址**：URL 解析会把 `[::ffff:127.0.0.1]` 改写成 `::ffff:7f00:1`，原先的点分形式匹配会漏掉；改为整段 `::/8` 前缀一律拒绝，并补测试。
- **连接时固定解析结果**：直连时给 axios 传 `lookup`（`publicOnlyLookup`），连接时再次解析也只用公网地址；经代理时由代理解析，以请求前的检查为准。用本地 HTTP 服务验证：被拒绝时 axios 抛出以 `WebLookupError` 为 cause 的错误，映射为 `web_lookup_blocked`（同主机已建立的保活连接会被复用，不重新解析）。
- **中文字形**：中文维基不带 variant 时返回简繁混排（实测）；语言新增 `zh-Hant`，检索与读取带 `variant=zh-cn|zh-tw`，结果链接用 `/zh-cn/`、`/zh-tw/` 路径；读取时按链接路径或 `?variant=` 判断字形。萌娘百科镜像同样处理。
- **脚本绘制的页面**：游戏官网 HTML 无正文（实测 0 字），回退到 `description` / `og:description`（实测 524 字）。
- **实网冒烟**改为 `test/web-lookup/live.test.ts`，仅在 `FUSIONKIT_WEB_LIVE=1` 时运行（`.mjs` 无法直接引用 TS 主进程代码；vitest 复用生产路径：代理设置、守卫、限制）。
- **Electron 场景**不改生产代码：用 Playwright 在主进程 `ipcMain.removeHandler` 后以固定样本重新注册 `web-lookup:*`，渲染进程、设置、Agent 与卡片均为真实实现，并记录到达主进程的请求。
- 设置页的 `Switch` 组件不转发 `data-testid`，测试改用开关的 `id`。
