# Agent Note：xAI 已发现模型继承 Responses 推理等级

Status: implemented

[English](2026-08-17-xai-discovered-model-reasoning-levels.md) | 中文

## 问题

xAI 订阅适配器从 `/v1/language-models` 发现可聊天模型，且仅在 pi-ai 静态目录对该确切 ID 标有 `reasoning: true` 时附加推理选择器。已安装目录的 Responses 系列目前只点名 `grok-4.5`。较新的在线 ID（例如 `grok-4.6`）可以立即使用，但因为 `resolveModel` 不报告 `reasoning`，composer 的模型座位会隐藏 Effort 行。

xAI 的 Responses 协议在这些 Grok 版本上接受同样的 `low` / `medium` / `high` `reasoning.effort` 值。不提供选择器会让账户停留在提供方默认值，且无法更改。[xAI OAuth 提供方](../feature/2026-08-17-xai-subscription-oauth.md) 原先不推断推理控制，以免后来出现的非推理 ID 获得一个无效的 Off 控件。

## 决策

没有匹配 pi-ai 条目的在线目录 ID 会获得 `DEFAULT_XAI_REASONING_EFFORTS`：`low`、`medium` 和 `high`，不含 `off`。这是 grok-4.5 的 Responses 映射，不是 pi-ai 的五档默认值。在线目录别名若等于已知 pi-ai 模型 ID，则继承该条目的容量和推理映射。已安装且标记为不具备推理能力的条目仍不发布选择器。

composer 的 Effort 行走现有 `ModelSelect` 路径：它渲染 `resolveModel().reasoning`，不会自行发明等级。

## 备选方案

**等待 pi-ai 为每个 Grok 版本编目。** 不予采用，因为每个新的在线 ID 都要等到依赖升级后才会出现 Effort 行，而这正是 grok-4.6 上用户遇到的缺陷。

**从 `/v1/language-models` 解析推理字段。** 不予采用，因为适配器接受的响应信封不携带逐模型档位列表；为未文档化字段发明解析器，失败时仍会退回为不提供选择器。

**复用 pi-ai 在无映射时的默认值（`off` / `minimal` / `low` / `medium` / `high`）。** 不予采用，因为 Grok Responses 模型不接受 Off，宣传它会显示一个无法关闭思考的控件。

**继续对未知 ID 隐藏选择器。** 不予采用，因为当前在线目录中的聊天 ID 都是推理模型，隐藏控件比提供三个已文档化的 Responses 档位更糟。

## 结果

选择 grok-4.6 或其他未编目的在线 ID 时，模型座位会显示 Low / Medium / High。未来若出现不具备推理能力的 xAI 聊天 ID，在 pi-ai 编目之前仍会保留该选择器。已编目 ID（包括 grok-4.3 的无映射默认值和 grok-4.5 的显式映射）仍以目录为准。

## 测试

`packages/llm/llm-xai/tests/adapter.spec.ts` 固定 grok-4.6 及其他未知 ID 提供不含 `off` 的 `low` / `medium` / `high`、通过别名继承 grok-4.5 的容量与档位，以及现有的 grok-4.3 无映射默认值。无密钥 headless 快照通过组装后的 xAI 路由发现未编目的 grok-4.6，并验证所选 `medium` 档位会写入 `reasoning.effort`；composer 另在 `apps/web/tests/declared-reasoning.e2e.ts` 中固定所宣传的档位。
