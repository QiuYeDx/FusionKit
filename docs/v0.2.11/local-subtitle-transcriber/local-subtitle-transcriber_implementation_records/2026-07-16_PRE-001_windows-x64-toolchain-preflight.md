# 工作包 PRE-001：Windows x64 工具链预检

> 最终收口（2026-07-16）：当前 PRE-001 已完成；本记录中的后续样本/baseline
> blocker 说明也已被 `2026-07-16_PRE-001_scope-reduction-and-completion.md` 取代。
>
> 后续修正（2026-07-16）：本记录最初把 PRE-001 官方预编译 PoC 与
> PRE-002 自有 runner 源码构建放在同一个 readiness 中，因此曾把
> CMake/MSVC 缺失列为 PRE-001 blocker。该结论已被
> `fix/2026-07-16_local-subtitle-transcriber_split-prebuilt-runtime-and-source-build-readiness.md`
> 和 `2026-07-16_PRE-001_real-corpus-and-prebuilt-readiness.md` 取代。当前两份
> Windows 报告顶层均 ready，同时如实保留 `sourceBuild.ready=false`。

## 基本信息

- 日期：2026-07-16
- 状态：已完成（历史阶段记录；最终结论见范围收口记录）
- 对应执行计划工作包：`local-subtitle-transcriber_execution_plan.md` / `PRE-001`
- 目标平台/硬件：Windows 11 x64、Intel Core i5-13600KF、NVIDIA GeForce RTX 4070 Ti SUPER 16 GB

## 本次认领边界

- 包含：盘点当前 Windows x64 NVIDIA 目标机、修复 Windows 预检误报、生成 CPU/CUDA 脱敏报告、同步 PRE-001 台账和可复用避坑记录。
- 不包含：安装 CMake/MSVC、下载媒体/模型、构建 whisper.cpp runner、运行推理、修改 lockfile、进入 PRE-002/PRE-003 或证明 packaged 分发可用。

## 本次实现内容

- 确认主机为 Windows x64，Node `v20.19.4`、pnpm `8.7.0`、lockfile v6、FFmpeg/ffprobe、CUDA `12.4`、NVIDIA driver `610.62` 和 RTX 4070 Ti SUPER 可探测。
- 确认 CMake 与 Visual Studio C++ Build Tools/MSVC 未安装，不是 Developer Command Prompt 未初始化造成的 PATH 假象。
- 修复 Windows `pnpm` 预检：以 `shell: false` 启动固定 `cmd.exe /d /s /c "pnpm.cmd --version"`，不接受或拼接用户输入。
- 修复 Windows `nvidia-smi` 预检：最小环境只额外保留非敏感的 `ProgramFiles`/`ProgramW6432`，避免 NVML 初始化假失败，仍不继承 API Key、用户目录或完整环境。
- 初始生成 `windows-x64-cpu` 与 `windows-x64-cuda` 两份真实脱敏报告；当时因合同混淆而把 `tool_cmake`、`tool_msvc` 记为顶层 blocker。后续已按官方预编译 scope 重生成，两份顶层 `ready: true`，编译器只进入 `sourceBuild`。
- 清单测试最终要求三个目标按各自 readiness scope 存在 ready 报告，并单独验证 Windows 固定官方资产及 `sourceBuild` 一致性。
- 新增 `FK-PIT-0024`，沉淀 Windows `.cmd` 子进程解析与 NVML 最小环境要求。

## 修改文件

- `scripts/local-subtitle/benchmark/preflight.mjs`
- `scripts/local-subtitle/benchmark/preflight.test.mjs`
- `scripts/local-subtitle/benchmark/validate-manifests.test.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_windows-x64-cpu.json`
- `docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_windows-x64-cuda.json`
- `docs/v0.2.11/local-subtitle-transcriber/poc/README.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/README.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/keep-windows-native-preflight-command-resolution-explicit.md`

## 接口、状态或数据结构变化

- toolchain report schema 未变化。
- Windows pnpm probe 改为固定 `cmd.exe` tool spec；POSIX 仍直接运行 `pnpm --version`。
- 最小探测环境 allowlist 新增 `ProgramFiles`、`ProgramW6432`，并增加不继承 `USERPROFILE`/API Key 的回归断言。
- Windows 报告曾从 `target_report_missing` 进入 `target_report_not_ready`；后续 scope 修正后两份均 ready。更晚的范围收口已删除样本/baseline 非必要 blocker，PRE-001 最终完成。

## 安全、隐私与许可证检查

- 路径/capability：报告不记录 hostname、username、绝对路径或完整环境；未涉及应用 capability。
- 日志/持久化：固定 cmd 命令无用户输入；测试确认 `USERPROFILE` 和 `OPENAI_API_KEY` 不进入探测环境。
- 第三方来源与许可：当前 gyan.dev GPL/full FFmpeg 和系统 CUDA 只作 PRE/开发工具链证据，不构成 bundled FFmpeg/CUDA 分发或许可证结论。
- 用户环境：预检没有安装软件、下载资源、运行 `pnpm install` 或修改 lockfile。

## 验证结果

执行命令：

```text
node --check scripts/local-subtitle/benchmark/preflight.mjs
node --test scripts/local-subtitle/benchmark/generate-synthetic-fixtures.test.mjs scripts/local-subtitle/benchmark/preflight.test.mjs scripts/local-subtitle/benchmark/validate-manifests.test.mjs
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cpu --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_windows-x64-cpu.json
node scripts/local-subtitle/benchmark/preflight.mjs --target windows-x64-cuda --output docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_windows-x64-cuda.json
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs --strict
```

结果：

- 通过：脚本语法；Node tests 17/17；结构校验 0 error / 8 warning；pnpm、FFmpeg/ffprobe、nvcc、`nvidia-smi` 均在最小环境正确识别。
- 历史阶段结果：CPU/CUDA 两个 profile 曾以 exit 1 写出报告，仅包含 `tool_cmake`、`tool_msvc` 两个 blocker；后续已重生成并由新实施记录覆盖。
- 历史阶段结果：严格清单曾为 9 errors；当前结果以新实施记录为准。
- 未运行及原因：未安装 CMake/MSVC；没有真实样本、baseline 模型或 runner，因此未运行编译、转写、CER/WER、RTF、RAM/VRAM 或取消测试。
- 真实硬件/packaged 范围：只完成 Windows x64 主机与 CUDA 驱动/编译器的只读探测；未证明 CUDA inference、CPU fallback、DLL 分发或 packaged app。

## 产生的证据

- benchmark/fixture/日志摘要路径：`docs/v0.2.11/local-subtitle-transcriber/poc/reports/2026-07-16_windows-x64-{cpu,cuda}.json`。
- 不应提交的本地产物位置与清理结果：未生成模型、媒体、runner、临时 WAV、`.partial`、构建目录或下载缓存；没有启动需要清理的前端/runner/FFmpeg 服务。

## 未完成事项与风险

- 若 PRE-002 选择在当前主机源码构建自有 runner，仍需安装 CMake 与包含 MSVC x64 工具链的 Visual Studio C++ Build Tools；也可由后续冻结的受控构建机提供证据。不得手改 `sourceBuild` 为 ready。
- 3 段真实语料及 `.local` inventory 已补入并成为完整 PRE-001 范围；独立 reference、权利依据、额外场景和 model/application hash 已确认不需要。
- 当前系统 FFmpeg 与 CUDA Toolkit 可用不代表未来发行资源、许可证、签名或 clean-machine 行为已经通过。

## 最终交接

- PRE-001 已完成。PRE-002 再决定在本机安装 CMake/MSVC，还是使用受控构建机生成自有 runner。
