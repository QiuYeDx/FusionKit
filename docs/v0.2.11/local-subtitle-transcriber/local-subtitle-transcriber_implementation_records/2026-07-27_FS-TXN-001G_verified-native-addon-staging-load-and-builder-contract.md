# 工作包 FS-TXN-001G：verified native-addon staging/load 与 builder consumption contract

## 基本信息

- 日期：2026-07-27
- 状态：已完成（component checkpoint；顶层 `FS-TXN-001`、`BE-002` 与 `NATIVE-002` 仍为进行中）
- 对应执行计划工作包：`FS-TXN-001`、`NATIVE-002` 的 builder consumption 子合同
- production gate：Job Manager / Production Executor 双重 `index-only` 保持，不因本 checkpoint 解除

## 范围与非目标

本 checkpoint 把 overwrite Node-API addon 从 developer build path 提升为独立、版本化、可验证的 production resource，并冻结 staging、main verification/load 与正式 electron-builder consumption 的合同。

本次不包含：

- production main 中 native runtime、file repository、composite recovery owner 的实例化与注入；
- reauthorization IPC/UI；
- 真实 Windows x64 protocol v4 compile/load/terminal/recovery/crash/acknowledgement 矩阵；
- `NATIVE-002` 的完整 official server/media artifact assembly、目标平台 launch/no-PATH 与两平台 packaged 验证；
- 解除 overwrite 的双重 `index-only` gate。

## 本次实现内容

### 独立 staging schema 与 final-byte publication

- 新增 `local-subtitle-overwrite-staging.v1.json`，精确限定 `darwin-arm64` 与 `win32-x64`，并固定 N-API v8、native protocol v4、journal v3、staging subtree `overwrite/v1`、signature/hash phase 与 production export surface。
- stager 只接受 exact build receipt；manifest、receipt 与 artifact 共同绑定 target、byte size、SHA-256、native format、signature profile、build provenance 和 contained relative path。
- production addon 使用最终 bytes 的 SHA-256 作为文件名，并以 no-clobber 语义发布；同名已有 publication、非 content-addressed leaf、expanded manifest、private build path、test-only fault addon、错误 target/format/signature/hash 均 fail closed。
- macOS addon 必须先完成最终 nested signing 和独立签名验证，再冻结 size/SHA-256；后续 outer app signing 不得再次改写该 subtree。

### Node/main verifier 与 generation-bound load proof

- Node staging verifier 与 Electron main verifier独立解析同一严格合同，production 不从 developer path、系统 `PATH`、裸 module name 或 caller-supplied absolute `.node` path取得authority。
- main verifier绑定canonical root、manifest、build receipt、artifact exact identity与addon generation，只返回WeakSet-branded、deep-frozen opaque proof；structural copy、proxy、旧generation和跨root proof均拒绝。
- production load只消费真实proof，并在native load前后重验containment、no-symlink identity、size/hash、target与manifest generation；symlink、replace、inode/hash drift、same-path different-generation及test-only export surface均拒绝。
- content-addressed no-clobber path避免新bytes复用旧文件名和旧native module cache；generation path在进程生命周期内保持绑定。
- 威胁边界保持明确：load前后校验能检测常规漂移，但JavaScript无法把`require(path)`/`dlopen`与同用户恶意writer线性化，因此不宣称消除全部native loader replacement window。

### 正式 builder consumption contract

- `electron-builder.json` 只允许一个canonical `extraResources` mapping：`build/local-subtitle-resources/local-subtitle -> local-subtitle`。
- `beforePack` 在builder消费前校验process、hook context与packager target完全一致，并以`launch:false`同时调用official runtime verifier与overwrite addon verifier；缺件、未显式ready、target/filter/artifact-name/mapping漂移均提前失败。
- builder目标固定为macOS arm64与Windows x64；macOS runtime subtree在nested signing后冻结hash，并通过`signIgnore`排除outer signing的递归重签。
- Windows继续使用`unsigned_personal_distribution`；本 checkpoint 不引入证书、信任库变更或公开分发承诺。

## 修改文件

