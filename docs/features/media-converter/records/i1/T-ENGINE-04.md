# 实施记录：T-ENGINE-04

| 字段 | 值 |
| --- | --- |
| 任务 | T-ENGINE-04 |
| 日期 | 2026-10-26 |
| 验证版本 | snapshot-sha256:5579dbb538e03b5912d86acc11662f27c209f56e2d27609db6e2dd485f542d06（基线 a742ec76 + 未提交工作树）。评审修复后取得：在最后一次代码修改、全部验证与证据文件写入之后，本记录更新之前；本记录文件的更新未计入。此时 `output.ts` 的 sha256 为 527ac00f…，`inputs.ts` 为 b14d32ab…。工作树中还有其他任务的智能体正在编写的未跟踪文件（`engine/process.ts`、`engine/progress.ts`、`plan/*` 及其测试等），快照包含它们。实现方初版的快照是 d68aa0ca…，已被本版本取代。 |
| 环境 | Windows 11 Pro 10.0.26200；Node v20.19.4；Vitest 2.1.9；随附 ffmpeg/ffprobe n8.1.2-21-gce3c09c101-20260630（BtbN，LGPL），经 `verifyLocalSubtitleRuntimeBundle` 校验；RTX 4070 Ti SUPER（未使用 GPU 编码）。随附 ffmpeg 只运行一次 0.5 s 的 lavfi 正弦音，经 `MediaRuntime` 以 BELOW_NORMAL 优先级运行。测试文件位于 NTFS 卷 C:。 |
| 任务指纹 | 96fca2d3c4c4731e73b890c9ddeb4d633cf9ea8a79ca5eb6ca5e1d42d75f2d7b |

## 实际结果

本任务没有界面部分，不涉及截图。

**新增文件（均在写集内）**

