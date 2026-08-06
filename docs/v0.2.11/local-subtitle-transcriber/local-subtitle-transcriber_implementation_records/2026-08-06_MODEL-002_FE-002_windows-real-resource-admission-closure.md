# 工作包 MODEL-002 / FE-002：Windows 真实资源与 Production Admission 结项

## 基本信息

- 日期：2026-08-06
- 状态：已完成（代码、真实资源生命周期与目标组件职责完成；packaged/installer/发布验收仍归QA）
- 对应执行计划工作包：`MODEL-002`、`FE-002`

## 本次实现与证据

- 复核固定生产模型`large-v3-q5_0`：1,081,140,203 bytes，SHA-256 `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1`。
- 复核官方CUDA 12.4 archive：677,887,125 bytes，SHA-256 `106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b`。
- VAD Manager通过固定`raw.githubusercontent.com`地址完成885,098-byte真实下载、SHA-256校验、CPU official server native load smoke、原子提交、`ready`解析与删除清理。
- Accelerator Manager以完整官方archive完成20个selected PE x64安全解包、逐文件size/SHA校验、最小环境`shell:false`启动probe、原子提交、branded proof解析与删除。
- production Backend Resolver用managed pack proof解析显式CUDA；Supervisor启动exact pack server并由production attestor绑定process epoch、exact PID、base runtime generation、server artifact、accelerator resource和pack generation后进入`ready`。
- Windows CPU/CUDA production-model target smoke均为`target_smoke_passed`；CUDA观测到exact PID峰值VRAM 1,815,437,312 bytes，未使用系统CUDA Toolkit、系统FFmpeg或PATH fallback。

## 真实Archive发现与修复

官方ZIP的44个文件均位于`Release/<leaf>`。原production archive contract和单测fixture错误地假定为扁平叶名，并在guard中一概拒绝`/`；因此完整真实archive在hash完成后必然fail closed，旧flat fixture无法发现。

修复后：

- production contract固定exact `Release/` entry root，不从archive任意推断目录。
- archive guard允许contract列出的安全相对路径，但仍拒绝absolute path、drive path、反斜杠、空段、`.`、`..`、Windows reserved name、unknown/case-insensitive duplicate、symlink/reparse、unsupported compression与zip bomb。
- 输出路径仍由独立`outputRelativePath`决定；archive entry path不能取得staging写入authority。
- 新增prefixed archive回归，并保留原traversal、unknown、duplicate、symlink/reparse、hash、compression ratio、no-clobber、cancel与cleanup失败矩阵。

## Windows Fixture 稳定性修复

- 按`FK-PIT-0070`，runtime fixture复制可信仓库license/source evidence前先把CRLF/CR规范化为canonical LF，再交给严格size/SHA verifier；未降低manifest校验，也不触碰二进制/模型/archive字节。
- VAD unit fixture按真实host决定私有目录权限策略；Windows Model Manager会额外列出CUDA资源，因此VAD routing断言改为检查所需资源子集，不假定平台无额外资源。

## 修改文件

- `electron/main/local-subtitle/accelerator-manifest.ts`
- `electron/main/local-subtitle/accelerator-archive.ts`
- `test/local-subtitle/acceleratorArchive.test.ts`
- `test/local-subtitle/acceleratorManifest.test.ts`
- `test/local-subtitle/runtimeFixture.ts`
- `test/local-subtitle/vadManager.test.ts`
- `test/local-subtitle/vadManager.real.test.ts`
- `test/local-subtitle/acceleratorManager.real.test.ts`
- Final Design、Execution Plan与版本台账
- `FK-PIT-0074`项目避坑记录

## 验证结果

```text
node scripts/local-subtitle/runtime/run-native002-windows-smoke.mjs --backend cpu ...
node scripts/local-subtitle/runtime/stage-runtime-windows-x64-cuda.mjs ...
node scripts/local-subtitle/runtime/run-native002-windows-smoke.mjs --backend cuda ...
vitest run test/local-subtitle/vadManager.real.test.ts
vitest run test/local-subtitle/acceleratorManager.real.test.ts
vitest run acceleratorManifest acceleratorArchive acceleratorManager backendResolver backendAttestor vadManager
tsc --noEmit --pretty false
node scripts/local-subtitle/benchmark/validate-manifests.mjs
git diff --check
```

- CPU smoke：model load 1,021 ms，private loopback health、bundled media decode、no-PATH与cleanup全部通过。
- CUDA smoke：当前manifest重新stage后model load 1,035 ms，exact PID VRAM为1,815,437,312 bytes，cleanup通过。
- VAD real：1 file / 1 test通过，1,951 ms。
- Accelerator production real：1 file / 1 test通过，9,838 ms。
- archive/manifest与manager/resolver/attestor/VAD隔离回归：6 files / 51 tests通过。
- TypeScript与manifest validator通过；报告仅保存于Git忽略的`runtime-smoke.local`，不记录绝对路径、PID、私有route或raw diagnostics。

## 结项边界

- `MODEL-002`与`FE-002`改为`已完成`。这表示资源管理、真实native load、managed CUDA production proof和目标组件attestation职责已闭环。
- Electron宽窄窗口、键盘、cancel/import竞态归`QA-002`。
- packaged Electron、NSIS安装/卸载/更新与无系统依赖产品矩阵归`QA-003`。
- NVIDIA DLL notice、分发许可、隐私、soak、更新/回滚发布审计归`QA-005`。
- 最终平台、性能、下载链接与许可声明继续由`DOC-001`在QA证据完成后回填；本记录不把component smoke冒充packaged发布验收。
