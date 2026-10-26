# engine 任务

每个任务块就是唯一的任务台账，不另外手写状态汇总表，总览由脚本生成。任务只引用需求与 AC 编号，不复制 AC 文本。

**通用验证约定**

- 类型检查：`pnpm exec tsc --noEmit -p tsconfig.json`。
- 单元与集成测试：`npx vitest run --maxWorkers=4 --minWorkers=1 <路径>`。
- 真实 ffmpeg 测试只用测试时生成的 2 s 以内小样，以低优先级运行，日志级别 `level+warning`。stderr 中出现 `Invalid option`、`Error parsing option`、`auto-selecting format`、`only the last` 即判为失败。运行时缺失时跳过。
- 测试素材放在测试运行目录中，不放在 `%TEMP%` 根目录（FK-PIT-0099）。
- 不运行全量测试，不直接启动 electron.exe。UI 测试由 workbench 任务在 quiet 模式下运行。

**建议执行顺序**

T-ENGINE-01 → T-ENCODE-01 → T-ENGINE-02 → T-ENGINE-04 → T-ENGINE-05 → T-ENCODE-02 → T-ENCODE-03 → T-ENCODE-04 → T-ENGINE-03 → T-ENGINE-07 → T-ENGINE-06 → workbench。

### T-ENGINE-01 运行时校验与媒体探测

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENGINE-01, R-ENGINE-02 |
| 验收 | AC-ENGINE-01-1, AC-ENGINE-01-2, AC-ENGINE-02-1, AC-ENGINE-02-2, AC-ENGINE-02-3, AC-ENGINE-02-4, AC-ENGINE-02-5 |
| 依赖 | - |
| 写集 | electron/main/media-converter/engine/runtime.ts, electron/main/media-converter/engine/probe.ts, src/media-converter/contract.ts, test/media-converter/runtime.test.ts, test/media-converter/probe.test.ts, test/media-converter/fixtures/probe/ |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §1 实现 `MediaRuntime`。
- 按 design §2 实现探测：
  - 扩展名预检与 SILK 识别；
  - `-format_whitelist`、`-protocol_whitelist`；
  - 从流级侧数据识别 DOVI；
  - HDR10 首帧读取，读取时固定解复用器；
  - 容器标识（brand / DocType / 扩展名）；
  - ASS 样式检测；
  - 码率缺失时回退到 BPS；
  - 身份兜底；
  - 并发上限 4。
- `contract.ts` 先建立 `MediaInfo` 的 schema，并一次性列出 engine 的全部原因码枚举（见 requirements 与 design）。
- 夹具为文本 JSON，覆盖：竖屏、HDR10、HLG、DV5（传递特性未知）、DV8、VFR、封面音频、PGS、带样式的 ASS、MOV/MP4/M4A brand、WebM DocType、TS 偏移、无时长、FileId 全零。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENGINE-01-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/probe.test.ts（夹具规范化；HDR/DV/VFR/旋转/封面/字幕/ASS 样式分类；容器标识；扩展名拒绝；SILK；身份兜底） | - |
| V-ENGINE-01-2 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/runtime.test.ts（真实运行时：校验与缓存复检；runtime_missing / runtime_invalid / runtime_version_mismatch / runtime_spawn_failed 四种错误；在 PATH 前置一个假 ffmpeg 时不会使用它；lavfi 小样真实探测；引用运行目录外哨兵文件的 .m3u8 与改名为 .mp4 的 hls 播放列表都被拒绝，且 -v debug 日志中没有打开哨兵；100 个探测请求同时运行的不超过 4 个） | - |
| V-ENGINE-01-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENGINE-02 进程封装与进度

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENGINE-04 |
| 验收 | AC-ENGINE-04-1, AC-ENGINE-04-2, AC-ENGINE-04-3, AC-ENGINE-04-4, AC-ENGINE-04-5 |
| 依赖 | T-ENGINE-01 |
| 写集 | electron/main/media-converter/engine/process.ts, electron/main/media-converter/engine/progress.ts, test/media-converter/progress.test.ts, test/media-converter/process.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §4 实现：
  - 自有 spawn；
  - 优先级，以及低占用模式下的 PowerShell 亲和性设置；
  - 统一参数前缀，并在每个输入前固定解复用器；
  - 进度行解析；
  - stderr 环形缓冲与 `redactedTail`；
  - 分阶段停滞判定，阈值可注入；
  - 取消；
  - 成功判定，包括触顶、`disk_full`、`output_open_failed` 的识别；
  - 超长滤镜写文件，用 `-/filter:v:0`。