- `electron/main/media-converter/engine/output.ts`：`MediaOutputs` 类（每个应用一个实例），以及几个独立导出的函数。
  - **临时文件。** `createPartial(dir)` 的顺序：
    1. 用 `atomicWriteUtf8File` 把 `{id, path, expectedName, volume, identity:null}` 写入 `userData/media-converter/partials.json`；
    2. `open(path,'wx')` 创建 `.fusionkit-media-<8 位 hex>.partial`；
    3. 从句柄取身份（`localSubtitleFilesystemObjectIdentityForHandle`），写回记录。

    日志写入串行且原子；写不进日志时不创建临时文件。`verifyPartial` 核对身份。`discardPartial` 删除前核对身份：身份不符的文件不删，只移除记录；删除失败时保留记录。
  - **发布：自动编号。** `publish` 依次尝试 `名称.扩展名`、`名称 (1).扩展名`……最多 10,000 个。
    - 先用 `fs.link`，`EEXIST` 时换下一个编号。成功后先核对新名称确实指向本文件，再按 FK-PIT-0044 删除临时名称。临时名称删不掉时，它只是已发布文件的第二个名称；记录保留，由启动清理处理。
    - `link` 返回 `EEXIST` 以外的任何错误（包括没有 code 的错误）时，本卷改走占位流程：`open(候选,'wx')` 占位并取身份 → 再次核对临时文件身份 → 确认占位仍是本工具创建的空文件 → `rename` 覆盖占位。创建占位时遇到 `EPERM`/`EBUSY`，且该名称上有文件（含等待删除的文件）时，视为名称已被占用，换下一个编号。
    - rename 失败时，只删除仍为 0 字节且身份未变的占位文件。
    - rename 成功后核对结果：FAT 族卷（fat/fat32/exfat）、卷类型未知（网络共享、查询失败）或临时文件的 FileId 不可用时，按体积核对；其他卷按身份核对。
    - 任何失败都会丢弃临时文件。
  - **发布：覆盖。**
    - 目标处是普通文件时，先确认它不是任何输入（`output_is_input`），再用注入的 `trashItem` 移入回收站。移不走时报 `overwrite_trash_failed`，从不永久删除。
    - 移走后仍以不覆盖的方式（link 或占位）放到该名称。名称上又出现文件时最多再处理两轮，仍不成功则报 `overwrite_trash_failed`。
    - 目标处是文件夹或链接，或者无法查看（例如等待删除的文件，lstat 返回 `EPERM`）时，从不移入回收站，改为自动编号。
  - **批内冲突。** 一个批次内的名称认领表（Windows 下不区分大小写）。
    - `preflight` 认领目标名。同批另一条目解析到同一名称时，附 `output_name_collision`。
    - 发布时跳过其他条目认领或已发布的名称，改为自动编号；覆盖策略下同样不会替换这些名称。
    - `release(owner)` 归还未发布的认领与空间预留；`endBatch()` 清空认领表。
  - **`outputIsInput`。** 按卷序列号 + FileId 比较，可识别大小写不同与硬链接。任一方 FileId 不可用（全零）时，比较规范化后的真实路径（不区分大小写）。
  - **`preflight`。** 依次检查：
    1. 目标目录存在且是目录，否则 `output_dir_unwritable`；
    2. 路径不超过 259 个字符，否则 `output_path_too_long`；
    3. 目标不是任何输入，否则 `output_is_input`；
    4. 卷为 FAT32/FAT 且上限 > 4 GiB − 1 时，报 `file_too_large_for_volume`；
    5. 本卷所有运行中条目的上限 + 本条目上限 + 512 MB 与 `statfs` 的可用空间比较，不足时报 `disk_space_low`，附所需与可用字节数。

    全部通过后预留空间并认领名称。
  - **卷类型。** 默认实现 `windowsVolumeFileSystem` 运行 PowerShell `(Get-Volume -DriveLetter X -ErrorAction Stop).FileSystemType`（隐藏窗口，10 s 超时）。UNC 路径、非 Windows 平台或查询失败时为未知（null）。结果按「盘符 + 卷序列号」在会话内缓存；只在上限超过 FAT32 限制或走占位流程时才查询。
  - **`outputLimitArgs(cap, durationUs)`。** 返回 `-fs <cap>`；时长已知时再加 `-t <max(时长×1.05, 时长+10 s)>`，精度为微秒。
  - **重试。** `retryWhileBusy`：`rename`、`unlink`、`trashItem` 遇到 `EBUSY`/`EPERM` 时，分别等待 150/300/600/950 ms 后重试，共 5 次，约 2 s。
  - **启动清理（`cleanupAtStartup`）。** 主要规则见 AC-ENGINE-06-5，另有以下几条：
    - 目录已不存在时，向上找最近的现存目录：它在记录的卷上，才视为文件不存在；否则视为卷未挂载（盘符可能已被另一个卷占用），保留记录；
    - 没有身份的记录（在写记录与创建文件之间崩溃）只删除 0 字节文件；
    - 本实例创建且尚未结束的临时文件不处理；
    - 读取时丢弃不合法的记录（文件名不是 `.fusionkit-media-<id>.partial`，或与 id 不对应），从不依据它删除文件；
    - 无法解析的日志改名为 `partials.corrupt.json` 保留，不凭猜测删除文件。

    最后运行 `fs.rm(work,{recursive,force,maxRetries:5,retryDelay:200})`，再重建为空目录。`workDirectory(id)` 与 `removeWorkDirectory(id)` 供执行器使用。
  - **注入。** `shell.trashItem`、`statfs`、卷类型、卷标识、身份读取、文件操作和等待函数都可注入。模块不 import electron。
- `electron/main/media-converter/engine/inputs.ts`：
  - `InputRegistry`：
    - 维护条目 id → 路径的映射，路径只由主进程持有。
    - 登记时记录文件状态：对象身份、体积、修改时间，不含 ctime。
    - 同一文件重复添加时返回已有条目：FileId 可用时按身份判断，否则按不区分大小写的路径。
    - `verify(itemId)` 返回 `input_missing` 或 `input_changed`；`refresh` 在重试时接受文件现状。
    - `restore` 与 `entries` 供队列持久化；`restore` 校验持久化的状态（身份结构、体积、修改时间），不合格时抛出 `TypeError`。
    - `resolveItemPath(itemId)`；`describe(itemId)` 只给显示名与文件夹名；`paths()` 供 `output_is_input` 检查。
  - `resolveDroppedMediaPaths(paths, {resolve?, tempDirectory?})`：包装 `resolveDroppedInputPaths`，解析器可注入。
    - 原因码映射：`invalid_input` 中目录为 `folder_not_supported`，其余为 `not_a_regular_file`；`document_unavailable` 为 `file_unavailable`。
    - 整批被拒（`access_denied`，或解析器抛错）时：位于临时目录中的路径（规范化后不区分大小写比较）报 `temporary_copy_unresolved`；其他路径逐个重新校验后按原样加入。
    - 不是完全限定的路径报 `file_unavailable`。
    - 结果按拖放顺序逐条返回。
  - 公共辅助函数：`fullyQualifiedPath`（允许目录以分隔符结尾）、`canonicalPath`、`readInputState`。
