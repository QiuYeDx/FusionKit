# 工作包 NATIVE-002D：Windows x64 packaged consumption

## 基本信息

- 日期：2026-08-01
- 状态：已完成（component checkpoint；顶层 `NATIVE-002`、`FS-TXN-001` 与 `BE-002` 仍为进行中）
- 对应执行计划工作包：`NATIVE-002` 的 Windows x64 真实 packaged app/NSIS installer、exact `extraResources` consumption、production-model CPU/CUDA smoke 与 NTFS overwrite/recovery 回归子合同
- 目标平台/硬件：Windows x64 (win32/x64)，Intel/AMD x64 目标宿主
- 基线：`73de546`（`feat/local-subtitle-transcriber-next`，Merge branch 'v0.2.11' into v0.3.0）
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 本次认领边界

本 checkpoint 使用正式 `electron-builder.json` 在真实 Windows x64 目标机上构建 app 与 NSIS installer，从 packaged `resources/local-subtitle` 完整验证 official runtime、overwrite addon、fail-closed matrix、production-model CPU/CUDA smoke 和 NTFS overwrite/recovery 回归。

包含：

- 使用仓库正式 builder 配置和正式 `beforePack` 门禁执行 `--win --x64 --dir` 与 `--win nsis --x64`
- 从 packaged `resources/local-subtitle` 消费 whisper-server、FFmpeg、ffprobe 与 content-addressed overwrite addon
- Packaged validator 9 项 fail-closed matrix 通过
- Production model (`ggml-large-v3-q5_0.bin`) CPU whisper-server private health smoke
- CUDA 12.4 candidate whisper-server production-model smoke（独立 accelerator root）
- NTFS overwrite integration（production addon，15 cases）与 recovery integration（test fault-injection addon，全矩阵）
- Vitest overwrite/exporter 单元测试 220 tests 通过
- 修复测试脚本 Windows NTFS "delete pending" 清理竞态
- electron-builder.json NSIS 配置验证：`deleteAppDataOnUninstall=false`、`allowToChangeInstallationDirectory=true`

不包含：

- NSIS 安装/卸载/更新实际执行和用户数据保留验证（配置已确认，实际生命周期转手动 QA）
- 非 ASCII 与空格安装路径的 app 启动验证（转手动 QA）
- Developer ID、code signing 或公开发布
- renderer 到 main 到 packaged runtime 的完整产品 E2E、production overwrite 放行或 release ready 声明
- CUDA delivery/download/install/update/rollback、`MODEL-002`、`FE-001`、VAD 或 translate

## 环境

| 项目 | 值 |
|------|-----|
| OS | Windows 10 x64 (10.0.26200) |
| Node.js | v20.19.4 |
| 分支 | `feat/local-subtitle-transcriber-next` |
| 基础提交 | `73de546` |

## 构建产物

### App 与 Installer

| 产物 | SHA-256 |
|------|---------|
| `release/0.2.10/win-unpacked/FusionKit.exe` | `b98a5cc74879e9ad7f81ed9c39300084e0c8322b555252a0216b25ba8151a77e` |
| `release/0.2.10/FusionKit_0.2.10_x64.exe` (NSIS) | `5b4ab7cbce91a7e27751e80cab767b6cb5e4bc2e2f1f32c4dad71c69f16b901e` |

### Packaged Runtime (resources/local-subtitle)

| Artifact | SHA-256 |
|----------|---------|
| `win-x64/cpu/whisper-server.exe` | `2c1ef08694756eda280e79b8217da63ee2af33c87ac3d5f27d68f9f3f966fd32` |
| `win-x64/media/ffmpeg.exe` | `c623359f35e7db4820694b77d0f032f075e783a9c7207b81d908c28f148e8a68` |
| `win-x64/media/ffprobe.exe` | `35a823fb08470f6a1e91149e6c305ffbc5ee76c9901444c850f302ecee146a37` |
| `overwrite/v1/native/win32-x64/local-subtitle-overwrite.*.node` | `d940dc7f6bdedfe3a89e025f236c794c664b74b67f71356a1b7cf28fa1360426` |
| `manifests/local-subtitle-runtime.v1.json` | `f8058656b66a5cd0193688a1c6f43121590c5076b4ac4a5d7eebb73908d8798a` |

### Native Addon Build Receipt

```json
{
  "schemaVersion": 1,
  "workPackage": "FS-TXN-001F",
  "component": "local-subtitle-overwrite",
  "target": { "platform": "win32", "arch": "x64" },
  "build": {
    "nodeVersion": "20.19.4",
    "napiVersion": 8,
    "nativeProtocolVersion": 4,
    "journalVersion": 3,
    "cxxStandard": "c++17",
    "minimumWindowsVersion": "10.0",
    "compiler": "portable llvm-mingw clang++"
  },
  "artifact": {
    "byteSize": 847360,
    "sha256": "d940dc7f6bdedfe3a89e025f236c794c664b74b67f71356a1b7cf28fa1360426",
    "format": "pe",
    "architecture": "x64"
  }
}
```

### Production Model

| 项目 | 值 |
|------|-----|
| 文件名 | `ggml-large-v3-q5_0.bin` |
| 大小 | 1,081,140,203 bytes |
| SHA-256 | `d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1` |

### CUDA 12.4 Candidate

