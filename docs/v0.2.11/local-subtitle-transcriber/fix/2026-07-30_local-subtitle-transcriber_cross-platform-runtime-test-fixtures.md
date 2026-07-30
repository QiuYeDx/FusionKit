# Local Subtitle Transcriber 修正：跨平台 runtime 测试夹具

## 背景与现象

macOS arm64 执行完整 runtime Node suite 时，3 组原本用于验证 Windows 语义的纯测试夹具产生 6 个假失败：

1. Windows smoke environment 测试把硬编码 `C:\...` 字符串交给当前宿主的 `path.delimiter`/路径实现处理，macOS 无法按 Windows 目录语义解析。
2. PRE-005 sanitized-PATH 测试假定宿主存在真实 `C:\Windows\System32\where.exe`；该前提只在 Windows 成立。
3. CUDA stager 的 4 个测试从 macOS `os.tmpdir()` 的 `/var/...` 别名创建 fixture，而 `realpath` 后实际位于 `/private/var/...`；严格 ancestor identity 检查将词法路径与 canonical 路径差异正确拒绝，但这不是 fixture 想覆盖的 symlink/junction 攻击。

这些失败只发生在 fabricated fixture，不表示 Windows 产品逻辑失败，也不能通过跳过所有非当前平台测试来隐藏。

## 根因

测试把目标平台语义与宿主文件系统事实混在了一起：Windows 字符串夹具仍由 macOS path API 解释，虚构的系统文件被当成真实文件，临时目录则未先固定 canonical identity。production verifier 的严格 no-PATH、canonical ancestor、symlink/junction 与 artifact identity 检查本身没有问题。

## 修正内容

### `run-native002-windows-smoke.test.mjs`

Windows environment fixture 中的 `SystemRoot`、`ProgramFiles`、`ProgramW6432`、untrusted PATH、CUDA path 与 COMSPEC 改为从同一 host-native test root 使用 `path.join()` 构造。测试继续验证最小 Windows environment、secret/proxy/CUDA authority 剥离和 no-PATH 合同，但不再要求 macOS 解释反斜杠盘符。

### `run-pre005-smoke.test.mjs`

测试在 canonical host temp 下创建私有目录及一个名为 `where.exe` 的普通 fixture 文件，并把该目录作为 Windows sanitized PATH 传给纯查找函数。存在与缺失两条分支仍实测；测试结束删除 fixture。没有 spawn 宿主 `where.exe`，也没有 platform skip。

### `stage-runtime-windows-x64-cuda.test.mjs`

`mkdtemp()` 前先对 `os.tmpdir()` 执行 `realpath()`，再从 canonical temp parent 创建 project/archive/expanded/output fixtures。这样测试输入满足自己声明的 canonical parent 前提，既有 symlink/junction、越界与 no-clobber 负向用例仍按原强度执行。

## 安全边界

- 只修改上述 3 个 test fixture 文件，没有为本修正改动 production runtime/stager/verifier 代码。
- 没有把纯合同测试改成 macOS skip，也没有减少 Windows 目标机复验要求。
- 没有放宽 canonical ancestor、realpath、symlink/junction、no-PATH、missing/corrupt/non-executable 或 fail-closed 判定。
- Windows x64 的真实 app/NSIS、CPU/CUDA 和 NTFS 矩阵仍必须在目标机执行；macOS 上的跨平台测试通过不能替代目标机证据。

## 验证结果

fixture 修复完成时执行：

```text
node --test scripts/local-subtitle/runtime/*.test.mjs
```

当时 suite 统计为 118 tests total：117 passed、0 failed、1 expected Windows-only skip。

本轮随后新增 packaged validator/signing tests；最终同一 runtime suite 统计为 124 tests total：123 passed、0 failed、1 expected Windows-only skip。新增测试不会改变对本 fix 的归因：本文件只记录 3 个跨平台 fixture 修正，packaged validator 与 signing 完整性增强归 `NATIVE-002C` 实施记录。

同时通过：

```text
node scripts/local-subtitle/runtime/validate-runtime-staging.mjs --platform darwin --arch arm64
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build
git diff --check
```

## 影响与后续

macOS Agent 现在可以稳定运行包含 Windows 纯合同用例的 runtime suite，从而在目标机不可用时提前发现平台中立回归。真实性边界不变：Windows executable/DLL、CUDA exact-PID VRAM、NSIS、带空格/非 ASCII 路径和 NTFS recovery 只能由真实 Windows x64 目标机关闭。
