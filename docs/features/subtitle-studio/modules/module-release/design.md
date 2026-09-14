# I9 设计

## 现状与约束

起点为基线dec9010，现有依赖pnpm8.7.0；本轮已补齐新版macOS原生staging。使用固定源码和配方构建，保持算法和pin，独立签名后计算manifest，不覆盖旧资产。

## 方案与取舍

默认build显式选择已有双资源配置；新增保护两套冻结目录的签名验证器。Developer ID初查为0，公证工具存在但凭据未配置，Windows连接待提供。本地ad-hoc候选通过optionsForFile显式关闭外层hardened runtime，Developer ID仍开启；双冻结资源根不重签。严格校验外还必须运行最终app，避免不同TeamID导致dyld失败；正式发布状态独立记录。

启动修复保持已有preload视觉：hidden dom-ready时最多5秒检测原生可见性，开始、导航或销毁时清除；只有renderer真实ready才启动独立清理deadline，迟到回调由disposed守卫阻止。参照现有进度与揭幕；真实Electron覆盖1280×860浅色、786×540深色、中英文、隐藏后显示与结果弹窗完整流程，确认两种遮罩节点退出并审阅截图。

真实链路使用生产main/preload/runtime/repository，隔离profile和模型副本。优先使用上游JFK明确来源样本，翻译使用已有配置且不输出凭据；无法获得服务时如实保留真实供应商缺项和受控HTTP证据。

## 代码落点

implementation_health负责新增macOS构建/staging与原生验证；progress_docs负责preload启动及回归；release_status负责package与packaging签名工具、许可证据；root负责真实链路、规格、最终app构建、集成来源审计与当前文档。不得并发重建共享dist，构建时向root协调。

## 需求映射

| 需求 | 设计元素 |
| --- | --- |
| R-RELEASE-01 | 固定来源、独立staging、真实推理及文档导出 |
| R-RELEASE-02 | 启动生命周期与真实重载矩阵 |
| R-RELEASE-03 | 双资源入口、签名保护、许可、包实测与最终门禁 |

## 验证与风险

用真实Electron与CPU/Metal区分静态校验和运行证据。完整流程使用隔离profile；缺少外部凭据和目标机时继续本机可完成项，正式发行状态保持待验证。root协调共享dist构建与最终包验证，清理所有启动进程。

## 实测发现的边界修复

共享资源作业保留应用owner 0；专用native smoke adapter持有独立正数owner与随机session。真实首次安装必须通过实际supervisor准入，不能仅以已安装资源迁移替代。

来源核查保留冻结生成器与全部历史manifest。当前审计仅更新已审阅的应用接线，并窄化允许package的scripts.build及既有0.3.0到0.3.1版本变化；其余依赖和build输入不放开。worktree使用已有copy checker的有界Git文件hash方式，避免旧生成器stdin挂起。