| Artifact | SHA-256 |
|----------|---------|
| `cuda/whisper-server.exe` | `c72f99b75ae4111d6e7ddb62e04d3c0c94fea2ba6536412e517f256b4388dd37` |
| CUDA DLLs | 19 files（cublas64_12、cublasLt64_12、cudart64_12、ggml-*、nvblas64_12、nvrtc*、whisper） |

## 测试结果

### 1. Packaged Validator (verify-packaged-local-subtitle.mjs)

- 状态：**PASSED**
- 验证 packaged `resources/local-subtitle` exact layout：runtime manifest、CPU whisper-server、media binaries、overwrite addon
- 9 项 fail-closed fault matrix 全部通过

### 2. CPU Production-Model Smoke

- 状态：**PASSED**
- whisper-server 从 packaged path 启动，bundled ffmpeg 解码 PCM16，production model 推理成功
- 验证不依赖 system PATH

### 3. CUDA Production-Model Smoke

- 状态：**PASSED**
- 独立 CUDA accelerator root 的 whisper-server.exe 使用 CUDA 12.4 runtime
- Production model 推理成功，GPU 加速确认

### 4. Vitest 单元测试

- 状态：**PASSED**
- 220 tests (overwriteTransaction、overwriteNativeBackend、overwriteRecoveryOwner、subtitleExporter)

### 5. NTFS Overwrite Integration (production addon)

- 状态：**PASSED**
- terminalCases: 4/4 (existing/absent × finalize/rollback)
- recoveryCases: 9/9 (open-decision × 4, not-found, directory-identity-mismatch, expanded-request, missing-decision, invalid-decision)
- rejectionCases: 6/6 (identity-mismatch, size-mismatch, multiple-links, partial-reparse, final-reparse, case-insensitive-leaf-collision)

### 6. NTFS Recovery Integration (test fault-injection addon)

- 状态：**PASSED**
- abandonedOpenCases: 4/4
- beginCrashCases: 4/4
- openRecoveryArmCrashCases: 4/4
- rollbackCrashCases: 12/12
- rollbackErrorRetryCases: 12/12
- finalizeErrorRetryCases: 7/7
- finalizeCrashCases: 7/7
- acknowledgeCrashCases: 4/4
- acknowledgeErrorRetryCases: 4/4
- conflictCases: 2/2 (terminal-decision-conflict, multiple-journal-conflict)

### 7. NSIS Installer Configuration

- 状态：**配置已验证，实际生命周期转手动 QA**
- `deleteAppDataOnUninstall: false` ✓
- `allowToChangeInstallationDirectory: true` ✓
- `oneClick: false` ✓
- `perMachine: false` ✓
- Installer 正确生成：`FusionKit_0.2.10_x64.exe` (194.5 MB)

### 8. CUDA 默认排除

- `electron-builder.json` extraResources 只包含 canonical base `local-subtitle`
- NSIS 安装包内不含 CUDA accelerator root
- CUDA candidate 位于独立 `build/local-subtitle-accelerators/` ignored root

## 代码修复

### 修复 NTFS "delete pending" 测试清理竞态

Windows Defender 实时扫描持有文件句柄导致 `fs.rm()` 递归删除测试临时目录时遇到 `ENOTEMPTY`。根因是 Node.js `rmdir` 在文件处于 "delete pending" 状态（已标记删除但句柄未释放）时失败。

修复：为两个集成测试脚本的 `finally` 块 `rm()` 调用添加 `maxRetries: 5, retryDelay: 200`：

- `scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs`

## 未覆盖边界与后续

| 项目 | 状态 |
|------|------|
| NSIS 真实安装/卸载/更新生命周期 | 手动 QA（命令已文档化） |
| 非 ASCII / 空格安装路径 app 启动 | 手动 QA |
| `userData`/models/artifacts 数据保留验证 | 手动 QA |
| Production gate 解除 | 不解除 |
| CUDA 分发许可 (QA-005) | 未完成 |
| `MODEL-002` download/install/update/rollback | 不在本包 |
| `FE-001`、VAD、translate | 不在本包 |

### NSIS 生命周期手动 QA 命令参考

```powershell
# Fresh install（含空格路径）
& "release\0.2.10\FusionKit_0.2.10_x64.exe" /S /D=C:\FusionKit Test\App

# Fresh install（含空格 + 非 ASCII 路径）
& "release\0.2.10\FusionKit_0.2.10_x64.exe" /S /D=C:\测试 用户\FusionKit App

# Uninstall
& "C:\FusionKit Test\App\Uninstall FusionKit.exe" /S
```

验证清单：
1. 安装后 `resources/local-subtitle` 完整
2. App 可正常启动（从含空格/非 ASCII 路径）
3. 创建 sentinel 数据后重装（repair），sentinel 不被覆盖
4. 卸载后 `%APPDATA%\FusionKit` 目录保留（`deleteAppDataOnUninstall=false`）
5. models、sessions、exported artifacts 均不被删除

## 结论

Windows x64 目标机的自动化测试矩阵已全部通过：packaged validator、CPU/CUDA production-model smoke、Vitest 220 tests、NTFS overwrite integration 15 cases 和 NTFS recovery integration 全矩阵。NSIS 配置已验证 `deleteAppDataOnUninstall=false`，实际安装生命周期转手动 QA。

Production gate 不因本 checkpoint 解除。`index-only` 标记继续保持，直到完整 Windows packaged matrix（含手动 QA 项）确认通过。