- 进度推送的节流放在 T-ENGINE-05；本任务的解析器是纯函数。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENGINE-02-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/progress.test.ts（N/A、负值、前导空格、out_time_ms 实为微秒、分块边界、超长行、progress=end、多阶段权重、ETA 平滑；脱敏：输入、临时、输出、工作路径都被替换，其他绝对路径按规则处理） | - |
| V-ENGINE-02-2 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/process.test.ts（真实 ffmpeg 编码 lavfi 小样，验证：BELOW_NORMAL 与低占用模式下的 IDLE 优先级及亲和性掩码可回读；参数中每个 -i 前都有 -f 与 -protocol_whitelist file；取消后 3 s 内退出；注入首包前、编码中、收尾三种阶段阈值后得到 encoder_stalled，而慢速但一直在前进的进程不被终止；大量 stderr 不会终止进程；-fs 触顶能被识别；故意截断的输出判为失败；无时长输入附 duration_unverified） | - |
| V-ENGINE-02-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENGINE-03 编码能力探测（真实参数）

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENGINE-03 |
| 验收 | AC-ENGINE-03-1, AC-ENGINE-03-2, AC-ENGINE-03-4 |
| 依赖 | T-ENGINE-02, T-ENCODE-02 |
| 写集 | electron/main/media-converter/engine/capabilities.ts, electron/main/media-converter/test-hooks.ts, src/media-converter/contract.ts, test/media-converter/capabilities.test.ts, test/media-converter/test-hooks.test.ts, test/media-converter/fixtures/capabilities/ |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §3 实现：
  - 解析软件能力；
  - 用 encode 的 `probeArgs` 生成各候选（编码器 × 位深 × tune）的真实参数，写 3 帧 MKV，再用 ffprobe 核对编码、像素格式与 profile；
  - 失败分类，含 `params_rejected`；
  - 单项超时 15 s、总预算 30 s；
  - 持久化规则：只缓存确定的结论；
  - 有硬件编码任务运行时，重新检测返回 busy；
  - 输出 `PlannerCapabilities`，包括 NVENC 最小尺寸与会话降级集。
- 按 design §9 实现 `test-hooks.ts`，本任务先实现 `FUSIONKIT_TEST_MEDIA_CAPS`，其余开关在 T-ENGINE-07 中补充。
- 本机实测的 stderr（QSV、AMF、D3D12、uhq 加 -bf 3、hevc_mf p010le 自动替换为 nv12）脱敏后作为文本夹具。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENGINE-03-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/capabilities.test.ts test/media-converter/test-hooks.test.ts（-encoders/-muxers/-filters 解析；各类 stderr 分类；auto-selecting format 与 ffprobe 核对不符都判为 params_rejected；session_limit/unknown/超时不持久化；缓存键变化才重测；30 s 预算；有硬件任务时重新检测返回 busy；d3d12va/vulkan 不入候选；打包模式下 FUSIONKIT_TEST_MEDIA_CAPS 被忽略） | - |
| V-ENGINE-03-2 | integration | required | 在本机（RTX 4070 Ti SUPER）真实运行能力探测并记录摘要。期望：h264_nvenc、hevc_nvenc（8/10-bit，uhq 与 hq）、av1_nvenc（uhq 与 hq）可用；h264_mf/hevc_mf 硬件（nv12）与 h264_mf 软件可用；hevc_mf 10-bit 为 params_rejected；QSV 与 AMF 分别为 no_device 与 runtime_missing；总耗时 ≤ 30 s | - |

Intel 核显和 AMD 显卡的能力探测无法在本机验证（本机没有这些设备），不作为本任务的完成条件，写入 record 的「风险与未执行项」，并列入 acceptance-I1 的未覆盖项。

