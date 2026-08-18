# Agent Note: xAI Grok 图像需要附件解析器

Status: implemented

[English](2026-08-17-xai-image-attachment-resolver.md) | 中文

## 问题

[xAI 订阅适配器](../feature/2026-08-17-xai-subscription-oauth.md) 会根据 `/v1/language-models` 宣传图像输入，并写明 Grok 接收受支持的图像内容。该适配器是 `PiAiAdapter` 的薄封装。该委托在 `resolveAttachments` 未返回持久附件存储时，会拒绝任何图像块。xAI 插件构造委托时只传入了目录和 OAuth 钩子，因此即使用户会话已挂载 `ctx.attachments`，在具备图像能力的 Grok 模型上发送用户图像或 `read_image` 结果仍会失败，错误为 `pi-ai image input requires the durable attachment service`。

## 决策

`XaiAdapter` 接受与 `PiAiAdapter` 和 `CodexAdapter` 相同的可选 `resolveAttachments` 钩子。插件提供 `() => ctx.get('attachments')`，以便适配器之后挂载的存储会在下一次请求中可见。图像字节仍通过共享的 pi-ai Responses 路径转换；本包不自行序列化图像。

## 备选方案

**声明 `inject: ['attachments']`。** 不予采用，因为省略 `read_image` 的组合中附件是可选的；硬注入会在存储出现之前停住整条 xAI 路由。

**在 `XaiAdapter` 内序列化图像。** 不予采用，因为委托已经把持久引用转换成 Responses `input_image` 项；再写一套序列化会与 pi-ai 漂移。

**把该失败写成已文档化的限制。** 不予采用，因为在线目录、README 和 `read_image` 准入都把 Grok 当作具备图像能力。

## 结果

挂载附件存储后，带图像的 Grok 请求可以成功。没有该存储时，仍会以同样的 `UNSUPPORTED_CONTENT` 拒绝。

## 测试

`packages/llm/llm-xai/tests/index.spec.ts` 固定插件钩子指向 `ctx.get('attachments')`。`packages/llm/llm-xai/tests/adapter.spec.ts` 在没有钩子时拒绝图像，有钩子时则在提供方请求之前把持久字节读入 Responses `input_image` 项。
