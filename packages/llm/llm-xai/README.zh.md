# `@deepseek-ai/dsh-llm-xai`

[English](README.md) | 中文

DeepSeek Harness 的 xAI 订阅提供方。该插件注册 `xai-oauth` 模型认证驱动和 LLM 路由，通过 xAI 设备码流程登录，由 `ctx.modelAuth` 存储产生的 OAuth 凭据，从 `/v1/language-models` 发现可聊天模型，并通过 `@deepseek-ai/dsh-llm-pi-ai` 实现的 OpenAI Responses 协议发送请求。请求时，它从可选的 `ctx.attachments` 服务读取持久图像，并通过该共享传输转发。

登录使用 `@earendil-works/pi-ai` 维护的公开 xAI 客户端身份和权限范围。访问令牌达到包含提前量的过期时间后，会在使用前刷新。模型发现收到 401 时，会强制执行一次串行刷新并重试一次。取消登录会中止轮询，并在提供方操作停止后才完成。

```yaml
- id: llm-xai
  name: '@deepseek-ai/dsh-llm-xai'
  config:
    modelCacheTtlMs: 300000
```

`baseURL` 默认为 `https://api.x.ai/v1`。生产配置只接受使用 HTTPS 的 `x.ai` 主机，防止已存储的 bearer 令牌被重定向到其他来源；测试仍可使用 HTTP 回环端点。发现的模型会尽可能继承 pi-ai 静态目录中的容量与推理元数据。pi-ai 尚未编目的在线目录 ID 使用配置的容量回退值，以及 Responses 系列的 `low`、`medium` 和 `high` 推理等级。在线目录别名若匹配已知 pi-ai 模型 ID，则继承该条目。

该路由面向个人订阅访问。xAI 控制账户资格，并可能拒绝不包含 OAuth API 访问权限的账户或订阅等级。

## 模型体验

### Grok 请求

#### 模型可见内容

所选模型通过 OpenAI Responses 协议接收 `GenerateOptions.system`、文本和受支持的图像内容、工具定义、工具结果以及受支持的请求控制。OAuth 值、账户状态、发现响应和登录挑战不会进入模型输入。

#### Token 影响

xAI 决定准确的 token 化方式。Harness 通过共享的 pi-ai 流转换转发提供方报告的输入和输出用量。

#### KV Cache 影响

会话 ID 会转发给 Responses 实现，用于提供方支持的亲和性。Harness 不承诺在模型或提供方改变后复用缓存。

### Grok 响应

#### 模型可见内容

Responses 事件转换为有序的 `StreamChunk` 推理、文本、工具调用、用量和结束值。后续请求通过共享的 pi-ai 上下文转换接收重建后的对话。

#### Token 影响

xAI 提供的用量会被保留。该适配器不会估算未知或省略的用量字段。

#### KV Cache 影响

完成的助手内容和工具内容追加到先前请求前缀之后。提供方原生缓存策略仍由 xAI 控制。

## 已知限制与后续工作

- xAI 控制账户和订阅资格；浏览器授权成功后，API 仍可能返回授权错误。
- 没有 pi-ai 条目的在线目录 ID 会被当作推理模型提供。若 xAI 随后发布不具备推理能力的新聊天 ID，在 pi-ai 编目之前仍会显示该选择器。
- 设备流程不提供账户资料字段，因此已登录卡片无法显示邮箱或订阅名称。
- 未挂载持久附件服务时，图像内容会被拒绝。
