# `@deepseek-ai/dsh-llm-codex`

[English](README.md) | 中文

Harness LLM（大语言模型）seam 的原生 OpenAI Codex 提供方。本包注册 `openai-codex` 路由，实现 Codex 使用的 ChatGPT OAuth 流程，直接调用 Codex Responses 后端，并且不依赖 `pi-ai`。

## 登录并使用

随附的 base 组合包会挂载本插件和 `dsh-model-auth-local`。在 Web profile 中，打开 **设置 → 模型 → 账户认证**，然后在 Host 机器上选择 **登录**，或从远程浏览器选择 **使用设备代码**。状态变为 **已登录** 后，在模型选择器中选择 `OpenAI Codex` 模型。Token 存储在 `$DSH_HOME/.model-auth.json`；浏览器只接收账户状态和登录 challenge。

对于自定义组合，请先于本插件挂载认证 Service Provider：

```yaml
- id: model-auth
  name: '@deepseek-ai/dsh-model-auth-local'
- id: llm-codex
  name: '@deepseek-ai/dsh-llm-codex'
```

`baseURL`、OAuth issuer 与客户端身份、回调端口、workspace allowlist、登录与刷新计时器、模型目录 cache 时长、回退上下文窗口、流 idle timeout 和重试策略都是显式 Cordis 插件配置字段。默认值指向 OpenAI 的公共 ChatGPT Codex 服务。`clientVersion` 默认使用适配器的 Codex 协议兼容版本，因为后端会用它筛选模型目录；仅当后端要求其他版本时才覆盖该值。除 loopback 测试服务器外，非 HTTPS 端点会被拒绝。

适配器从 `/models` 获取已认证的模型目录，并且只公开标记为列出且受 Responses API 支持的模型。每个公开模型都接受文本和图像输入。适配器从附件服务读取持久图像，并在用户消息或工具结果中将其作为 base64 data URL `input_image` 项发送。它向 `/responses` 发送原生流式请求，并在 401 后刷新一次，再返回认证失败。终止 Responses 事件会结算该流，不要求尾随 `[DONE]`；若传输结束或 `[DONE]` 出现在终止事件之前，则以 `STREAM_CLOSED` 失败。成功响应会把提供方原生输出项保留为回放状态，因此加密推理和工具调用身份可在后续轮次中原样返回。temperature、stop sequence 和显式 `maxTokens` 会被拒绝，因为该路由没有把它们映射到 Codex 后端。

## 模型体验

### Codex 请求

#### 模型看到的内容

所选模型接收 `GenerateOptions.system`、文本与持久图像内容、工具 schema、工具结果、推理强度和提供方原生回放项。OAuth 值、账户状态、传输标头和登录 UI 绝不会进入模型输入。

#### Token 影响

精确输入由提供方 tokenization 决定。原生回放可以包含工具续接所需的加密推理，而不向 Harness 暴露该内容。

#### KV Cache 影响

会话 id 会成为 `prompt_cache_key`。未变更的 instructions 和历史会保留较早的请求前缀；更换提供方或模型会选择不同的 cache 域。

### Codex 响应

#### 模型看到的内容

Responses SSE 事件会成为有序的推理、文本和工具调用分片。后续请求会回放已完成的原生输出项。

#### Token 影响

当提供方给出相应字段时，usage 会报告未 cache 输入、cache read、输出和推理计数。

#### KV Cache 影响

保留的响应项会追加到先前可复用的前缀之后。Harness 不会改写其提供方 id 或加密推理字段。

## 已知限制与暂缓事项

- 没有原生 Codex 映射的请求控制会在网络 I/O 前失败。
- 浏览器登录要求浏览器与 Host 共享 loopback 机器；远程浏览器使用设备代码。
- Windows 无法对认证文档强制执行 POSIX mode bit；该文件仍会在用户的 Harness home 下以原子方式替换。
