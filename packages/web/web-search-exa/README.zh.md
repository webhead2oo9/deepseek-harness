# @deepseek-ai/dsh-web-search-exa

[English](README.md) | 中文

由 [Exa](https://exa.ai) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它调用 Exa `POST /search` 并请求重点摘要，将结果元数据映射为 `WebSearchResult`。

这是实现包，负责向 `ctx.web` 注册后端；面向模型的 `web_search` 工具由 [`@deepseek-ai/dsh-tool-web`](../tool-web/README.md) 拥有。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | — | 为兼容性保留的字面量密钥。优先使用 `apiKeyEnv`。 |
| `apiKeyEnv` | `EXA_API_KEY` | 每次搜索解析的凭据引用。 |
| `baseURL` | `https://api.exa.ai` | Exa 端点基址；追加 `/search`。 |
| `searchType` | `auto` | 标准检索模式：`auto`、`fast` 或 `instant`。 |
| `numResults` | 未设置 | 仅在共享请求没有 `maxResults` 时作为默认值。 |
| `moderation` | `true` | 请求 Exa 过滤不安全结果。 |
| `highlightsMaxCharacters` | 未设置 | 每个结果的摘要字符上限；未设置时使用 Exa 默认选择。 |
| `maxAgeHours` | 未设置 | 缓存内容时效：`0` 获取最新内容，`-1` 仅使用缓存。 |

提供方注册 `web-search-exa` 设置命名空间。插件页通过凭据域写入 API 密钥，因此设置响应不会返回密钥。

## 映射

每个 Exa 结果贡献 URL、可选标题、第一条非空高亮摘要和发布日期。没有高亮摘要的结果仍可作为引用。web 能力会应用最终结果上限。携带凭据的请求会在跟随 `Location` 之前拒绝重定向；已取消的操作返回 `WEB_ABORTED`。

## 模型体验

`dsh-tool-web` 提供模型可见工具。模型只接收规范化且受限的来源和提供方失败；未映射到共享结果的 Exa 响应字段不会进入模型上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由 web 工具消费方负责。

## 已知限制与暂缓事项

- 提供方只支持普通 Exa 检索模式。深度研究、综合输出和流式响应需要独立的面向模型能力。
- 由于当前提供方无法遵守统一语义，类别、域名、日期和页面内容控制不在提供方无关请求中。
