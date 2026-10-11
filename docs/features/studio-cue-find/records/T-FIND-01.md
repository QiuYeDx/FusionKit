# 实施记录：T-FIND-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-FIND-01 |
| 日期 | 2026-10-11 |
| 验证版本 | snapshot-sha256:2b217c287c50c15888de2ef081e593992e7decc614c589e4b74149f23e5a7b04 |
| 环境 | Windows 11 Pro 10.0.26200，Vitest 2.1.9，Electron（vite build --mode=test，FUSIONKIT_TEST_WINDOW=quiet，mute-audio 同样静音 Web Audio），随应用 FFmpeg n8.1.2（开发环境 build/subtitle-studio-resources），无网络服务 |
| 任务指纹 | d9f6a8288246e302a6408dacdaa4410b780675b197bf8238d88d8af0942e48b7 |

## 实际结果

共享纯模块 `cue-find.ts`：字面匹配区间（可区分大小写、不重叠）、整篇查找（原文 / 当前译文轨 / 两者，按文档顺序，上限 10000 条）、替换文字（片段内保留格式，跨片段按整行重建）。只读通道 `searchCues`；编辑操作 `replace`（全部或指定字幕；原文按编辑原文、译文写为人工已复核；替换词含 < > 或结果为空拒绝；超过 1000 条 limit_exceeded；撤销恢复原文与原译文条目）。组合审计已更新（exact true）。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-FIND-01-1 | 通过 | file:records/find-unit.log |
| V-FIND-01-2 | 通过 | file:records/find-unit.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-FIND-01-1 | 通过 | V-FIND-01-1 |
| AC-FIND-01-2 | 通过 | V-FIND-01-1 |
| AC-FIND-02-1 | 通过 | V-FIND-01-1 |
| AC-FIND-02-3 | 通过 | V-FIND-01-1 |

## 风险与未执行项

不区分大小写按逐字 toLocaleLowerCase 比较；大小写转换会改变长度的字符（如 ß）按原字符比较。