- `test/media-converter/output.test.ts`：49 项测试（实现方 44 项，评审补充 5 项并加强了 4 项）。

**用真实文件与随附 ffmpeg 核对的事实**

- 先在临时文件中写入约 47 KB 旧内容，再用随附 ffmpeg 以 `-f wav -y file:<partial>` 写入。写入后身份不变，旧内容被截断；发布为 `tone.wav` 后身份仍与临时文件相同（硬链接发布）。design §7 第 4 步「打开时截断，文件身份不变」在本机 NTFS 上成立。
- 本机 `Get-Volume -DriveLetter C` 返回 NTFS，耗时约 1–3 s，所以只在需要时查询，并按卷缓存。
- 在 NTFS 上删除文件后同名重建，新文件的 FileId 不同。体积与修改时间都相同时，只能靠 FileId 识别出 `input_changed`（已有测试覆盖）。
- Node 在 Windows 上对目录联接（junction）执行 `lstat`，报告为符号链接；拖放时得到 `not_a_regular_file`。

**变异检查**

做法：每次临时修改一处源文件，运行 output.test.ts，之后用 sha256 确认源文件已还原。23 个变异全部被测试发现，证据见 file:records/i1/T-ENGINE-04-mutation.txt。

第一轮中，「去掉发布前的临时文件身份核对」没有被发现，因为 link 之后的核对兜住了 link 路径。但在占位流程中，没有这项核对，被替换的文件会先被移动到最终名称。为此新增测试「占位流程中被替换的临时文件不会被移动」，复跑后该变异被发现。

**评审与修复（2026-10-26，独立评审）**

评审逐条对照了 AC-ENGINE-06-1～5、design §7/§8 与写集内全部代码，并在本机实测了 Windows 的几种边界行为（脚本放在会话 scratchpad，运行目录用后即删）：

- 文件被删除、但仍有句柄打开时（等待删除），名称不会消失：`lstat` 与 `open(…,'wx')` 都返回 `EPERM`，`link` 返回 `EEXIST`；
- 以 `wx` 打开 `a:b.mp4` 会创建 0 字节文件 `a`，并写入其备用数据流 `b.mp4`；`link` 到这种名称返回 `EINVAL`，随后会走占位回退。

没有发现阻断问题。初版实现总体严谨：顺序、身份核对、回退与清理规则都有测试，且测试不是空转。发现并修复的问题如下（均在写集内）：

1. **启动清理误删「卷未挂载」的记录（主要）。** 记录所在目录不存在时，初版只看盘符根目录是否存在。移动盘拔出、盘符又分给另一个卷后，记录会被当作「文件不存在」移除，违反 AC-ENGINE-06-5「卷未挂载时保留记录」。现在改为向上找最近的现存目录，比较它的卷与记录中的卷：一致才移除，否则保留。新增测试「目录已不存在、最近的现存目录在另一个卷上时保留记录」。
2. **等待删除的同名文件让整次编码作废（主要）。** 占位流程中，`open(候选,'wx')` 遇到等待删除的文件会返回 `EPERM`，初版直接报 `output_dir_unwritable` 并丢弃临时文件，几个小时的编码就白做了。覆盖策略下，`lstat(目标)` 返回 `EPERM` 也会让发布失败。现在：
   - 创建占位遇到 `EPERM`/`EBUSY`，且该名称上有文件（`lstat` 成功或返回 `EPERM`/`EBUSY`）时，视为已被占用，换下一个编号；名称上确实没有文件时，仍报 `output_dir_unwritable`；
   - 覆盖策略下，无法查看的目标名不会被移入回收站，改为自动编号。

   新增测试：注入 `EPERM`（有文件时换号，无文件时失败）；以真实的等待删除文件分别验证硬链接、占位、覆盖三条路径。
