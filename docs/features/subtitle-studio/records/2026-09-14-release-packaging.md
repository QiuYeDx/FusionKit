# 实施记录：T-RELEASE-03 双资源发布候选

| 字段 | 值 |
| --- | --- |
| 任务 | T-RELEASE-03 |
| 日期 | 2026-09-14 |
| 验证版本 | dec9010 + 2026-09-14-release.snapshot.json（SHA-256 38bd3dfec11f3b2bdd5bb3827cc4ea6461b12c6c7a80a691bb1edb0776d01849）；原生实物/实际app另以各自回执及报告绑定 |
| 环境 | macOS 26.2 arm64、Node 20.19.5、Electron 41.10.6、electron-builder 24.13.3、osx-sign 1.0.5；依赖来自 pnpm 8.7.0，锁文件未变 |
| 任务指纹 | fb36a80572f0a02c69ab733a8f76d7a9a79c30296b7f39f21ca4ba1df3bb592f |

## 实际结果

默认 build 显式选择双资源配置，保留 `--publish never`。实际 beforePack 同时验证旧本地转写和新版 Studio 的 runtime、addon，再生成 macOS arm64 应用。两套冻结资源在外层签名前后逐项 hash 一致。

首次 ad-hoc app 虽通过 deep/strict 校验，真实启动却被 dyld 的 Team ID 检查拒绝。原因是 osx-sign 1.0.5 默认启用 hardened runtime，且该版本只读取 `optionsForFile` 中的配置。修复对本地 ad-hoc 外层文件显式关闭 hardened runtime，对 Developer ID 保持开启；两套已经冻结的原生资源继续不重签。新候选从 dir 阶段重建、重新签名并通过完整真实工作流，然后重新生成 DMG/ZIP，旧失败容器不作为交付。

签名工具分别验证 ad-hoc、Developer ID 和只读回验，拒绝未知签名与 ad-hoc/runtime 组合。Developer ID 模式另要求全部嵌套资源已用最终身份签名，外层具有 hardened runtime 与安全时间戳；本轮没有该身份，未执行正式签名、公证或公开发布。

来源审计保留所有冻结 manifest 和复制字节。精确审阅并更新当前应用接线；package 的维护例外只允许 scripts.build 和已提交 `87d22d9` 的 `0.3.0 → 0.3.1`，其他依赖、字段和 build 输入仍拒绝。

FFmpeg 确切源码归档、detached signature、公钥、两套构建配方及依赖、冻结许可与新增 CUDA EULA/映射已整理为 36 份材料。材料清单自身加入后 37 项 SHA-256 回读通过；再归档为 `FusionKit_0.3.1_third-party-materials.tar.gz`，包括校验文件在内的 38 个归档成员逐一回读一致。CUDA manifest 的 pending 与禁止分享状态保持，未将 CUDA 纳入本轮 macOS 候选。

最终 ZIP 解压与 DMG 私有副本只读挂载回读均通过：每份 app 的 293 个普通文件、339 个目录、14 个符号链接、23 个可执行文件完全一致，tree digest 为 `0779aa1b8962b90417f561270913744dde6acd9a22893e6f099e2da84d8f1620`。三份 app 的严格签名与双资源验证均通过。原容器字节及文件身份稳定，挂载、临时目录和探针进程全部清理。初次直接挂载时 hdiutil 增加校验缓存 xattr，最终采用已核对完整 hash 的私有镜像副本，保留首轮失败证据。

23 项 packaging/signing 回归、47 项 copy 回归和实际 120 文件 copy 检查通过。签名报告见 2026-09-14-release-signing.json，文件名/体积/SHA 见 2026-09-14-release-artifacts.json。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-RELEASE-03-1 | 通过 | file:records/2026-09-14-release-containers.json |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-RELEASE-03-1 | 通过 | V-RELEASE-03-1 |
| AC-RELEASE-03-2 | 通过 | V-RELEASE-03-1 |

## 风险与未执行项

本机有效 Developer ID 身份为 0，未收到公证配置或 Windows 目标机。因此此产物为可运行的本地 ad-hoc 候选，Gatekeeper 正式发行评估为 rejected，不能称正式发行就绪。Windows 最终包、安装/更新/卸载全生命周期、CUDA 条款及 Windows 外部库 notice 仍待对应条件；详见 2026-09-14-release-signing-readiness.md。未发布、提交或推送。
