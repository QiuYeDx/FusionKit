# 实施记录：T-TOOLS-08

| 字段 | 值 |
| --- | --- |
| 任务 | T-TOOLS-08 |
| 日期 | 2026-10-14 |
| 验证版本 | snapshot-sha256:c132f5c0fb9f7a51de9c4e8307407ba24c7f8b8719d6576fce1b550a38d9f86c（基线 c0a9dcd + 未提交工作树） |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet），MCP 官方 SDK 客户端（external-agent 测试），临时用户数据与临时目录，无网络服务 |
| 任务指纹 | fa6e9b764adc08415177b976973e15fc54646062c665c34e84b55225c720ad70 |

## 实际结果

`convert_subtitle_files` / `extract_subtitle_language`（`classic.ts`）：路径收集（文件 / 文件夹 / 递归 / 去重 / 200 上限 / 不存在）、逐文件经经典页面同一主进程通道读写、单个失败不影响其他；与目标格式相同的文件在确认前分出、标为跳过且不列入确认框，全部相同时不请求确认（渲染审查发现后修正，规格纠正并刷新批准摘要）；新确认组 `classic_files`，覆盖时以 destructive 提交（任何档位确认）。`get_classic_tasks` 只读经典页队列；`open_fusionkit_page` 增加 6 个经典页面（内置 Agent 页面表增加 text_translator）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-TOOLS-08-1 | 通过 | file:records/i4/unit.txt |
| V-TOOLS-08-2 | 通过 | file:records/i4/static.txt |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-TOOLS-11-1 | 通过 | V-TOOLS-08-1 |
| AC-TOOLS-11-2 | 通过 | V-TOOLS-08-1 |
| AC-TOOLS-11-3 | 通过 | V-TOOLS-08-1 |
| AC-TOOLS-11-4 | 通过 | V-TOOLS-08-1 |
| AC-TOOLS-13-1 | 通过 | V-TOOLS-08-1 |
| AC-TOOLS-13-2 | 通过 | V-TOOLS-08-1 |

## 风险与未执行项

这些通道本身不做路径授权（与经典页面相同），门槛在信任档位与确认。