3. **占位文件在 rename 前被他人写入时会被覆盖（次要）。** rename 会替换名称上的任何内容。现在 rename 前再确认占位仍是本工具创建的空文件，否则把名称留给对方，换下一个编号。时间窗口从「创建占位到 rename」缩小到「检查到 rename」之间。新增注入测试。原有的 FAT 体积核对测试改为只在 rename 之后才模拟 FileId 变化：初版的模拟让占位文件在 rename 前就变了身份，与实际不符。
4. **卷类型未知时，rename 后的核对可能误报失败（次要）。** UNC 路径或卷类型查询失败时，初版按身份核对，而这类卷的 FileId 可能在 rename 后改变。结果是文件已在最终位置，任务却报失败。现在卷类型未知时按体积核对；NTFS 等已知卷仍按身份核对。新增测试：卷类型未知时按体积通过；FAT32 上体积不符时报失败。
5. **`numberedName` 防御不足（次要）。** 初版只拒绝 `/`、`\`、NUL。encode 的命名已经清理过名称，这里作为纵深防御，补充拒绝 Windows 非法字符：`:` 会写入备用数据流，其他还有 `<>"|?*` 和控制字符；同时拒绝设备名（CON、NUL、COM1…，含带后缀的写法）。
6. **状态目录未要求为绝对路径（次要）。** 启动清理会清空 `<root>/work`，传入相对路径时会清空当前工作目录下的 `work`。构造函数现在要求 `root` 为完全限定路径。
7. **`createPartial` 关闭句柄失败时抛出原始错误（次要）。** 现在与占位流程一致，句柄在 `finally` 中关闭，失败时忽略；身份读取失败仍报 `output_dir_unwritable`。
8. **`InputRegistry.restore` 不校验持久化状态（次要）。** 现在校验 `objectIdentity`（null 或合法身份）、`size`（非负安全整数）与 `mtimeMs`（非负有限数），不合格时抛出 `TypeError`。新增测试。

修复后的验证：

- output.test.ts 共 49 项，全部通过，无跳过。
- 实现方的 23 个变异在评审后的代码上全部被发现。M4、M12、M16 改为针对重构后的代码行。
- 针对评审修复另加 11 个变异，同样全部被发现，见 file:records/i1/T-ENGINE-04-mutation.txt 的评审部分。
- 每轮变异后都用 sha256 确认源文件已还原。

评审认可、未改动的实现方偏差：原因码用 `output_dir_unwritable` 兜底；覆盖时以不替换的方式放置；Get-Volume 按盘符查询；259 字符上限；partials.json 的附加字段。理由见下文「与设计的差异」。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ENGINE-04-1 | 通过 | file:records/i1/T-ENGINE-04-output.txt |
| V-ENGINE-04-2 | 通过 | file:records/i1/T-ENGINE-04-tsc.txt |

- V-ENGINE-04-1：（评审修复后重跑：49 passed，无跳过，exit 0）。verbose 用例清单覆盖：<br>- 同名文件已存在时得到 (1)(2)，原文件的字节、身份与修改时间都不变；<br>- 注入 EISDIR、EPERM、EXDEV、ENOTSUP、UNKNOWN、未知码 EWHATEVER 与无 code 的错误时，走占位回退；<br>- rename 失败（含持续 EBUSY 重试 5 次）后，不残留占位文件与临时文件；不再为空的占位文件不删除；rename 前被他人写入的占位文件不被覆盖；<br>- 被等待删除的文件占着的名称：硬链接与占位两条路径都换号；占位遇到 EPERM 而名称上没有文件时报 output_dir_unwritable；<br>- 覆盖时旧文件经 trashItem 移走；trashItem 失败或「报成功但没移走」时，旧文件保留并报 overwrite_trash_failed；等待删除的文件不移入回收站，改为编号；<br>- 两个条目映射到同一目标名时自动编号并附 output_name_collision（含覆盖策略与批次结束后）；<br>- 同一文件改大小写、硬链接、FileId 全零时报 output_is_input，全零 FileId 的其他文件不误报；<br>- 两个运行中条目共享一个卷时，按汇总上限判定 disk_space_low，并给出所需与可用字节数；<br>- FAT32 加 5 GiB 上限时报 file_too_large_for_volume；<br>- 启动清理：卷未挂载、另一卷挂在同一位置、目录已删且盘符换了卷、删除失败的记录保留；身份不符的文件不删除；已删除的移除记录；工作目录被清空；<br>- 附加：日志先于文件写入、ffmpeg 截断写入不改变身份、FAT 与未知卷按体积核对、名称中的非法字符与设备名被拒绝、相对的状态目录被拒绝、输入登记（含持久化状态校验）与拖放封装。<br>变异检查见 file:records/i1/T-ENGINE-04-mutation.txt：实现方的 23 个变异，以及评审另加的 11 个，在评审后的代码上全部被发现；源文件已按 sha256 还原。
- V-ENGINE-04-2：评审修复后重跑：`pnpm exec tsc --noEmit -p tsconfig.json` 无诊断，exit 0；测试文件另用继承仓库配置的临时 tsconfig 检查，同样无诊断，exit 0

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ENGINE-06-1 | 通过 | V-ENGINE-04-1, V-ENGINE-04-2 |
| AC-ENGINE-06-2 | 通过 | V-ENGINE-04-1, V-ENGINE-04-2 |
| AC-ENGINE-06-3 | 通过 | V-ENGINE-04-1, V-ENGINE-04-2 |
| AC-ENGINE-06-4 | 通过 | V-ENGINE-04-1, V-ENGINE-04-2 |
| AC-ENGINE-06-5 | 通过 | V-ENGINE-04-1, V-ENGINE-04-2 |

