# 实施记录：T-ACTIVITY-03

| 字段 | 值 |
| --- | --- |
| 任务 | T-ACTIVITY-03 |
| 日期 | 2026-10-15 |
| 验证版本 | snapshot-sha256:fe6b90fd09af56e3c3a82588aff2d0bc6babaacf72d7c8c96a8145ce62a6474b（基线 de422be + 未提交工作树） |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet），MCP 官方 SDK 客户端（external-agent 测试），临时用户数据与临时目录，无网络服务 |
| 任务指纹 | 7c3c60c2f3b22bb20b928dddff2c7439f2b6934f78b27578707329602b6f1e65 |

## 实际结果

“外部 Agent 活动”页面（`/external-agent`）：左侧连接列表（全部连接、当前在前、时长或结束时间、改动数、问题红点、未查看高亮；底部保留说明与清空），右侧连接概况（版本、状态、当前权限、断开）与筛选（改动 / 全部 / 有问题）、按日分组的时间线（时间、图标、一句话、放行与结果标签；展开后条目、结果数字、错误说明与原因、打开文档 / 撤销这次重命名 / 在文件夹中显示），分页滚动加载与实时追加；<768px 改为顶部选择框。标题栏应用名左侧的指示胶囊（客户端名或连接数、执行中脉动、等待确认琥珀色、未查看数徽标），点击进入对应连接；合并的轻提示（5 秒内同一连接合并、带“查看”、进入页面即消失、在该连接页面时不提示、设置可关）。设置页“查看活动记录”与每个连接的“活动”入口、提示开关；最近操作显示工具的可读名。字幕工作台支持 `?document=` 打开指定文档（不存在时在工作台提示）。英文单数用 `_one` 键。渲染审查发现并修复：进入页面后提示仍在、只读拒绝的写入显示读取图标且工具名重复、英文“1 translations”、测试 id 冲突、工作台地址参数竞争。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-ACTIVITY-03-1 | 通过 | file:records/i5/unit-renderer.txt |
| V-ACTIVITY-03-2 | 通过 | file:records/i5/e2e.txt |
| V-ACTIVITY-03-3 | 通过 | file:records/i5/render-review.md |
| V-ACTIVITY-03-4 | 通过 | file:records/i5/static.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-ACTIVITY-02-1 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-02-2 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-02-3 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-02-4 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-03-1 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-03-2 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-03-3 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-03-4 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-04-1 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-04-2 | 通过 | V-ACTIVITY-03-2 |
| AC-ACTIVITY-02-5 | 通过 | V-ACTIVITY-03-3 |

## 风险与未执行项

窗口获取焦点的断言在静默测试窗口中进行（窗口本就不在前台），只证明提示不会主动聚焦。