### T-ENGINE-04 安全输出

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENGINE-06 |
| 验收 | AC-ENGINE-06-1, AC-ENGINE-06-2, AC-ENGINE-06-3, AC-ENGINE-06-4, AC-ENGINE-06-5 |
| 依赖 | T-ENGINE-01 |
| 写集 | electron/main/media-converter/engine/output.ts, electron/main/media-converter/engine/inputs.ts, test/media-converter/output.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §7 实现：
  - 记录 → `wx` 占位 → 记录身份 → 发布或删除前核对身份；
  - 硬链接发布，`EEXIST` 以外的错误走占位回退，失败时清理占位文件，FAT 卷按体积核对；
  - 覆盖：先移到回收站，失败报 `overwrite_trash_failed`；
  - 批内冲突；
  - `output_is_input`，身份不可用时比较真实路径；
  - 按卷汇总上限与空间检查；
  - FAT32 的 4 GiB 限制；
  - 启动清理规则与工作目录清理；
  - EBUSY 重试。
- `inputs.ts`：输入登记与身份核对，以及 design §8 的拖放封装与原因码映射，并提供 `resolveItemPath(itemId)`。
- `shell.trashItem`、`statfs`、卷类型查询都通过注入提供，便于测试。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENGINE-04-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/output.test.ts（在测试运行目录中验证：同名文件已存在时得到 (1)(2)，原文件字节不变；注入 EISDIR、EPERM 与未知错误码时走占位回退；rename 失败后不残留占位文件与临时文件；覆盖时旧文件经 trashItem 移走，注入 trashItem 失败时旧文件保留并报 overwrite_trash_failed；两个条目映射到同一目标名时自动编号并附 output_name_collision；同一文件改大小写、建硬链接或 FileId 全零时报 output_is_input；两个运行中条目共享一个卷时按汇总上限判定 disk_space_low；FAT32 加 5 GiB 上限时报 file_too_large_for_volume；启动清理中，卷未挂载与删除失败的记录保留、身份不符的不删除、已删除的移除记录；工作目录被清空） | - |
| V-ENGINE-04-2 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENGINE-05 主进程队列、持久化与生命周期

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENGINE-05 |
| 验收 | AC-ENGINE-05-1, AC-ENGINE-05-2, AC-ENGINE-05-3, AC-ENGINE-05-4, AC-ENGINE-05-5 |
| 依赖 | T-ENGINE-02, T-ENGINE-04, T-ENCODE-01 |
| 写集 | electron/main/media-converter/queue/queue.ts, electron/main/media-converter/queue/state-store.ts, electron/main/media-converter/queue/types.ts, src/media-converter/contract.ts, test/media-converter/queue.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §6 实现：
  - 状态机；
  - `start` 的确认流程：`confirmation_required`、`wouldReplace`、`confirmed`；
  - `retry` 的 `override`；
  - 冻结设置与计划；
  - 调度，并在运行前核对输入身份；
  - 队列选项只归主进程，通过 `set-options` 修改；
  - sequence 事件，进度每 250 ms 合并一次；
  - 持久化：16 KB 脱敏日志尾部、防抖原子写、启动恢复、500 条上限、损坏备份；
  - 批次定义与 `batch-finished`；
  - 关停与电源。
- 执行器只通过接口注入；本任务的单元测试用假执行器。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENGINE-05-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/queue.test.ts（假执行器验证：并发 1 与 2 的执行顺序；sequence 严格递增；每个条目每秒推送不超过 4 次；队列选项经 set-options 修改并持久化；运行前输入被删除时报 input_missing，被修改时报 input_changed；重启后运行中与排队条目变为 interrupted；超过 500 条时清理最早完成的；损坏的 state.json 被备份；错误日志尾部被截到 16 KB；需要确认但请求未带确认时返回 confirmation_required；覆盖策略下返回 wouldReplace；retry 的 override 生效；shutdown 取消并等待所有执行器结束；电源阻止的获取与释放；按批次定义只发一次 batch-finished，批次运行中新加入的条目归入同一批） | - |
| V-ENGINE-05-2 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENGINE-07 执行器：单个条目的端到端执行

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENGINE-03, R-ENGINE-04, R-ENGINE-06 |
| 验收 | AC-ENGINE-03-3, AC-ENGINE-04-3, AC-ENGINE-04-5, AC-ENGINE-06-1, AC-ENGINE-06-4 |
| 依赖 | T-ENGINE-03, T-ENGINE-05, T-ENCODE-02, T-ENCODE-03, T-ENCODE-04 |
| 写集 | electron/main/media-converter/engine/executor.ts, electron/main/media-converter/test-hooks.ts, test/media-converter/executor.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §5 实现完整流程：
  - 运行时与前置检查；
  - 对每个输出：记录 → 占位 → 生成参数 → 运行 → 成功判定 → 重新探测 → 体积比较 → 发布或清理；
  - 首包前硬件失败时降级、重新生成计划并重试一次，计划摘要中加入 `encoder_fallback`；
  - 多输出条目的部分完成。