AC 结果只覆盖本任务写集内的部分。评审复核后维持「通过」：AC-ENGINE-06-1 与 AC-ENGINE-06-4 同时列在 T-ENGINE-07 的验收中，其中由执行器与进程封装接线的部分（ffmpeg 的 `-f … -y` 写入、`-fs`/`-t` 接入、触顶语义、`disk_full`）在本任务中未验证，留待 T-ENGINE-07 判定。这些部分见下一节。

## 风险与未执行项

**由后续任务接线的部分**

- AC-ENGINE-06-1 第 3 步：ffmpeg 以 `-f <muxer> -y file:<partial>` 写入，由 encode 的 `toFfmpegArgs` 与执行器（T-ENGINE-07）组装。本任务提供 `PartialFile.path`，并用随附 ffmpeg 验证了截断写入不改变身份。失败或取消时调用 `discardPartial`，也由执行器完成。T-ENGINE-07 的验收同样列有 AC-ENGINE-06-1。
- AC-ENGINE-06-4：
  - 每个输出带 `-fs`/`-t`：由执行器调用 `outputLimitArgs` 接入。
  - 触顶语义（`not_smaller`/`output_cap_exceeded`）与 `disk_full` 的识别：属于 T-ENGINE-02（进程）与 T-ENGINE-07（执行器，验收中同样列有 AC-ENGINE-06-4），本任务没有验证这两部分。
- AC-ENGINE-06-3：
  - 「覆盖只在当前会话有效」：引擎不保存冲突策略，每次请求传入；渲染进程的偏好也不保存冲突策略（workbench design），由 workbench 任务实现。
  - 开始前确认被替换文件清单（`start` 返回 `wouldReplace`）：由 T-ENGINE-05 实现，本任务提供 `wouldReplace()`。
- 输入身份：运行前与重启后的核对，由队列（T-ENGINE-05）调用 `InputRegistry.verify`。拖放封装的 IPC 接线与单次 100 个文件的上限，在 T-ENGINE-06 完成。

**与设计的差异，以及在设计未明确处采用的做法**（均未修改设计文档）

1. **原因码。** 发布失败（占位创建失败、rename 失败、临时文件被替换、发布后核对不符、全部编号已被占用）和写不进 partials.json 时，原因码用 `output_dir_unwritable`。contract.ts 的封闭枚举中没有更贴切的码，而 contract.ts 不在本任务写集内。若需要单独的码（例如 `output_publish_failed`），应由写集包含 contract.ts 的任务添加。
2. **`output_is_input` 的检查时机。** 开始前对两种冲突策略都检查，因为 AC 没有限定策略。发布时只在覆盖策略下、移入回收站之前再查一次：自动编号以不覆盖的方式发布，不可能替换输入。
3. **覆盖的放置方式。** design 写的是「trashItem 后 rename(partial, final)」。实现改为移入回收站后仍以不覆盖的方式放置（link 或占位），避免回收站之后才出现的同名文件被 rename 静默替换。名称反复被占用时最多处理 3 轮，之后报 `overwrite_trash_failed`。目标是文件夹或链接，或者无法查看（等待删除）时，不移入回收站，改为自动编号。
4. **卷类型查询。** 用 PowerShell `Get-Volume -DriveLetter`。design 允许 fsutil 或 GetVolumeInformation 二选一，编排说明指定了这种方式。挂载到文件夹的卷，报告的是盘符所在卷的类型；UNC 路径为未知：不做 FAT32 检查，占位 rename 后按体积核对（评审修改）。
5. **FAT32 判定。** 按「上限 > 4 GiB − 1 字节」判断，因为 FAT32 单个文件最大为 4 GiB − 1 字节；`fat`（FAT16）同样适用。
6. **路径上限。** 最终路径（含编号）按 259 个 UTF-16 单元判断，即 MAX_PATH 减去结束符。encode 已把基础路径限制在 240 以内，编号最多再加 7 个字符。
7. **启动清理的细节。**
   - 「身份不符」时文件不删除，同时移除记录：本工具的文件已确认不在该名称下。
   - 目录已不存在时，最近的现存上级目录在记录的卷上，才视为文件不存在；否则保留记录（评审修改，原为「盘符根目录存在即视为文件不存在」）。
   - 目录所在卷的标识与记录不同（另一个卷挂在同一位置）时，视为未挂载，保留记录。
