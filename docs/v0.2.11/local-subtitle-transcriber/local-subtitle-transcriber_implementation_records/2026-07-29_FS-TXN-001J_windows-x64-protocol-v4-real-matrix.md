# 工作包 FS-TXN-001J：Windows x64 protocol v4 real matrix

## 基本信息

- 日期：2026-07-29
- 状态：已完成（component checkpoint；顶层 `FS-TXN-001`、`NATIVE-002` 与 `BE-002` 仍为进行中）
- 对应执行计划工作包：`FS-TXN-001` 的真实 Windows x64 protocol v4 compile/load/terminal/recovery/crash/acknowledgement 子合同
- 目标平台：Windows x64
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 本次认领边界

本 checkpoint 使用真实 Windows x64 工具链和 Node 运行时，编译并加载
protocol v4 / journal v3 production 与 test-only addon，闭环此前只由合同
测试覆盖的 terminal、fresh-process recovery、crash、retry、conflict 与
acknowledgement 矩阵。

包含：

- 固定 LLVM-MinGW `20260407`、Node `24.14.0` headers、Windows x64
  `node.lib` 与 N-API v8，执行 shell-free C++17 production/test-only build。
- 真实加载 production exact surface 与带 `testFaultInjection` 的独立
  test-only surface。
- existing/absent victim 的 finalize/rollback、open decision、rejection、
  begin/terminal/acknowledgement crash、same-receipt retry 与冲突 fail-closed。
- 修复真实 HANDLE 合同暴露的 journal durable flush 和 NTFS
  delete-pending recovery 问题。
- 报告与 build receipt 继续只写入 Git 忽略目录，不记录用户名、绝对路径
  或文件内容。

不包含：

- 将 Windows addon 发布到 canonical runtime root 或 `extraResources`；
- Windows CPU/CUDA official server、media canonical assembly、production
  model private health、target launch或no-PATH；
- macOS arm64或Windows x64 packaged app/installer consumption；
- production overwrite放行、双重 `index-only` gate调整或power-loss safety
  声明。

## 本次实现内容

### NT journal durable flush

- Journal HANDLE继续以
  `FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_DATA | DELETE`
  最小NT权限通过`NtCreateFile`打开。
- `FlushJournal()`改为解析并调用`NtFlushBuffersFile`；不再把缺少
  `GENERIC_WRITE`的NT HANDLE传给`FlushFileBuffers`。
- native source-surface回归同时冻结protocol v4、journal v3、最小journal
  access与`NtFlushBuffersFile`。

### NTFS delete-pending recovery

- rollback/finalize先在保留HANDLE上验证unlinked object的zero-link proof，
  再显式关闭final、partial、victim与new-file HANDLE。
- 只有相关delete-pending HANDLE全部关闭后，才重新按名称证明partial/victim
  缺失或final identity已恢复。
- recovery opens和integration operations增加语义标签，真实失败能精确定位到
  begin、recover、acknowledge及final/partial/victim边界。

### 真实构建与矩阵

- production addon：847,360 bytes，SHA-256
  `40c666c02a44444ec9c8eed90f63792cd550ca5db09984fb2023fb85de08c5b2`。
- test-only addon：849,920 bytes，SHA-256
  `fd4eeee823b2db301547a1c95617c11de9699e82297df8a758e09dddf91bff82`。
- 两个artifact均为Windows x64 PE、Node 24.14.0、N-API v8、protocol v4、
  journal v3；test-only artifact保持独立fault surface。
- production矩阵：4/4 terminal、9/9 recovery/open-decision、6/6 rejection。
- fresh-process矩阵：4/4 abandoned-open、4/4 begin crash、4/4
  open-recovery arm crash、12/12 rollback crash、12/12 rollback error retry、
  7/7 finalize error retry、7/7 finalize crash、4/4 acknowledgement crash、
  4/4 acknowledgement error retry、2/2 conflict。
- 报告明确`productionGateChanged=false`、
  `powerLossSafetyClaimed=false`。

## 修改文件

- `native/local-subtitle-overwrite/src/addon-win32.cc`
- `scripts/local-subtitle/overwrite-native/build-addon-windows-x64.test.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs`
- `native/local-subtitle-overwrite/README.md`
- `.agents/skills/fusionkit-pitfall-guard/references/index.md`
- `.agents/skills/fusionkit-pitfall-guard/references/flush-nt-opened-journals-with-ntflushbuffersfile.md`
- `.agents/skills/fusionkit-pitfall-guard/references/close-delete-pending-windows-handles-before-name-rechecks.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/v0.2.11_iteration_execution_plan.md`
- `docs/v0.2.11/README.md`
- 本实施记录

## 接口或数据结构变化

- JavaScript、IPC、recovery repository、protocol与journal schema均不改变。
- Windows native实现新增`NtFlushBuffersFile`动态解析及显式HANDLE close
  helper；production addon export surface不变。
- integration runner只增强错误上下文，不改变报告schema或通过口径。
- 顶层工作包数量/状态、PRE-006 pins、builder mapping与production gate均不变。

## 验证结果

执行命令：

```text
node --test scripts/local-subtitle/overwrite-native/build-addon-windows-x64.test.mjs
node scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs --addon <ignored-production-addon.node>
node scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs --addon <ignored-test-addon.node>
node node_modules/vitest/vitest.mjs run test/local-subtitle/overwriteTransaction.test.ts test/local-subtitle/overwriteNativeBackend.test.ts test/local-subtitle/overwriteRecoveryOwner.test.ts test/local-subtitle/subtitleExporter.test.ts
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/vite/bin/vite.js build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

结果：

- Windows addon build/load test：7/7 passed，0 skipped；production与test-only
  variants均真实编译、加载并执行。
- production与fresh-process矩阵全部通过，计数见上方；无production gate或
  power-loss claim扩张。
- overwrite相关Vitest：4 files / 220 tests passed。
- TypeScript、根`vite.config.ts` renderer/main/preload三段test build通过；
  Vite只有既有mixed-import与chunk-size warning。
- manifest validation：0 error / 0 warning；validator tests 17/17 passed。
- `git diff --check`通过。
- Vitest/Vite首次在受限沙箱因esbuild无法读取工作区祖先目录而失败；以同一
  workspace和命令在获准的非沙箱进程复跑通过，未把环境失败记为产品回归。
- 未启动Vite dev server、Electron、official server、FFmpeg或ffprobe。

## 未完成事项

- `NATIVE-002` 仍需Windows x64 CPU base、独立CUDA accelerator与bundled
  media canonical assembly、production-model private health、target
  launch/no-PATH。
- macOS arm64与Windows x64仍需真实packaged `extraResources`
  consumption、launch/no-PATH及相应分发边界验证。
- `FS-TXN-001`、`NATIVE-002`、`BE-002`与M2继续保持原状态；Job Manager /
  Production Executor双重`index-only` gate不得解除。

## 下一步建议

1. 认领`NATIVE-002B`，组装Windows CPU base runtime、bundled media与本次
   protocol-v4 production addon，并完成production-model private health及
   media decode/no-PATH。
2. 将CUDA保持为独立ignored accelerator pack，单独证明backend/PID/VRAM，
   不并入默认`extraResources`。
3. 再以独立packaged checkpoint闭环macOS arm64与Windows x64真实bundle
   consumption；完整证据齐全后才评估production overwrite放行。
