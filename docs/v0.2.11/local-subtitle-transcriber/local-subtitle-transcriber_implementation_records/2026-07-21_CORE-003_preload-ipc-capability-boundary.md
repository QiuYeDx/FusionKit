# 工作包 CORE-003：Preload、IPC 与 Capability 安全边界

## 基本信息

- 日期：2026-07-21
- 状态：已完成
- 对应执行计划工作包：`CORE-003`
- 目标：建立独立 `local-subtitle:*` renderer/preload/main 信任边界，不复用 `audio:*` namespace 或 registry

## 本次认领边界

- 包含：fixed renderer API、exact public/internal/event channel、strict request/result contract、document owner session、input/output draft capability、atomic task/batch lease、artifact/import token 安全骨架、preload/main 接线与安全回归。
- 不包含：FFprobe/media probe、official server launch、managed model 下载/导入业务、Job Manager/session snapshot 权威状态、字幕 artifact 文件 parser/read/reveal、翻译导入协调或 renderer cleanup retry。
- 后续业务通过注入式 main handler 接线；handler 缺失时返回稳定 unavailable error，不返回 mock success。

## 本次实现内容

- `localSubtitleIpc.ts` 冻结 15 个 public invoke、6 个 preload-private 与 2 个 event channel，三组互不重叠；每个 operation 都有 strict request/result schema 与 request/result byte budget。
- `LocalSubtitleRendererApi` 完整覆盖文件/目录授权、runtime/resource、session/task、artifact 与两类 event，不暴露 generic `invoke/send/channel`。`importModel` 只接受 `File + { mode }`，resource install 只接受 `resourceId`。
- preload 同步调用 private handshake，main 为当前 top document/frame 签发 UUID；`ownerSessionId` 只在 preload 闭包中隐式进入 secure envelope，不作为 API 字段返回 renderer。
- owner identity 绑定 `webContents.id + processId + routing/frame identity`；跨窗口、iframe、旧 session、reload/navigation replay 均拒绝。sender/frame destroy、render-process-gone 与非 in-place main navigation 只释放一次，旧 lifecycle callback 不能误释放新 session。
- main 对完整 secure envelope、payload 和 handler result 分层校验；普通 frame 256 KiB、snapshot 4 MiB、artifact text 16 MiB 加 envelope overhead。malformed/oversized response fail closed，不反射原始内容。
- input/output registry 使用不混淆 kind prefix、owner、TTL、allowed operation 与 filesystem identity；文件使用 lstat/realpath/no-follow FileHandle/fstat，目录保存 canonical identity，root/symlink/replacement 与 unsafe leaf 均拒绝。
- batch capability 使用 `draft -> reserved -> leased` 两阶段状态；所有 input 与 optional custom output 先完整 prepare/reserve，再同步 commit。任一失败全部 rollback；短 lease 在 commit 前过期会拒绝并恢复仍有效 draft；renderer revoke 不能撤销 active lease。
- artifact ref registry 只冻结 owner/TTL/operation 骨架；translation import token 是 short-TTL one-shot 容器，成功、失败、异常、过期、revoke 与 owner release 都 dispose 内容并归还 quota。实际 artifact 文件语义仍属于 `SUB-002/LINK-006`。
- task/snapshot 的公开 artifact summary 收口为 `artifactRef + format + displayName + expiresAt`；`byteSize/sha256/committedAt` 保持 main-private integrity metadata，cue/text 边界由 artifact read/handoff schema 校验。
- legacy generic bridge 对完整 `local-subtitle:` namespace 拒绝 on/off/send/invoke；同时丢弃 raw `IpcRendererEvent`、不返回底层 transport，并保存精确 wrapper 以支持幂等 off。Audio 既有 event allowlist 保持兼容。
- `open-win` 子窗口改为 `nodeIntegration: false + contextIsolation: true`，不能借同源窗口直接调用 private IPC；local handshake 在创建首个 BrowserWindow 前注册。

## 修改文件

- `src/type/localSubtitle.ts`、`src/type/localSubtitleIpc.ts`、对应 tests、`src/vite-env.d.ts`
- `electron/preload/local-subtitle-channel-policy.ts`
- `electron/preload/local-subtitle-api.ts`
- `electron/preload/legacy-ipc-bridge.ts`
- `electron/preload/index.ts`
- `electron/main/local-subtitle/ipc-security.ts`
- `electron/main/local-subtitle/authorizations.ts`
- `electron/main/local-subtitle/ipc.ts`
- `electron/main/index.ts`
- `test/local-subtitle/{preloadChannelPolicy,preloadApi,legacyIpcBridge,ipcSecurity,authorizations,ipc}.test.ts`
- Final Design、主题/版本执行计划与 v0.2.11 README

