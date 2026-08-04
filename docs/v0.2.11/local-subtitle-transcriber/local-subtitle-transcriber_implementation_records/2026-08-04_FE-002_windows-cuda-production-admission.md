# 工作包 FE-002：Windows CUDA production admission checkpoint

## 基本信息

- 日期：2026-08-04
- 状态：部分完成
- 对应执行计划工作包：`FE-002`
- 目标平台/硬件：Windows x64 / NVIDIA CUDA production代码路径；本轮macOS开发环境不声明真实Windows GPU、packaged app或最终产品验收通过

## 本次实现内容

- Accelerator Manager新增main-only branded verified pack proof。每次backend admission与执行前复验fixed resource ID、exact tree、canonical manifest bytes、20个PE x64 server/DLL、full SHA-256及当前root/file identity；Windows对象身份复用canonical fixed-width `{ volumeSerialHex, fileIdHex }`，保留完整128-bit FileId，不经过JS `number` inode且不把birthtime当身份。proof冻结pack generation、root、engine/target、manifest、server与全部DLL identity，结构复制或proxy不能伪造。
- Model Manager只在Windows x64暴露fixed managed CUDA pack解析；pack未安装、安装中、失效或目标不匹配均fail closed。既有公开managed-resource API与renderer summary没有增加path/hash/artifact authority。
- Backend Resolver只有在base runtime为Windows x64、production attestor声明CUDA能力且managed pack proof通过时，才把`auto`或显式CUDA冻结为`resolvedBackend=cuda`。`auto`可在capability commit前因pack不可用解析为CPU；显式CUDA不会静默fallback。
- Server Process Contract不构造伪造的CUDA runtime bundle。base runtime generation继续独立绑定；实际CUDA server从verified accelerator目录启动，`cwd/PATH`只包含同目录server/DLL与安全System32。load identity包含完整pack generation、manifest、server/DLL hash和file identity，任何CUDA artifact都不能落入session/public/temp目录。
- Production Executor在每个queue-admission slice首次取pin前重新解析pack，并要求它与admission proof完全一致；Supervisor pin、lease、resident epoch和复用key均消费组合身份。资源删除同时检查queued CUDA task、runtime pin、lease和resident process。
- Production Backend Attestor只在Windows x64且存在可信探针路径时声明CUDA能力。exact child readiness后、进入ready前，优先按exact PID读取WDDM `GPU Process Memory(*)\Dedicated Usage`并要求正值；只有该计数器无正值时才尝试同PID `nvidia-smi --query-compute-apps`记录。命令使用absolute executable、`shell:false`、最小环境、bounded output/timeout、AbortSignal与startup deadline。
- CUDA attestation严格绑定`processEpoch`、exact PID、backend、base runtime generation、server artifact ID、accelerator resource ID与pack generation；缺字段、额外字段、超时、child close、零显存或identity mismatch均拒绝。probe命令、原始counter输出、pack path/hash/DLL identity不进入IPC、renderer或公开snapshot。
- CPU仍要求exact单一`--no-gpu`；Metal evidence路径保持不变；远端`audio:*` ASR没有改动。

## 修改文件

- `electron/main/local-subtitle/accelerator-manager.ts`
- `electron/main/local-subtitle/{model-manager,backend-resolver,backend-attestor,server-process-contract,server-supervisor,production-executor,job-manager}.ts`
- `electron/main/index.ts`
- accelerator/backend/process/supervisor/executor聚焦测试与共享accelerator fixture
- Final Design、Execution Plan与本实施记录

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/acceleratorManager.test.ts test/local-subtitle/backendResolver.test.ts test/local-subtitle/backendAttestor.test.ts test/local-subtitle/serverProcessContract.test.ts test/local-subtitle/serverSupervisor.test.ts test/local-subtitle/productionExecutor.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/tsc --noEmit --pretty false
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 聚焦7 files / 159 tests通过，覆盖branded pack proof、canonical POSIX/Windows文件身份、`auto`/显式CUDA、pack缺失时auto CPU解析、execution-time revalidation、完整server/DLL load identity、exact PID正显存、零显存fail closed及无可信probe不声明CUDA。
- 完整local-subtitle回归51 files / 1048 tests通过，2个既有real-native测试按环境跳过。
- TypeScript、renderer/main/preload三段Vite test build、manifest validator（0 errors / 0 warnings）与diff check通过；Vite只有既有dynamic-import/chunk-size warning。
- 未执行真实678 MB archive下载/约1.2 GB展开、真实Windows PowerShell/WDDM/NVIDIA driver、CUDA server inference、NSIS lifecycle或packaged app；本轮未启动前端/Electron服务，未执行pnpm，未修改`pnpm-lock.yaml`。

## Pitfall边界

- `FK-PIT-0054`：queue admission同时固定base runtime与accelerator pack generation；普通retry不换backend，确认CPU retry仍创建新的generation/slice。
- `FK-PIT-0024`、`FK-PIT-0036`：PowerShell与`nvidia-smi`只从validated Windows system root解析absolute path，`shell:false`，环境/stdio/timeout均有界；不继承开发机PATH或secret/proxy变量。
- `FK-PIT-0025`：继续消费官方预编译self-contained CUDA pack，不引入CMake、MSVC、CUDA Toolkit或`nvcc`最终用户前置。
- `FK-PIT-0030`：macOS只验证代码和host-native测试fixture；没有把POSIX路径/权限结果伪装成Windows目标机证据。
- `FK-PIT-0063`：Windows pack root、manifest、server与DLL对象身份使用fixed-width volume serial + 128-bit FileId；不压成JS safe-number，也不以birthtime/creation time替代对象身份。
- `FK-PIT-0002`：本轮没有启动Vite/Electron/native服务；结束前仍执行进程检查。
- `FK-PIT-0021`：本地字幕backend链路与远端Audio ASR保持隔离。

## 未完成事项

- 在真实Windows x64/NVIDIA目标机安装固定CUDA pack，验证PowerShell WDDM counter与必要时同PID `nvidia-smi` fallback、正显存、缺DLL/零显存、driver不可用、取消、重启与CPU确认新generation。
- 补真实完整archive下载/展开、packaged Electron/NSIS install-update-delete生命周期与renderer只显示脱敏backend summary的产品E2E。
- 在unrestricted Apple Silicon目标机补Metal正向产品证据；restricted sandbox失败不能用于产品支持结论。
- NVIDIA redistributable/notice最终closure仍归`QA-005`。`FE-002`保持`进行中`，不提前宣称目标机或M2 packaged验收完成。
