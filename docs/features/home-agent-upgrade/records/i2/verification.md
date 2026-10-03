# I2 集成验证

日期：2026-10-03。基线：161b109。具体源码、依赖清单、字节摘要及环境见 [source-snapshot.json](source-snapshot.json)。本轮保留原 artifacts/ 与全部 I1 记录。

## 自动检查

| 检查 | 实际结果 |
| --- | --- |
| 相关回归 | 189 文件、2374 用例，2322 通过、52 条件跳过、0 失败；[逐文件汇总](unit-summary.json) |
| TypeScript | 默认 tsc --noEmit --pretty false，最后产品代码修改后 exit 0 |
| 根 Vite test 构建 | renderer 6080、main 357、preload 408 模块构建通过；保留原有大 chunk 和 useModelStore 动静态导入提示，不调整构建阈值 |
| 四语言 | home 均 231 keys；项目共 3541 keys/语言。i18n usage 3036 calls、3234 resolved keys，全通过；23 条其他命名空间同源值提示 |
| 预加载边界 | check-preload-bundle.mjs 通过，仅 electron 外部模块 |
| Git 格式 | 按仓库现有 autocrlf 规则的 diff --check 通过 |
| Spec | ready/授权沿用用户自主实施请求；最终 check_spec --stage done --require-approval --check-overall：0 errors、0 warnings，仅核对结构、引用与声明 |

## Electron 验收及实际复查

最终 17 项交互检查、24 张截图的明细和摘要见 [ui-report.json](ui-report.json)，其中 8 张代表图片随文档归档。使用实际 Electron/main/preload，单独 profile、临时原生文件和 loopback 合成 Responses SSE / Chat JSON；没有真实供应商费用或用户私有资料变更。覆盖 1280×860 中文浅色、786×660 英文深色、日文浅色和繁中深色。

- 原生会话对话框取消/非法文件不改变已有草稿；无模型也能导入；真实导出文件可重新导入，无执行权限复活。
- 计划快照注明上次更新时间；进度检查保留草稿、重复点击不重复追加、不自动发模型请求。键盘模式选择有可访问名称及焦点。
- tasks/items 的实际转写阶段、进度与错误直接可读；批量 1/3 准备成功与两项具体失败可读。20 条终态加 2 条待办的排序规模在行为单测验证，实际界面另验活动/历史分组。
- Studio 转写结果跳转转写视图，能力入口跳转文档视图，有限导航提示消费后不会持续覆盖用户选择。
- 日志展开和聚焦稳定后保存 scrollTop 与首项位置；追加真实流事件时阅读锚点不变，点击“查看最新日志”后恢复底部跟随。
- 真实字幕导入后准备、取消不产生任务；确认只入队实际目标，合成响应完成一个真实后台任务。另用实际授权但 revision 过期的文档验证混合准备失败。

## 初版观察 → 修复 → 复验

1. 无模型导入：固定 pb-44 留白容不下模型提示与导入反馈，计划底部被覆盖。改为 ResizeObserver 读取 composer.offsetHeight，并联动底部预留与回底按钮。稳定后 plan.bottom <= composer.top 检查通过，更新时间、说明和按钮可读。
2. 首张导入图处于 shared-layout 过渡，模式/发送尚未归位。验收等待几何稳定，未为过渡帧错误改写原动画；等待还考虑反馈行真实高度。
3. 日志断言最初错误要求 scrollTop 恒为0，而聚焦与footer出现已经改变追加前位置。改为稳定后的前后相对位置，确认没有跳到最新，不放宽真实阅读锚点要求。
4. 未授权 UUID 的混合失败样本被原生权限层正确拒绝，不能伪称业务批量回执验证。改用真实授权但过期 revision，保持权限边界。
5. runtime/tools/UI 交叉审查发现传输未知不能构造成确定全失败，已保留 preparation 回执与明确 unknown 提示，不重复提交。
6. 最后截图复看发现混合失败卡片未完整进入画面，以及长英文草稿可能处于高度动画中。显式滚到当前操作并断言卡片在输入区上方；长草稿等待几何稳定后检查 textarea 在胶囊内且 scrollHeight 不超出高度，两项通过。没有把过渡截图当成稳定界面缺陷。

## 扩大检查中的既有问题

第一次使用 `test/subtitle-studio` 字符串过滤时，还匹配了 `test/subtitle-studio-provenance`，206 文件结果保留于 [broader-check.json](broader-check.json)：2490 通过、98 跳过、9 失败，另有两个 suite 在导入期失败。

四个 provenance 测试文件依赖旧冻结源码，当前相关文件与 HEAD 一致，本轮未改；差异来自此前 `484894e`（localSubtitle）和 `6f84227`（studio/index），不是 CRLF。未改写旧快照以制造通过。一个转写任务服务用例在高并发首跑超过原15秒上限；原限额不变，单独41/41通过，问题用例耗时12.85秒。最终以准确目录 `test/subtitle-studio/`、2 workers 重跑上述相关范围全通过；不能把最终结果描述为整个仓库无历史测试问题。

## 证据边界

真实外部供应商兼容性、付费模型输出质量、长媒体本地推理和非 Windows 未测试。Responses 协议、取消、逐项失败和准确范围通过合成协议/服务测试；既有原生扫描 IPC 无强制中断能力，但返回后会停止后续动作。已受理副作用不回滚；提交结果未知时必须核对实际任务。计划不会随后台状态自动更新。