8. **partials.json 的字段。** 除 design 中的 `{path, volume, expectedName}` 外，还有 `id`、`identity`、`createdAt`。`volume` 是目录所在卷的标识，在 Windows 上是卷序列号。
9. **拖放封装。** 解析器抛错，或返回的结果数量不符时，同样按整批被拒处理。
10. **`statfs` 失败。** 磁盘空间检查中 `statfs` 失败时报 `output_dir_unwritable`。

**测试覆盖的局限**

- 没有在真实的 FAT32/exFAT 卷、网络盘或可移动盘上测试。硬链接的失败码、rename 后 FileId 的变化、Get-Volume 在这些卷上的返回值，都是注入模拟的。design 中 exFAT 返回 `EISDIR` 来自此前的实测。
- 回收站用注入的桩代替，没有调用真实的 `shell.trashItem`（需要 Electron）。真实回收站的行为，待执行器或 IPC 集成测试、或用户验收时确认。
- 「卷未挂载」用本机不存在的盘符模拟，没有拔出真实的移动盘。
- 占位流程中，「占位之后、rename 之前临时文件被替换」这个时间窗口无法稳定复现；只验证了占位之前就被替换的情况。评审在 rename 前补了一次占位核对，并用注入验证了「占位被他人写入」的情况；检查与 rename 之间仍有极短的窗口，Windows 没有「只替换指定文件」的 rename。
- 等待删除的文件只在本机 NTFS 上实测（`lstat`/`open wx` 返回 `EPERM`，`link` 返回 `EEXIST`）。名称会被立即释放的文件系统上，相关测试按「名称空闲」分支断言。

**潜在风险**

- 硬链接发布后，如果临时名称删不掉，输出目录中会暂时多一个隐藏的 `.partial` 名称。它与输出是同一个文件，不占额外空间，下次启动清理时删除。
- 第一次查询卷类型需要启动 PowerShell，本机约 1–3 s。只在上限超过 4 GiB 或走占位流程时发生，并按卷缓存。
- 同一会话内，`#live` 保证启动清理不会删除运行中的临时文件，但 `cleanupAtStartup` 仍应只在注册时调用一次（T-ENGINE-06）。

**未执行项与运行环境说明**

- 没有运行全量测试，也没有启动 Electron。
- 测试在 `test-results/media-converter/output-*` 下创建运行目录，结束后删除。拖放测试中的「临时目录」是运行目录里的子目录，没有使用 `%TEMP%`。测试调用一次 PowerShell `Get-Volume`（隐藏窗口）。
- 变异检查的脚本放在会话 scratchpad 中，不在仓库里；每个变异运行后，都用 sha256 确认源文件已还原。
- 验证版本快照在更新本记录之前取得，本记录的更新会改变工作树哈希。
- 评审没有使用真实回收站、FAT 卷或网络盘。等待删除与备用数据流的行为，是用会话 scratchpad 中的一次性 Node 脚本在本机 NTFS 上实测的，运行目录用后即删。
- 评审中未修改、仅记录的观察：
  - 覆盖策略在发布时替换的是当时该名称上的普通文件，可能不是开始前确认的那一个（在开始到发布之间新出现的文件同样会被移入回收站，可以从回收站恢复）。是否需要按确认清单再核对一次，由 T-ENGINE-05/07 决定。
  - 占位创建后读取身份失败时，0 字节占位文件留在最终名称上，因为无法证明它是本工具创建的。
  - `#overwrite` 第一轮已把旧文件移入回收站、之后又改为编号时，结果中的 `replaced` 为 false。
  - UNC 卷上 `statfs` 失败会报 `output_dir_unwritable`，未在真实网络盘上验证。