- `resources/local-subtitle/manifests/local-subtitle-overwrite-staging.v1.json`
- `scripts/local-subtitle/overwrite-native/overwrite-staging-contract.mjs`
- `scripts/local-subtitle/overwrite-native/overwrite-staging.mjs`
- `scripts/local-subtitle/overwrite-native/overwrite-native-staging.mjs`
- `scripts/local-subtitle/overwrite-native/*staging*.test.mjs`
- `electron/main/local-subtitle/overwrite-native-resource.ts`
- `electron/main/local-subtitle/overwrite-native-backend-core.ts`
- `electron/main/local-subtitle/overwrite-native-backend.ts`
- `electron/main/local-subtitle/overwrite-native-backend-test-support.ts`
- `test/local-subtitle/overwriteNativeResource.test.ts`
- `test/local-subtitle/overwriteNativeBackend.test.ts`
- `scripts/local-subtitle/runtime/electron-builder-local-subtitle-before-pack.cjs`
- `scripts/local-subtitle/runtime/electron-builder-pre005-before-pack.test.mjs`
- `scripts/local-subtitle/runtime/electron-builder-pre005-before-pack-legacy.test.mjs`
- `scripts/local-subtitle/runtime/electron-builder-pre005-before-pack-legacy.test.mjs`
- `scripts/local-subtitle/runtime/validate-runtime-staging.mjs`
- `scripts/local-subtitle/runtime/validate-runtime-staging.test.mjs`
- `electron-builder.json`
- `native/local-subtitle-overwrite/README.md`
- `.agents/skills/fusionkit-pitfall-guard/references/load-native-addons-from-generation-bound-content-addressed-proofs.md`
- 本实施记录及主题 Final Design / Execution Plan、v0.2.11 总台账与 README。

## 接口或数据结构变化

- 新增独立 overwrite staging schema v1 与 canonical `overwrite/v1` resource subtree。
- build receipt / manifest固定N-API v8、protocol v4、journal v3、target、format、signature profile、final-byte size/hash与content-addressed artifact leaf。
- Electron main新增verified resource/proof合同；production backend load不再接受裸absolute addon path authority。
- builder hook新增overwrite addon verification，并与official runtime verification共同固定为`launch:false`。

## 安全与签名边界

- macOS nested addon signing属于最终bytes的一部分：签名、独立验证完成后才计算hash，outer app signing必须忽略该subtree。
- Windows个人分发保持unsigned profile；不把本地开发或fixture签名结果当作公开发行证据。
- production拒绝系统`PATH`、任意absolute module path、developer build receipt单独授权与test-only fault-injection addon。
- proof-to-load绑定依赖content-addressed no-clobber publication、opaque generation proof和load前后identity/hash重验；不夸大为对hostile same-user writer的原子线性化保证。

## 验证

最终验证命令：

```text
node --test scripts/local-subtitle/overwrite-native/overwrite-staging-contract.test.mjs
node --test scripts/local-subtitle/overwrite-native/overwrite-native-staging.test.mjs
node --test scripts/local-subtitle/overwrite-native/*.test.mjs
node --test scripts/local-subtitle/runtime/electron-builder-pre005-before-pack.test.mjs
node --test scripts/local-subtitle/runtime/validate-runtime-staging.test.mjs
node --test scripts/local-subtitle/runtime/*.test.mjs
node_modules/.bin/vitest run test/local-subtitle/overwriteNativeResource.test.ts test/local-subtitle/overwriteNativeBackend.test.ts
node_modules/.bin/vitest run test/local-subtitle
node_modules/.bin/vitest run
node_modules/.bin/tsc --noEmit --pretty false
node node_modules/vite/bin/vite.js build --mode=test
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs
git diff --check
```

最终验证结果：

- new staging/builder：21/21 passed。
- overwrite-native：29 passed + 1 skipped；skip为当前非Windows宿主上的真实Windows验证，不替代真实Windows矩阵。
- loader focused：2 files / 79 passed；相关4 files / 160 passed。
- local-subtitle：39 passed + 2 skipped files / 922 passed + 2 skipped tests。
- 全量Vitest：140 passed + 2 skipped files / 1875 passed + 2 skipped tests。
- TypeScript、renderer/main/preload三段Vite test build、manifest 0/0、validator 17/17与`git diff --check`通过。
- 真实macOS production addon执行build → ad-hoc sign → stage → fresh-process load，完整链路通过。
- runtime Node：58 passed + 1 skipped + 1 failed。失败为既有fabricated Windows `where.exe` fixture，与本次001G无关；本记录不把runtime Node套件或总体验证写成全绿。

上述证据不替代真实Windows compile/load/terminal/recovery/crash/acknowledgement矩阵、target packaged验证或完整product E2E。

本次文档收尾未运行pnpm，未启动Vite、Electron或其他前端服务。

## 剩余范围

1. production main/repository/recovery-owner injection。
2. reauthorization IPC/UI。
3. 真实Windows protocol v4 compile/load/terminal/recovery/crash/acknowledgement矩阵。
4. `NATIVE-002`完整official server/media artifact assembly、目标平台launch/no-PATH。
5. macOS arm64与Windows x64两平台packaged validation。

上述范围闭环前，`FS-TXN-001`、`BE-002`与`NATIVE-002`继续保持进行中，Job Manager / Production Executor双重`index-only` gate不得解除。
