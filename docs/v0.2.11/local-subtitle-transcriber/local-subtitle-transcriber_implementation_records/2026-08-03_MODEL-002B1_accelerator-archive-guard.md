# 工作包 MODEL-002B1：CUDA accelerator archive 安全解包 component

## 基本信息

- 日期：2026-08-03
- 状态：部分完成
- 对应执行计划工作包：`MODEL-002`

## 本次实现内容

- 为冻结的 Windows x64 CUDA 12.4 source archive 增加 exact `github.com` / `release-assets.githubusercontent.com` redirect allowlist，并保持既有 NATIVE-002 contract 与 validator 同步。
- 新增 strict production accelerator manifest：固定 whisper.cpp v1.9.1/f049fff、archive size/SHA/展开总量、20个 selected PE、24个明确 excluded leaf、artifact layout、unsigned personal distribution profile；selected/excluded 集合另以代码内 digest 防止仓库 manifest 自洽漂移。
- 新增 main-only ZIP guard，使用直接依赖 `yauzl 2.10.0` 流式解析 ZIP/ZIP64，不把678 MB archive整体载入内存。
- 在同一 no-follow 打开句柄上先做全量archive SHA，再用独立 random-access reader执行两遍central-directory流程；只有第一遍完整验证44个entry后才创建staging，第二遍才写出20个selected artifact。
- 拒绝absolute/drive/`..`/nested/unknown/case-insensitive duplicate leaf、directory、Unix symlink、Windows reparse、encrypted或不支持的compression、单项/总量越界和compression-ratio zip bomb。
- 每个selected artifact使用exclusive create、显式位置写入、size/SHA与最终file stat复核、fsync；失败或取消递归清理staging，取消清理失败独立上报，existing destination保持no-clobber。
- 使用项目指定的`corepack pnpm@8.7.0 --lockfile-only`提升仓库已有`yauzl 2.10.0`为生产直接依赖；未升级lockfile格式或其他依赖。

## 修改文件

- `electron/main/local-subtitle/accelerator-manifest.ts`
- `electron/main/local-subtitle/accelerator-archive.ts`
- `resources/local-subtitle/manifests/local-subtitle-windows-cuda-pack.v1.json`
- `scripts/local-subtitle/runtime/windows-cuda-pack-contract.mjs`
- `test/local-subtitle/acceleratorManifest.test.ts`
- `test/local-subtitle/acceleratorArchive.test.ts`
- `package.json`
- `pnpm-lock.yaml`
- 本主题最终设计、执行计划、版本总表与README

## 接口或数据结构变化

- CUDA `sourceArchive` 新增`allowedDownloadHosts: string[]`，供后续`MODEL-002B2`直接复用MODEL-002A downloader的逐跳HTTPS门禁。
- 新增`LocalSubtitleAcceleratorArchiveContract`与`extractLocalSubtitleAcceleratorArchive()`内部main接口；本checkpoint未加入public IPC，也未把accelerator暴露为可安装资源。

## 验证结果

执行命令：

```text
node_modules/.bin/vitest run test/local-subtitle/acceleratorManifest.test.ts test/local-subtitle/acceleratorArchive.test.ts
node --test scripts/local-subtitle/benchmark/validate-manifests.test.mjs scripts/local-subtitle/runtime/stage-runtime-windows-x64-cuda.test.mjs scripts/local-subtitle/runtime/windows-cuda-pack-contract.test.mjs
node scripts/local-subtitle/benchmark/validate-manifests.mjs
node_modules/.bin/tsc --noEmit --pretty false
node_modules/.bin/vite build --mode=test
git diff --check
```

结果：

- 新增聚焦2 files / 14 tests通过；覆盖happy path、manifest/source/artifact/excluded drift、unknown field、unsafe output、traversal、unknown、duplicate、Unix symlink、Windows reparse、zip bomb、artifact hash、no-clobber、取消与取消清理失败。
- runtime/manifest Node 32/32通过；manifest validator为0 error / 0 warning。
- local-subtitle全量45 passed + 2 skipped files / 982 passed + 2 skipped tests；2个skip仍是未启用的真实native server测试。
- TypeScript与renderer/main/preload三段Vite test build通过；Vite仅有既有chunk warning。
- 未启动Vite dev server、Electron或native server。

## 未完成事项

- 未下载或展开真实677,887,125-byte CUDA archive；当前证据使用合成stored/deflate ZIP覆盖安全状态机。
- 未把accelerator接入ResourceJob、list/install/delete IPC、磁盘预检或启动孤儿清理。
- 未实现PE x64静态复核、目标GPU probe、版本目录原子提交、旧pack rollback或运行时CUDA选择。
- NVIDIA分发许可closure仍属于`QA-005`，本checkpoint没有改变`artifactSharingAllowed: false`。
- VAD manifest/install与`FE-002`仍未开始。

## 下一步建议

- 继续`MODEL-002B2`：复用allowlisted downloader与ResourceJob，把archive放入private staging，调用本次guard后做PE/probe，按versioned accelerator root原子提交；已有pack只在新pack提交和post-commit验证成功后清理，任何失败恢复旧pack。
- 随后补VAD manifest/install、启动孤儿`.part`/staging清理，再进入`FE-002`资源管理UI。
