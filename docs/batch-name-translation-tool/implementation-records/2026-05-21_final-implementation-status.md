# 批量名称翻译工具最终实现状态

## 背景

RN-008 对 RN-001 至 RN-007 的实现结果做最终回填，确保设计文档、工作包台账和实际代码行为一致。

## 已实现范围

- 手动工具页 `/tools/rename/name-translator` 可选择路径、配置范围、生成 dry-run 预览、编辑预览项、校验、应用和回滚。
- 主进程提供 rename 路径检查、目标扫描、validate/apply/rollback IPC。
- renderer planner 使用任务模型生成名称翻译结果，保留扩展名，进行清洗、冲突检测和 preview/full plan 分离存储。
- HomeAgent 可通过三个工具生成名称翻译 plan、展示预览确认卡片，并在明确确认后应用 plan。

## 最终 IPC

- `select-rename-paths`
- `inspect-rename-paths`
- `scan-rename-targets`
- `validate-rename-plan`
- `apply-rename-plan`
- `rollback-rename-journal`
- `check-path-exists`：复用既有基础路径检查 IPC，用于 planner 检查目标路径是否已存在。
- `check-rename-target-paths`：批量检查目标路径是否已存在，用于降低生成预览和 revalidate 阶段的 renderer/main IPC 往返；旧单路径 fallback 仍保留。

## 最终路由

- `/tools/rename/name-translator`
- HomeAgent 预览卡片跳转：`/tools/rename/name-translator?planId=<planId>`

工具页会自动读取 `planId` query 并从 renderer memory `namePlanStore` 加载当前 plan，恢复 HomeAgent 刚生成的完整预览、选中路径、配置、原始建议和应用区状态。若 plan 已过期或被清理，工具页显示明确错误，提示重新生成预览。

## Plan Store 策略

- 文件：`src/services/rename/namePlanStore.ts`
- 存储介质：renderer 内存。
- TTL：30 分钟。
- 最大保留：10 个 plan。
- 淘汰策略：清理过期 plan 后，超量时按创建时间删除最旧 plan。
- 设计原因：避免把完整批量 rename 清单塞入 Agent 上下文，也避免长期持久化用户路径列表。

## `path_segments` 状态

- 缺少起止边界：返回 `path_segment_boundary_required`。
- 起点为根目录、Home 根目录或系统保护目录：返回 `unsafe_path_segment_start`。
- 起止边界齐全：当前仍返回 `path_segments_deferred`，不生成可应用 plan。

`path_segments` 涉及路径层级重写、父子目录顺序和更高风险确认，已明确延后到 Phase 4。

## Rollback 限制

- Journal 默认位置：`app.getPath("userData")/rename-journals`。
- rollback 只恢复 journal 中状态为 `final_done` 或 `temp_done` 的操作。
- 如果用户在 apply 后移动/修改目标路径，或目标路径已被新文件占用，rollback 会记录失败，不覆盖用户后续变更。
- 批量 rename 不是单事务操作；journal 是恢复辅助和审计记录，不提供数据库式事务保证。

## 2026-06-18 性能优化补充

- 生成预览阶段已增加 `scanning`、`classifying`、`translating`、`checking_targets`、`validating`、`storing`、`done/failed/cancelled` 进度，并记录阶段耗时、请求数、批次数、峰值并发、缓存命中、快路径和路径检查请求数。
- planner 侧已支持翻译 key 去重、renderer 内存 TTL 缓存、高置信快路径和输出 fan-out；缓存 key 默认不包含完整路径。
- fake model 翻译默认按 batch size 50、concurrency 3 受控并发执行；从 5 个未缓存名称开始会在不超过并发上限的前提下均匀拆批（5 项为 `2 + 2 + 1`），避免小批量全部塞进一个模型响应；429/rate limit 会退避并降级并发，非可恢复错误 fail fast，schema/parse 类错误可拆批恢复。
- 目标路径存在性检查优先使用 `check-rename-target-paths` 批量 IPC，保留 `check-path-exists` fallback。
- 主进程扫描器已使用 `Dirent` 快路径减少普通文件/目录的逐项 `lstat/stat`，递归扫描使用有限并发，并在最终 targets 上做稳定排序。
- 性能回归入口为 `test/rename/nameTranslationPlanner.performance.test.ts`，只使用 fake model，不依赖真实模型供应商或网络。

## 验证状态

- `pnpm exec vitest run test/rename src/services/rename src/agent` 已覆盖 rename 扫描、planner、冲突、apply、journal 和 Agent 工具区分。
- RN-008 补充了目录 self、children directories、显式 `path_segments` 延后、unsafe path segment 起点、独立目录 rename + rollback。
- RN-PERF-007 补充了 fake model 性能回归测试，覆盖 500 targets 并发相对耗时、缓存/快路径、取消不写 plan、batch split recovery。
- RN-PERF-008 补充了 1 项、旧 5 项单批、5 项自适应并发的对照基准；参考结果为 64ms / 202ms / 97ms。
- `pnpm test`、`pnpm exec tsc --noEmit`、`pnpm build` 作为发布前验证命令记录在 RN-008 实施记录中。
- 2026-06-18 最近一次 `pnpm exec tsc --noEmit` 仍失败于既有 `src/components/qiuye-ui/code-block/*` 的 styled-jsx React 类型问题；该问题修复后再补跑 `pnpm build`。
- in-app browser 对 `http://localhost:5173/` 的访问在本环境被策略拒绝，HomeAgent 视觉冒烟需在允许访问本地 dev server 的环境补测。

## 后续建议

- Phase 4 再实现可应用的 `path_segments`，并配套更强的高风险确认与路径顺序测试。
