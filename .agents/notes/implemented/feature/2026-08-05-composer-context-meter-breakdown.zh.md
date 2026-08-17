# Agent Note: composer 上下文占用圆环与启发式组成明细

Status: implemented

[English](2026-08-05-composer-context-meter-breakdown.md) | 中文

## 问题

Web 聊天的统计行把上下文占用率作为一个行内数字（`Context N% of X`）挤在计费分组之间。它回答了「有多满」，却回答不了「被什么占满」：没有任何地方展示窗口在系统提示词、工具 schema 与对话之间如何分配，而单行统计行也容纳不下这种明细。可用的数字还分属两套口径——来自 `contextPressure` 的提供方精确计费的提示词规模，与 token-meter 的固定字符启发式——没有任何既有界面能在不混淆两者的前提下展示组成。

## 决定

三个协作部分，每个包边界一个：

`dsh-session` 导出纯函数 `deriveEventMessage(event)`（此前只能通过 `Session` 方法访问，该方法现在委托给它），使 host 侧 fold 无需 `Session` 实例即可为表层节点计价。

`dsh-token-meter` 把计价启发式抽取到 `src/estimate.ts`、把位置表层折叠抽取到 `src/surface-fold.ts`（两者都与测量服务逐字共享），并注册第三个会话投影 `contextBreakdown`，携带 `systemTokens` / `toolsTokens` / `messageTokens`。envelope 数字在每条 `request/header` 上经 `canonicalHeader` 按后者胜重新计价；消息数字在逐节点 `{seq, tokens}` 列表上重放 `foldSurfaceTokens`，因此它在每个事件边界上按构造等于 `measure().surfaceTokens`，压缩（compaction）会像缩小下一个请求那样缩小它。这份共享折叠是全函数且总是新建数组——返回下一个表层而不是原地改写——从而保留了服务侧「先校验再提交」的重放事务：抛出时重放游标不前进，同一条畸形事件在重试时报同样的错。折叠表层中不存在的替换范围会直接抛出：已提交日志在追加时就经过表层校验，无法解析的范围是日志损坏，而不是可跳过的事件。

`ui-conversation` 把上下文占用率从统计行移走（一个事实一个家），放到 composer 尾部的 `ContextMeter`：模型座位之后的一枚 14px 占用圆环读取 `contextPressure` 中锚定在提供方读数上的 `projectedTokens`，因此压缩会立即改变读数（见[仪表对压缩的失明](../bug-fix/2026-08-05-context-meter-blind-to-compaction.md)）。点击圆环会打开一个受视口宽度约束的面板；其中的本地化标题、`~已用 / 容量`、预计剩余容量与 4px 占用进度条都使用同一读数。分母来自当前模型解析出的 `request/context` 容量；UI 不带固定的适配器兜底值。进度条先把外层填充严格限制为占用百分比，再由系统、工具与消息三类启发式份额只切分该填充，因此分段间隙与最小宽度都不能越过报告的占用量。启发式明细行保留未经缩放的数值与 `~` 前缀，因为固定的「4 字符≈1 token」估算会系统性低估 CJK 文本与代码。触发器通过 `aria-controls` 与面板关联；Escape 关闭面板且不会从仪表外部抢走焦点；占用率为 0 时不渲染填充。

## 备选方案

**在客户端从已加载窗口推导组成。** 窗口是日志的连续后缀：携带系统提示词与工具 schema 的 `request/header` 事件可能在窗口之外，翻页还会让数字悄悄变化。只有持久的 host 侧投影能在翻页与压缩后幸存，这正是数据以第三个投影而非聊天窗口 fold 的形式过线的原因。

**把启发式明细行按比例缩放，使其总和等于 `pressureTokens`。** 强行对账是在捏造精度：压力滞后一个请求，还包含估算器从不建模的提供方封装开销，会让明细行在组成毫无变化时也跟着变动。最终选择以显式 `~` 展示估算器的真实口径。

**更细的类别（rules、skill（技能）、MCP 工具，如 Claude Code 的 `/context`）。** 在这里不可分：harness 在请求标头存在之前就把这些贡献折入系统文本与工具列表，因此三个类别是诚实的分辨率。

## 后果

token-meter 注册三个投影键；卸载会移除全部三个，`contextBreakdown` 可从 JSON 检查点恢复（`stateVersion` 为 1）。圆环是唯一的上下文 UI。面板的启发式明细行可能与锚定在提供方读数上的占用标题及剩余容量估算不一致；每个近似 token 读数都会明确标为估算值。提升估算精度（例如按 CJK 加权）仍只需改动 `estimate.ts`，不改变公共 API。图例的紫色分段色值是字面量，因为设计平台没有紫色静态 token。