- 在 `test-hooks.ts` 中补充 `FUSIONKIT_TEST_MEDIA_FAIL` 与 `FUSIONKIT_TEST_MEDIA_REVEAL`。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENGINE-07-1 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/executor.test.ts（真实 ffmpeg，低优先级，2 s lavfi 小样，验证：压缩、转换、提取都能发布且可以重新探测；把已高度压缩的静态画面源用「画质优先」压缩，提前触顶，状态为 skipped{not_smaller}，不残留 .partial；取消后临时文件、日志与工作目录都被删除；注入 nvenc 在首包前失败后，改用下一个编码器重试一次，并附 encoder_fallback；注入首包后失败时不重试；statfs 注入空间不足时报 disk_space_low；提取 2 条音轨时第 2 条注入失败，结果为部分完成，第 1 条已发布） | - |
| V-ENGINE-07-2 | static | required | pnpm exec tsc --noEmit -p tsconfig.json | - |

### T-ENGINE-06 IPC、预加载 API、注册与审计登记

| 字段 | 值 |
| --- | --- |
| 状态 | 未开始 |
| 批次 | I1 |
| 需求 | R-ENGINE-07, R-ENGINE-01, R-ENGINE-05 |
| 验收 | AC-ENGINE-07-1, AC-ENGINE-07-2, AC-ENGINE-07-3, AC-ENGINE-01-3, AC-ENGINE-05-4 |
| 依赖 | T-ENGINE-07 |
| 写集 | src/media-converter/channels.ts, src/media-converter/contract.ts, electron/preload/media-converter-api.ts, electron/preload/media-converter-channel-policy.ts, electron/preload/index.ts, electron/main/media-converter/ipc.ts, electron/main/media-converter/index.ts, electron/main/index.ts, src/vite-env.d.ts, scripts/subtitle-studio-provenance/current-composition-audits.json, resources/speech-resources/provenance/current-integration-audits.v1.json, test/media-converter/ipc.test.ts, test/media-converter/composition.test.ts |
| 负责人 | - |
| 依赖确认 | - |
| 完成日期 | - |
| 实施记录 | - |
| 集成版本 | - |

#### 实现要点

- 按 design §8 实现：
  - 通道表；
  - zod 校验；
  - 信任判定；
  - 预加载 API：同步取路径、`supported`、事件校验；
  - 遗留桥拦截；
  - `Window` 类型；
  - `resolvedEncoders`；
  - 主进程注册：各平台都注册，darwin 下统一返回 `platform_unsupported`；
  - 加入关停流程。
- 主进程与预加载的 `index.ts` 最后一次修改后，用 `git hash-object` 重新登记两份审计 JSON 的 `currentBlobOid`，并在 `reason` 后追加一句带日期的说明。

#### 验证计划

| 检查 | 类型 | 要求 | 命令或步骤 | 不适用理由 |
| --- | --- | --- | --- | --- |
| V-ENGINE-06-1 | unit | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/ipc.test.ts（不受信任的发送方与子框架被拒；非法参数返回 invalid_request；渲染进程无法提交路径；reveal-output 只接受本工具的输出；拖放时文件夹返回 folder_not_supported；mock 解析器：1 个 %TEMP% 路径加 1 个普通路径时，结果为加入 1 个、拒绝 1 个（temporary_copy_unresolved）；快照与事件中的错误日志已脱敏，不含任何绝对路径） | - |
| V-ENGINE-06-2 | integration | required | npx vitest run --maxWorkers=4 --minWorkers=1 test/media-converter/composition.test.ts（预加载暴露 mediaConverter；遗留桥拒绝 media-converter: 前缀；主进程已注册并加入关停数组；把平台打桩为 darwin 时，任一通道都返回 platform_unsupported，且 supported 为 false） | - |
| V-ENGINE-06-3 | static | required | pnpm exec tsc --noEmit -p tsconfig.json；先执行 vite build --mode=test，再执行 node scripts/check-preload-bundle.mjs | - |
| V-ENGINE-06-4 | integration | required | node scripts/subtitle-studio-provenance/shared-resource-integration.mjs 与 npx vitest run --maxWorkers=4 --minWorkers=1 test/subtitle-studio-provenance | - |