## 接口或数据结构变化

- 新增 `LOCAL_SUBTITLE_PUBLIC_INVOKE_CHANNELS`、`LOCAL_SUBTITLE_PRELOAD_INTERNAL_CHANNELS`、`LOCAL_SUBTITLE_EVENT_CHANNELS` 与两个 exhaustive operation contract map。
- 新增 path-free media/runtime/resource/output/artifact DTO；private raw path 只存在 authorize/import internal schema，不进入 public operation map。
- `revealArtifact` 明确返回 JSON-safe `{ revealed: true }`，不再以不可序列化的 `void` 作为 success data。
- revoke 结果固定为 `{ revoked: boolean }`；`false` 是幂等成功，也表示 draft 已不存在或已经转为不可由 renderer 撤销的 active lease。
- `GeneratedSubtitleArtifactSummary` 删除公开 size/hash/commit timestamp，增加 ref expiry；真实 integrity record 留在 main registry。
- `window.ipcRenderer` 的公开类型收窄为 `SafeLegacyIpcBridge`；event 首参静态和运行时均为 `undefined`，on/off/send 返回 `void`。

## 安全与隐私检查

- renderer 不能读取或自填 local owner session，不能向 local public request 注入 path/URL/executable/args/backend flags，不能从 local result/event/snapshot 得到 raw path。
- private authorize path 只由 `webUtils.getPathForFile()` 或 main dialog 产生；main 仍复核 absolute path、type、identity、size、symlink 与 owner generation。
- owner release 后的 async picker/handler result 不能复活 token或发给新 document；future handler 可用 `context.isOwnerCurrent()` 在不可逆 commit 前复核。
- Local registry 与 Audio registry 完全独立；kind prefix 让相同随机源生成的 file/output/artifact/import token 也不能跨 registry 解析。
- 未新增依赖、lockfile、模型、二进制、媒体、真实用户路径、下载 URL、API Key 或签名身份；未执行 pnpm。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run src/type/localSubtitle.test.ts src/type/localSubtitleIpc.test.ts test/local-subtitle/authorizations.test.ts test/local-subtitle/ipcSecurity.test.ts test/local-subtitle/ipc.test.ts test/local-subtitle/preloadApi.test.ts test/local-subtitle/preloadChannelPolicy.test.ts test/local-subtitle/legacyIpcBridge.test.ts src/type/audioIpc.test.ts test/audio/audioPreloadChannelPolicy.test.ts
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit
node_modules/.bin/vite build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- CORE-003 + shared domain + Audio isolation：10 files / 134 tests 全部通过。
- 全量 Vitest：103 files / 975 tests 全部通过；TypeScript 通过。
- Vite test build 的 renderer/main/preload 三段构建通过；仅有既有 chunk-size 与 dynamic/static import warning。
- PRE manifest validation：0 error / 0 warning；validator 17/17。
- 未启动 Vite dev server、Electron、runner、FFmpeg、下载任务或其他长期前端/原生进程。

## 未完成事项与风险

- `MEDIA-001`、`NATIVE-001`、`MODEL-*`、`BE-002`、`SUB-002`、`LINK-006` 需分别注入真实 handler；当前 transport 返回 unavailable error不代表对应产品能力已实现。
- `BE-002` 在真实 enqueue commit 时必须调用本包 lease coordinator，并在 task/batch terminal/remove/owner end 释放或只对 active task 有界续期；不能另建绕过 registry 的 path 缓存。
- `CORE-004` 仍需实现 subscribe-before-snapshot reducer 与 capability cleanup queue，覆盖 rejected Promise、`ok:false`、`revoked:false` 和 SPA remount。
- 当前应用的旧 Subtitle/Text/Rename/HomeAgent 流程仍依赖 `window.electronUtils.getPathForFile()`、legacy raw output picker 和持久化 path。它们不能调用 local private channel，也不能把 path 换成 local capability，因此不构成 local authority 绕过；但 app-wide renderer path confidentiality 尚未成立。必须按 `FK-PIT-0022` 在所有旧消费者迁移并通过回滚测试后再删除，不能在本包直接切断。
- output registry 本包冻结 root identity 与 direct-child lexical containment；最终 existing target no-follow、reservation mutex、atomic replace 与 parse-back 仍由 `SUB-002` exporter 在每次 commit 前完成。

## 下一步建议

- 优先认领 `CORE-004`，实现安全偏好 Store、subscribe-before-snapshot revision reducer 与 cleanup retry；或者认领 `NATIVE-001`，把 official server HTTP/process contract 接到本包 handler 边界。
- 正式 native artifact 与 builder wiring 仍由 `NATIVE-002` 在 `NATIVE-001 + CORE-002` 后完成；不得从 PATH 或 renderer executable 参数补洞。
