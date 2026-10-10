# 实施记录：T-STUDIO-01

| 字段 | 值 |
| --- | --- |
| 任务 | T-STUDIO-01 |
| 日期 | 2026-10-10 |
| 验证版本 | 45a88e0 + 本会话未提交改动（I2 工作树） |
| 环境 | Windows 11，Node（vitest 2.1.9），临时目录文档库 + mock 模型 |
| 任务指纹 | 066f501c8a1d9793f394457847a4c3d2a3c00159096f7424ff81a2b7f26c33db |

## 实际结果

- 契约：`reviseCues` 可选 `knowledge`（`knowledgeSelectionSchema`）；结果新增 `knowledgeHints`（原文、译文、备注、关联字幕）与 `knowledgeItems`；提示词在可改译文时追加「可沉淀约定」说明，有资料时追加资料遵循说明；`parseCueRevisionResponse` 宽松读取 `knowledge`（每请求最多 5 条，单段 ≤200 字、可保存文本）。
- 服务：`CueRevisionService` 注入 `readKnowledge`（工作台注册时传入同一资料快照读取），按选择解析资料，每块只投影适用于本块的条目（同翻译请求格式）；读取或解析失败时按无资料修订。可沉淀约定须原文出现在该行原文、译文出现在修订后（或保留）的译文，跨块按折叠后的原文/译文合并关联字幕，最多 10 条。
- 只修订原文、无译文轨或无资料选择时不读资料库、不要求约定。

## 验证结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| V-STUDIO-01-1 | 通过 | file:records/i2/studio-01-revision.log |

## AC 结果

| 验收 | 结果 | 关联检查 |
| --- | --- | --- |
| AC-STUDIO-01-1 | 通过 | V-STUDIO-01-1 |
| AC-STUDIO-01-2 | 通过 | V-STUDIO-01-1 |
| AC-STUDIO-02-1 | 通过 | V-STUDIO-01-1 |
| AC-STUDIO-02-2 | 通过 | V-STUDIO-01-1 |
| AC-STUDIO-02-3 | 通过 | V-STUDIO-01-1 |

## 风险与未执行项

真实模型是否只在合适时机返回约定无法自动证明；字面校验与上限能挡住凭空或错位的约定，但挡不住“合理但用户不想要”的约定——最终由用户在对话框勾选。
