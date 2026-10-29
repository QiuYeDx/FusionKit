# 实施记录：T-ENGINE-06

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENGINE-06 |
| 日期 | 2026-10-28 |
| 验证版本 | snapshot-sha256:c2d906fc4c29918290e68a0c2aa3d33d18fbc21831470145fb220aeba77f42a3（基线 a742ec76 + 未提交工作树）。批次 C 修正的独立评审与修复（2026-10-28）后取得：在最后一次代码修改（`engine/executor.ts`、`executor.test.ts`）与 engine design §11 的修改、全部检查的重跑与证据写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时的文件 sha256 前 12 位：`engine/executor.ts` 7dfb9f0b1a3b，`executor.test.ts` 411a7588fa6e，engine design.md 681c032ce2a4；其余批次 C 修正改过的源文件与下述批次 C 修正时相同（`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c）。评审之前的验证版本与说明：snapshot-sha256:2f201d53b059332cb0e6f9dc79dd3d6616d307b1086a3746b5ff9dd816aea715（基线 a742ec76 + 未提交工作树）。批次 C 修正（2026-10-28）后取得：在最后一次代码修改、受影响检查的重跑与证据文件写入之后，更新 T-ENGINE-05、T-ENGINE-06、T-ENGINE-07、T-ENCODE-01 四份记录并写入 FIXUP-C-check-spec.txt 之前；这些文件的这次改动未计入。工作树中还有其他任务的文件，快照包含它们。此时批次 C 修正改过的文件 sha256 前 12 位：`contract.ts` f088a18910e4，`queue/queue.ts` c62fc626049d，`queue/types.ts` e2d75d204f5f，`engine/executor.ts` 7bbc95cfd44d，`ipc.ts` 1345ed1d1f70，`plan/stream-plan.ts` 8b491a782e0b，`plan/types.ts` d1ee7cfded4c，`queue.test.ts` 3804c62b1a5a，`executor.test.ts` 0961d9822a8e，`ipc.test.ts` 96a24113d1c4，`plan/stream-plan.test.ts` cafa28d8d09e，engine design.md dca0ac38db09，encode design.md 3e39a493f5dd。批次 C 修正之前的验证版本与说明：snapshot-sha256:ad1de92a7b558cbc5aeceffb469afa3c646fb764d13f5cad38a2e5722a8d04ca（基线 a742ec76 + 未提交工作树）。在评审的最后一次代码修改、全部重新验证与证据文件写入之后取得；本记录文件的写入未计入。此时各文件 sha256 前 12 位：`media-converter/ipc.ts` 726b261beb5a，`media-converter/index.ts` 48481bb16983，`preload/media-converter-api.ts` 225420a887fe，`channels.ts` 072f373c39ec，`contract.ts` 66cd9c88b195，`ipc.test.ts` dece03d0d505，`composition.test.ts` ed9913252d4c；`electron/main/index.ts` 与 `electron/preload/index.ts` 的 blob 为 1f90db78… 与 a92ae621…（评审未改动）。工作树中还有其他任务的智能体正在修改的文件，快照包含它们。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；TypeScript 经 `pnpm exec tsc`；Vite 5.4.21（`tsc`、`vite build --mode=test` 与 test/subtitle-studio-provenance 以 IDLE 优先级运行）。本任务的两份测试不运行 ffmpeg/ffprobe，也不校验随附运行时（随附 ffmpeg n8.1.2 LGPL 与 RTX 4070 Ti SUPER 只在下文「回归」中由已有的 capabilities.test.ts 用到，以及评审的变异 R4 中被触发，均为 BELOW_NORMAL 优先级）。没有启动 Electron。输入文件是测试运行时在 test-results/media-converter/ipc-* 与 composition-* 下生成的小文本文件（NTFS 卷 C:），测试结束后删除；拖放用例没有在 %TEMP% 中写任何文件。 |
| 任务指纹 | 9df8531adf9071d1b062c918d259cc0827e0d93e7bc42b41a9f98930ea4e5130 |

## 实际结果

本任务没有界面部分，不涉及截图。

**新增与修改的文件（均在写集内）**

- `src/media-converter/channels.ts`（新增，只依赖 zod，经 contract.ts）：前缀 `media-converter:`，13 个请求通道（get-snapshot、add-dropped-files、pick-files、pick-output-directory、preview-plan、start、cancel、remove、retry、clear、reveal-output、set-options、redetect-capabilities）和事件通道 `media-converter:changed`；事件 schema 即 contract 的 `queueEventSchema`。
- `src/media-converter/contract.ts`（追加 IPC 一节）：
  - `mediaConverterRequestSchemas`：每个通道一个严格 schema。队列已有的命令 schema 直接复用；`add-dropped-files` 为 `{paths}`（1–100 条，不含 NUL）；`pick-files` 为 `{filter: video|audio|all}`；`reveal-output` 为 `{itemId, outputIndex?}`；其余无参数的通道为 `{}`。没有任何 schema 能携带渲染进程给的路径。
  - 结果：`mediaConverterSnapshotSchema`（队列快照加 `resolvedEncoders` 与 `defaults.compressCodec`）、`previewPlanResultSchema`、`pickOutputDirectoryResultSchema`；`MediaConverterResult<T>` 为 `{ok:true,value}|{ok:false,error:{code}}`，错误码是封闭的 `itemFailureCodeSchema`。
  - `MediaConverterApi`：`supported`、每个通道一个方法、`onChanged`。
- `electron/preload/media-converter-api.ts`（新增）：
  - `supported = platform === 'win32'`（默认取 `process.platform`）；
  - `addDroppedFiles(files)` 在任何 await 之前同步对前 100 个 `File` 调用 `webUtils.getPathForFile`，只发送这些路径；超出 100 的个数加进主进程答复的 `truncated`；取不到磁盘路径（`''`）或根本不是 `File` 的对象，在预加载内记为 `file_unavailable`，并入答复；
  - `onChanged` 用事件 schema 校验，不合格的事件丢弃。
- `electron/preload/media-converter-channel-policy.ts`（新增）：`assertLegacyMediaConverterChannelAllowed` 拒绝 `media-converter:` 前缀。
- `electron/preload/index.ts`：在遗留桥的命令检查与监听检查中各加入一次该拦截，并 `exposeInMainWorld('mediaConverter', createMediaConverterApi(ipcRenderer, webUtils))`。
- `src/vite-env.d.ts`：`Window.mediaConverter?`。
- `electron/main/media-converter/ipc.ts`（新增）：
  - `registerMediaConverterIpc`：处理顺序为平台 → 是否已关停 → 信任 → 严格 `safeParse` → 等待 ready → 处理函数。非 Windows 时每个请求都答 `platform_unsupported`，没有处理函数可运行；不受信任或不合法的请求答 `invalid_request`，不进入处理函数；关停开始后答 `busy`；意外异常只记日志，答 `unknown`。
  - `mainWindowTrust(getWindow)`：主窗口未销毁、`event.sender === window.webContents`、发送框架就是该窗口的主框架（`event.senderFrame === event.sender.mainFrame`，评审补充，见下文），并且 `isTrustedAppSender(event)`（顶层框架、应用自己的页面）。
  - `createMediaConverterHandlers`：
    - 第一次 `get-snapshot`、拖放或对话框添加文件时调用 `capabilities.ensure()`，不在应用启动时检测；
    - `get-snapshot` 是唯一调用 `queue.snapshot()` 的地方，附 `resolvedEncoders()` 与 `defaults()`；
    - 拖放经转换模块自己的 `resolveDroppedMediaPaths`，拒绝项与队列的答复合并；
    - 选择文件与选择输出文件夹都用主进程对话框（父窗口为主窗口），文件夹交给 `rememberOutputDirectory`；
    - `reveal-output` 只接受 `queue.outputPath(itemId, outputIndex)` 给出的、本工具发布的输出，文件已不在时答 `file_unavailable`；
    - `redetect-capabilities` 在有硬件编码运行时答 `busy`。
  - `mediaConverterEventSender`：只发给存活的主窗口；`mediaConverterRevealer`：`FUSIONKIT_TEST_MEDIA_REVEAL=record` 时只记录文件名（日志行），否则 `shell.showItemInFolder`。
- `electron/main/media-converter/index.ts`（新增）：`registerMediaConverter({getWindow, environment, userDataPath, platform})`。
  - 非 Windows：只注册通道（全部答 `platform_unsupported`），不构造运行时，不读写磁盘。
  - Windows：在 `<userData>/media-converter` 上组合 `MediaRuntime`（工作目录 `work/`）、`MediaProber`、`InputRegistry`、`MediaOutputs`（`shell.trashItem`）、`MediaCapabilities`（`app.getGPUInfo('basic')`、`isHardwareEncodeRunning` 取自队列、测试开关的 caps）、`MediaConversionExecutor`（测试开关的 fail）、`MediaQueue`（真实 `powerSaveBlocker`、`MediaOutputs.wouldReplace`、事件发送）。测试开关由 `resolveMediaTestHooks(process.env, {packaged: app.isPackaged})` 决定。
  - 注册时同时启动 `outputs.cleanupAtStartup()` 与 `queue.restore()`，两者都完成后才处理请求，保证检测不会在清空 `work/` 时开始，第一次快照也包含 state.json 的内容。
  - `shutdown(reason)`：同一个 Promise，不会 reject。先让 IPC 答 `busy`，再并行执行 `queue.shutdown(reason)`（取消、最多等 4 s、清理、写盘）与 `capabilities.dispose()`（最多等 4 s），都结束后才 `prober.dispose()`，这样等待期间读回输出的探测不会被提前中止。
- `electron/main/index.ts`：一条 import，一次带 try/catch 的注册（在 `registerLongText` 之后、`createWindow()` 之前），并把 `{ shutdown: reason => mediaConverter?.shutdown(reason) ?? Promise.resolve() }` 加入 `createSharedResourceApplicationShutdown` 的 `runtimes`。
- 两份审计 JSON：按主进程与预加载 `index.ts` 的最终字节，用 `git hash-object` 重新登记 `currentBlobOid`（1f90db78…、a92ae621…），并在两条 `reason` 末尾各追加一句「2026-10-26 media converter (v0.6.0 T-ENGINE-06): …」，写法与以往条目一致。两份文件原有的换行符（CRLF 与 LF）保持不变。
- `test/media-converter/ipc.test.ts`（新增，16 项）：真实的队列、输入登记表和能力表（`cpu_only` 测试表，运行时是假的），配假执行器与假探测器，经真实处理函数与 IPC 注册调用；拖放用例经真实预加载 API 接到主进程处理函数。
- `test/media-converter/composition.test.ts`（新增，实现时 7 项，评审后 9 项）：mock `electron` 与运行时校验入口（只为监视调用），不启动 Electron。

**变异检查**

对最终源码逐个施加 21 个变异，每次运行两份测试，结束后确认源文件按字节还原：去掉信任判定、不比对发送方、不排除子框架、跳过 schema、darwin 照常服务、拖放绕过封装、显示前不查文件、显示任意序号的输出、快照不启动检测、预加载在 await 之后才取路径、预加载发送全部路径、`supported` 恒为真、监听检查漏拦截、关停未加入 runtimes、拦截策略放行、关停后不关闭 IPC、不等 ready、非 Windows 答 ok、先结束探测再等队列、丢弃关停原因、快照缺 `resolvedEncoders`。21 个全部被测试发现，见 file:records/i1/T-ENGINE-06-mutations.txt。

**回归（不是本任务的验证项）**

- 读取 `electron/main/index.ts`、`electron/preload/index.ts` 或 `src/vite-env.d.ts` 源码的已有测试（长文本组合与 IPC、覆盖运行时、窗口外观、项目元数据），以及读取 contract.ts 的媒体转换测试（queue、test-hooks、capabilities、progress），共 121 项全部通过，见 file:records/i1/T-ENGINE-06-regression.txt。
- 两份新测试与 vite-env.d.ts 另外做了类型检查（tsconfig.json 不包含 test/），见 file:records/i1/T-ENGINE-06-tsc-tests.txt。

**评审与修复（2026-10-28，独立评审）**

评审逐条对照 design §6、§8 与五条 AC，读完了写集内全部代码与测试，并核对了队列、执行器、能力检测、进程封装与共享关停中被本任务接线的部分。下面是发现的问题与处理方式。

1. **信任判定缺少「主框架本身」的核对（主要，已修复）。** 原实现只比对 `event.sender` 与主窗口的 webContents，再交给 `isTrustedAppSender`。后者只在 `senderFrame` 存在时检查 `parent`；`senderFrame` 为 null 时（发送请求的框架在请求到达前已导航或销毁），它改用整个窗口的 URL 判断，因此会把这类请求当作主框架的请求放行。这与 AC-ENGINE-07-1「只接受主窗口顶层框架」不符，也与仓库里 external-agent、agent-sessions、subtitle-studio 等模块的做法不一致。
   - 修复：`mainWindowTrust` 增加 `!!event.senderFrame && event.senderFrame === event.sender.mainFrame`，并更新了 ipc.ts 的模块说明。
   - 测试：测试替身的 webContents 带上 `mainFrame`，受信任事件的 `senderFrame` 就是这个对象。ipc.test 新增三种被拒的情况：不是主框架但 `parent` 为 null 的框架、`senderFrame` 为 null、完全没有 `senderFrame`。原有的「其他页面」「非本应用的 file 页」两种情况，原来是用另一个框架对象构造的，加上身份核对后会因为身份不符被拒，从而测不到 URL 检查；现在改为把主框架本身导航到这两个 URL 来测。composition 的默认信任检查也加了两种情况。
2. **启动时不校验运行时，原来只在测试替身上证明过（次要，已补测试）。** AC-ENGINE-01-1 要求注册时不校验运行时、不做探测。原来的 composition 用例都设置了能力开关，这时本来就不会校验，所以证明不了这一点。新增用例：不设任何测试开关，在 Windows 下走生产组合注册，等 ready，再关停。确认运行时校验入口、`getGPUInfo`、电源阻止与对话框都没有被调用，userData 下只有 `work/`。
3. **AC-ENGINE-05-4 原来只证明了接线（次要，已补端到端用例）。** 新增 composition 用例走生产组合 `registerMediaConverter`，只把边缘替换掉：`MediaRuntime.acquire`、`MediaProber.probe`、`MediaConversionExecutor.run`，并使用 `cpu_only` 开关。流程如下：
   1. 经 `pick-files` 加入一个文件，`start` 后执行器写下一个 partial 并等待；
   2. 调用 `shutdown('app_quit')`；
   3. 确认：执行器收到 abort；关停在执行器删掉 partial 之后才结束，且用时少于 4 s；电源阻止以 `prevent-app-suspension` 开始，并以同一 id 释放；探测在最后结束；state.json 中该条目为 `interrupted`；之后的请求答 `busy`。
4. **非 Windows 的 `shutdown` 每次调用都返回新的 Promise（次要，已修复）。** 这与接口说明「所有调用方共用一个 Promise」不符。现在改为返回同一个已完成的 Promise，darwin 用例中加了断言。
5. **其余核对过、没有问题或不属于本任务的项：**
   - 取消运行中的任务时，`child.kill()` 是立即调用的（process.ts）。因此 4 s 等待到期后，不会留下继续编码的 ffmpeg。
   - 关停顺序（队列与检测并行，探测最后结束）与共享关停超时相容。
   - 预加载在任何 await 之前同步读取前 100 个路径。遗留桥的两处检查都有拦截。preload 打包只 require electron。
   - 快照与事件不含路径。`reveal-output` 只接受本工具发布的输出。
   - 原记录列出的偏差 1–9 都合理，评审保留。
   - 不在写集内、留给后续的观察，见「风险与未执行项」。
6. **评审变异**：R1–R6 全部被测试发现，见 file:records/i1/T-ENGINE-06-review-mutations.txt。R1–R6 依次为：去掉主框架身份核对、放行 null `senderFrame`、darwin 关停每次新建 Promise、注册时就开始检测、关停不等待队列、电源阻止未接线。原实现者的 21 个变异记录（file:records/i1/T-ENGINE-06-mutations.txt）保留，作为实现阶段的证据。

**批次 C 修正（2026-10-28）**

修正了原记录「评审观察」第 1 条（预览计划不传替代编码）与「差异」第 8 条（ready 状态字段可选）。本任务写集内改了 `ipc.ts`、`contract.ts` 与 `ipc.test.ts`；`media-converter-api.ts`、`index.ts`、`electron/main/index.ts`、`electron/preload/index.ts` 与两份审计 JSON 都没有改动。队列与执行器的部分见 T-ENGINE-05、T-ENGINE-07 记录，设计回写见 engine design §11。

- **预览计划的替代编码（F5）。**
  - 契约：`previewPlanResultSchema` 增加第三种结果 `{status: 'error', reason: 'no_encoder_available', alternatives}`，alternatives 至多 3 个且不重复。
  - `previewPlan` 处理函数把队列的这种答复原样交出。其他规划错误与「不适用」仍以 `{ok: false, error: {code}}` 返回。
  - 预加载 API 原样转发结果，不需要改动。
- **ready 状态字段必填（F4）。** 契约中 `ready` 能力状态的 `degraded`、`driverUpdates`、`resolvedEncoders`、`defaults` 改为必填。快照与 `engine` 事件本来就由 `MediaCapabilities` 填写完整。
- **经 IPC 可见的其他变化（F1–F3）。**
  - 条目状态可以带 `space`（只在 `disk_space_low` 上）。
  - 取消的多输出条目的 result 列出已发布的输出，`reveal-output` 因此能打开它们。
  - 检测期间排队的条目不会开始。

  预加载用同一份契约校验事件，构建产物中已有这些代码。
- **测试。** ipc.test.ts 新增「预览 no_encoder_available 时给出替代编码」：
  - 7×7 的画面在 `cpu_only` 表下按 HEVC 压缩，规划器答 `no_encoder_available`；
  - IPC 结果中的 alternatives 与规划器一致，且不为空；
  - 经预加载 API 调用，结果相同；
  - 选用其中一个替代编码，预览得到 ready 计划；
  - start 只给原因码。

  共 17 项通过；composition 9 项通过。
- **变异。** M10、M11 都被本文件的用例发现（file:records/i1/FIXUP-C-mutations.txt）。

**评审与修复（批次 C 修正的独立评审，2026-10-28）**

评审复核了三处：`ipc.ts` 的 `previewPlan` 处理、契约中的新结果形状，以及预加载的转发。本任务的文件未改动。

- `previewPlan` 的三种成功结果都由队列给出，主进程不另行校验。队列已保证 alternatives 去重、只含契约中的编码，所以结果满足 `previewPlanResultSchema`。
- F4 之后，ready 状态的字段都是必填。预加载用 `queueEventSchema` 校验 `engine` 事件，而真实的 `MediaCapabilities.status()` 总是填写全部字段，所以这类事件不会被丢弃。
- 评审对执行器的修正（见 T-ENGINE-07 记录）在主进程包中：重跑 V-ENGINE-06-3 时，构建产物中可以看到回退之后的取消检查。
- 重跑：
  - V-ENGINE-06-1 17 项通过，V-ENGINE-06-2 9 项通过；
  - V-ENGINE-06-3：tsc 无诊断，vite build（Idle 优先级）与 check-preload-bundle 都通过；
  - V-ENGINE-06-4：集成检查输出 `exact: true`，两个 index.ts 的 blob 与审计 JSON 一致。

  `test/subtitle-studio-provenance` 的 vitest 部分仍未重跑，理由与批次 C 修正相同：它检查的四个文件都没有变化，而且它会改写 test-results 下的证据与输入目录。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENGINE-06-1 | 通过 | file:records/i1/T-ENGINE-06-ipc.txt |
| V-ENGINE-06-2 | 通过 | file:records/i1/T-ENGINE-06-composition.txt |
| V-ENGINE-06-3 | 通过 | file:records/i1/T-ENGINE-06-static.txt |
| V-ENGINE-06-4 | 通过 | file:records/i1/T-ENGINE-06-provenance.txt |

- 四项检查都在评审的最后一次源码修改之后重新运行，证据文件已用这次的输出覆盖。V-ENGINE-06-1/2 的运行也晚于测试的最后一次修改（一处类型标注 `filePaths: [] as string[]`，由测试类型检查发现，见 file:records/i1/T-ENGINE-06-tsc-tests.txt）。
- V-ENGINE-06-1（16 项）的各项要求与用例对应如下：
  - 不受信任的发送方与子框架被拒：「serves only the main frame…」，覆盖以下情况，并确认处理函数未被调用、队列未变：
    - 另一窗口；
    - 子框架；
    - 不是主框架的框架（`parent` 为 null）；
    - `senderFrame` 为 null（框架已导航或销毁）、没有 `senderFrame`；
    - 主框架导航到其他页面、非本应用的 file 页；
    - 已销毁的主窗口。
  - 非法参数返回 invalid_request：「answers every malformed request…」，覆盖 33 种请求，任何处理函数、执行器与对话框都未被调用；
  - 渲染进程无法提交路径：「never takes a path from the renderer」，覆盖带路径字段的请求、伪造的 File 对象与字符串，以及其余方法都把请求原样发往固定通道；
  - reveal-output 只接受本工具的输出：「shows in its folder only an output this tool published」；
  - 文件夹返回 folder_not_supported：「refuses a dropped folder, a missing file and a link」，用真实的 Explorer 拖放解析器，路径都不在 %TEMP%，另外覆盖不存在的文件与符号链接（本机可创建符号链接）；
  - mock 解析器，1 个 %TEMP% 路径加 1 个普通路径：「refuses only the %TEMP% copy…」，结果为加入 1 个、拒绝 1 个（temporary_copy_unresolved），只有普通文件被探测。用了两种 %TEMP%：通过 `tempDirectory` 指定的模拟目录，以及真实 %TEMP% 下一个从未创建的文件名；
  - 快照与事件不含绝对路径：「carries redacted logs…」，日志中故意写入输入、输出、临时文件、工作目录、其他盘符路径、UNC 和 file URL，快照与全部事件的 JSON 都不匹配任何绝对路径形式，日志中分别出现 `<input>`、`<output>`、`[path]`。
  - 另有：前 100 个文件同步取路径（第一次 await 之前已调用 100 次）、超出的计数、第一次快照才启动检测、预览计划、事件只发给存活窗口、事件校验、关停后答 busy、请求等待 ready。
- V-ENGINE-06-2（9 项，其中 2 项为评审新增）：
  - 预加载暴露 mediaConverter，两处遗留检查各有一次拦截，`Window` 类型已声明；
  - 遗留桥对每个 `media-converter:` 通道的 invoke、send、on、off 都抛出 restricted；
  - 主进程在 `createWindow()` 之前带 try/catch 注册，并加入关停 runtimes；关停把 reason 传给队列，探测最后结束；
  - Windows 下注册全部 13 个通道，快照合法，关停后 state.json 已写入、请求答 busy；
  - 把平台打桩为 darwin 时，13 个通道无论请求是否合法、发送方是否受信任，都答 `platform_unsupported`；运行时校验入口、对话框、shell、GPU 信息与电源阻止都没有被调用，userData 下没有创建任何文件；`process.platform` 打桩为 darwin 或 linux 时 `supported` 为 false；关停对所有调用方返回同一个 Promise；
  - 评审新增：不设测试开关时，Windows 下的注册、ready 与关停都不校验运行时、不读 GPU 信息、不启用电源阻止；
  - 评审新增（AC-ENGINE-05-4）：经生产组合运行一个条目时关停，执行器收到 abort；关停等到执行器删掉 partial 后才结束，用时少于 4 s；电源阻止被释放；探测最后结束；state.json 中该条目为 `interrupted`。
- V-ENGINE-06-3：`tsc` 无诊断；`vite build --mode=test` 成功；`check-preload-bundle` 通过，预加载只 require electron；构建产物中主进程与预加载都含有本模块的通道，主进程产物中也已有评审补充的主框架核对。
- V-ENGINE-06-4：
  - `shared-resource-integration.mjs` 输出 `exact: true`。`git hash-object` 的结果与两份审计 JSON 中的 `currentBlobOid` 一致（评审没有改动这两个 `index.ts`，也没有改动审计 JSON）。实现阶段另外运行过 `copy.mjs --check`，结果为 passed；
  - `test/subtitle-studio-provenance` 中 16 个文件通过，2 个整文件跳过，另有 1 项用例跳过，共 233 项通过、3 项跳过。三项跳过都是由环境变量控制的：会启动 Electron 的 release-real-workflow，以及两项真实 ASR 用例；
  - 运行前确认该目录中只有 release-real-workflow 会启动 Electron，且需要 `FUSIONKIT_RELEASE_REAL_WORKFLOW=1`；运行时这些变量均未设置，并以 IDLE 优先级运行；
  - 评审重新运行，耗时 260 s，结果与实现阶段相同：233 项通过、3 项跳过；
  - 该目录的两项测试可能改写 test-results 下自己的证据文件（`subtitle-studio-transcript-executor/replay-evidence.json`、`studio-transcription-replay/evidence.json`）。运行前已备份，运行后还原；评审这次运行前后两份文件的 sha256 相同，test-results 保持原样。
- 批次 C 修正（2026-10-28）后，四项检查都已重跑（V-ENGINE-06-4 只重跑了其中的集成检查，原因见下），新输出追加在证据文件末尾，原内容保留：
  - V-ENGINE-06-1：17 passed；
  - V-ENGINE-06-2：9 passed；
  - V-ENGINE-06-3：tsc 没有诊断；`vite build --mode=test` 成功（经 PowerShell Start-Process 以 Idle 运行）；`check-preload-bundle` 通过。在构建产物中确认了 F1（预加载的契约）、F3（队列的检测判断）与 F5（队列与 IPC 的替代编码）的代码；
  - V-ENGINE-06-4：只重跑了 `shared-resource-integration.mjs`，输出 `"exact": true`，并确认两个 `index.ts` 的 `git hash-object` 与两份审计 JSON 的登记值一致。`test/subtitle-studio-provenance` 没有重跑，原因有两点：它检查的文件这次都没有变化；它会改写 test-results 下的证据文件，而本次修正不得改动 test-results。
  - 全部非 Electron 的 media-converter 测试 691 项通过（file:records/i1/FIXUP-C-vitest.txt）。
- 评审与修复（2026-10-28，批次 C 修正的独立评审）后，四项检查都已重跑（V-ENGINE-06-4 仍只重跑了集成检查），新输出追加在证据文件末尾：
  - V-ENGINE-06-1：17 passed；V-ENGINE-06-2：9 passed；
  - V-ENGINE-06-3：tsc 没有诊断；`vite build --mode=test`（Idle）成功；`check-preload-bundle` 通过；构建产物中有评审对执行器的修正；
  - V-ENGINE-06-4：`shared-resource-integration.mjs` 输出 `"exact": true`；两个 `index.ts` 的 `git hash-object` 与两份审计 JSON 一致；
  - 全部非 Electron 的 media-converter 测试 692 项通过（file:records/i1/FIXUP-C-vitest.txt 末尾）。

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENGINE-07-1 | 通过 | V-ENGINE-06-1, V-ENGINE-06-2, V-ENGINE-06-3 |
| AC-ENGINE-07-2 | 通过 | V-ENGINE-06-1 |
| AC-ENGINE-07-3 | 通过 | V-ENGINE-06-1 |
| AC-ENGINE-01-3 | 通过 | V-ENGINE-06-2 |
| AC-ENGINE-05-4 | 通过 | V-ENGINE-06-2, V-ENGINE-06-4 |

- AC-ENGINE-07-2 的「在事件中同步取得路径」，在预加载层面已验证：路径在第一次 await 之前取得。渲染进程需要在 drop 事件处理中同步调用 `addDroppedFiles`，这由 workbench 任务负责。真实的 Windows Explorer 拖放（FK-PIT-0098/0099）要在 Electron 中验收。
- AC-ENGINE-07-3 的日志脱敏由队列（T-ENGINE-05）与执行器（T-ENGINE-07）完成。本任务验证的是经过 IPC 之后的结果：即使执行器给出的是完全未脱敏的日志，快照与事件中也没有绝对路径。
- AC-ENGINE-05-4：本任务负责接线，即加入共享关停、传入原因、拒绝关停后的请求，并按「队列与检测 → 探测」的顺序关停。评审新增的 composition 用例经生产组合证明：关停时取消运行中的条目，等它清理完 partial 后才结束，条目记为 `interrupted`，并释放电源阻止。执行器替身只模拟「被取消 → 删除 partial」。用真实 ffmpeg 终止进程并删除 partial，已由 T-ENGINE-07 验证；process.ts 在取消时立即 `child.kill()`。真实应用退出与安装更新的流程没有在 Electron 中运行。
- AC-ENGINE-07-1 的「只接受主窗口顶层框架」：评审补充了主框架身份核对。`senderFrame === mainFrame` 的对象同一性在仓库其他模块中已在 Electron 下使用，但本任务没有在 Electron 中运行。

## 风险与未执行项

**与设计的差异，以及在设计未明确处采用的做法**（均未修改设计文档）

1. **不受信任的请求答 `invalid_request`。** 设计没有规定原因码，封闭枚举中也没有 `unavailable` 或 `access_denied`。处理函数不会运行。
2. **拖放超过 100 个。** 设计表中的请求只有 `{paths}`。预加载只发送前 100 个路径，再把超出的个数加进主进程答复的 `truncated`；没有磁盘路径的 `File` 在预加载内记为 `file_unavailable` 并入答复。主进程 schema 拒绝超过 100 条的请求。
3. **对话框取消。** `pick-files` 取消时返回空的添加结果；`pick-output-directory` 取消时返回 `{directory: null}`。
4. **快照字段。** 除设计列出的字段外，快照保留队列的 `notice`（`state_reset`），由第一次快照取走。
5. **关停后的请求。** 通道保持注册，请求答 `busy`，而不是移除处理函数，避免渲染进程收到「没有处理函数」的异常。`registerMediaConverterIpc` 另外提供 `dispose()` 用于移除。
6. **非 Windows 平台。** 除 darwin 外，linux 等平台同样答 `platform_unsupported`、`supported` 为 false，与 `MediaRuntime.acquire` 一致。
7. **其他。** `reveal-output` 在文件已不在时答 `file_unavailable`。`FUSIONKIT_TEST_MEDIA_REVEAL=record` 只把文件名写成一行日志（`[media-converter] reveal-output recorded: <文件名>`），UI 测试需要从主进程输出中读取。`Window.mediaConverter` 声明为可选。
8. **contract 中 `ready` 状态的字段仍为可选。** T-ENGINE-03 建议在更新队列测试替身后改为必填，但 queue.test.ts 不在本任务写集内。快照顶层的 `resolvedEncoders` 与 `defaults` 是必填的。
9. **审计说明的日期。** 两份审计 JSON 追加的说明写为实际工作日 2026-10-28，与本记录日期一致。

**未执行与风险**

- 没有启动 Electron，因此以下内容未经实际运行验证：
  - contextBridge 传递 `File[]` 与 `webUtils.getPathForFile`；
  - 沙箱预加载中的 `process.platform`；
  - 真实的对话框、`shell.trashItem`、`powerSaveBlocker`、`app.getGPUInfo('basic')` 的字段；
  - `before-quit` 与安装更新时的关停流程。

  这些要在 workbench 的 quiet Electron 验证与用户验收中确认。
- 第一次进入工具页（`get-snapshot`）就会开始能力检测，包括硬件测试编码（BELOW_NORMAL）。这是设计的要求；检测失败不会自动重试，需要用户点「重新检测」。
- 回归运行包含已有的 capabilities.test.ts。其最后一组用例用随附 ffmpeg 在本机做了真实检测：每种配置编码 3 帧 lavfi 画面，BELOW_NORMAL 优先级，约 5 s，包括 RTX 4070 Ti SUPER 上的 NVENC。这不是本任务要求的检查。
- 没有运行全量测试。最终源码上运行过的检查只有本记录列出的这些。评审没有重跑实现阶段的回归（file:records/i1/T-ENGINE-06-regression.txt）：评审只改动了 `media-converter/ipc.ts`、`media-converter/index.ts` 与两份测试，仓库中引用这两个模块的测试只有这两份测试。
- 评审变异 R4（注册时就开始检测）发生时，「注册不校验运行时」用例会真的运行检测：校验随附运行时，并做 3 帧 lavfi 测试编码（BELOW_NORMAL，约 5 s，含 NVENC）。这个变异在两轮中各运行了一次，最终一轮没有再运行。
- 评审观察，不在本任务写集内，留给后续任务：
  - `previewPlan` 在规划失败（`no_encoder_available`）时只返回原因码。规划器给出的可替代编码（`alternatives`）不经 IPC 传出，界面无法据此建议改用其他编码。设计表只写了 `{code}`。
  - 一个 `items` 事件中只要有一个条目不合 schema，预加载就会丢弃整个事件，渲染进程会漏掉这次更新，直到下一次快照。队列侧目前产出的条目都合 schema。
  - 主进程注册失败时（例如 userData 路径异常），通道没有注册，渲染进程的调用会被拒绝（no handler），不会收到结构化的错误码。界面需要处理这种情况（FK-PIT-0079），长文本翻译的处理方式相同。
  - `addDroppedFiles` 只接受数组。渲染进程需要在 drop 事件中同步 `Array.from(dataTransfer.files)`，之后再清空输入（FK-PIT-0098），这由 workbench 负责。
- 快照与事件每次最多携带 500 个条目，大批量时的 IPC 负载与预加载校验耗时没有测量。

**批次 C 修正后的说明（2026-10-28）**

- 上文「差异」第 8 条（ready 状态字段可选）与「评审观察」第 1 条（`previewPlan` 不传替代编码）已解决。
- design §8 通道表中 `preview-plan` 的结果仍写作「`PlanSummary` 或 `{code}`」；新增的第三种结果记在 engine design §11，通道表本身没有改。

**评审后的说明（2026-10-28）**

- 「转换」任务遇到 `no_encoder_available` 时也会给出 alternatives（规划器按目标容器对应的编码计算）。但转换设置中没有编码可选，界面只应对「压缩」显示「改用 X」。这由 workbench 处理。
