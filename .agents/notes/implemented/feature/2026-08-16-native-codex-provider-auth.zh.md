# Agent Note: 原生 Codex 提供方认证

Status: implemented

[English](2026-08-16-native-codex-provider-auth.md) | 中文

## 问题

Harness 此前只能通过通用 `pi-ai` 适配器和扁平凭证引用路由 OpenAI 系列模型。ChatGPT Codex 访问使用交互式 OAuth、轮换 refresh token、账户作用域标头、已认证模型目录、原生 Responses 事件，以及必须在工具续接中保留的提供方输出项。若把这些事实加入 `pi-ai`、凭证引用服务或 `agent-loop`，会让无关插件拥有 Codex 协议和机密生命周期。

## 决策

模型提供方认证是独立的能力 seam。`dsh-model-auth` 定义驱动注册表、安全状态和 challenge 值、仅 Host 可见的认证信息、生成的 Remote 操作以及 `model-auth/updated`。`dsh-model-auth-local` 使用版本零私有 JSON 文档、原子替换、跨进程写入锁、按提供方序列化以及登录取消后的完全停稳来实现它。驱动记录对 Service Provider 保持不透明。

`dsh-llm-codex` 同时贡献 `openai-codex` 认证驱动和直接 `LlmAdapter`。驱动实现浏览器 PKCE 与设备代码登录、workspace allowlist、主动刷新、永久刷新失败分类、账户保持以及 ChatGPT Codex 后端要求的标头。适配器从 `/models` 发现模型时会声明明确的 Codex 协议兼容版本，只公开标记为列出且可用于 Responses API 的条目，并为每个公开模型声明文本与图像输入。它通过附件服务解析持久图像引用，并在用户消息和工具结果中把经过验证的字节序列化为 base64 data URL `input_image` 项。它向 `/responses` 发送原生流式请求，在 401 后通过强制串行刷新重试一次，并把 Responses 事件转换为 Harness 分片。终止 Responses 事件会结算该流，而不等待尾随 `[DONE]` 或传输关闭；缺少终止事件的流会按截断失败。成功结束会把原生输出项保留为适配器回放状态。

base 组合包先挂载本地认证提供方，再挂载 Codex 插件。模型页面通过生成的 Remote namespace 渲染每个已注册认证驱动；loopback 浏览器提供 PKCE 登录，远程浏览器使用设备代码，并且两者都不会收到 token 值。`pi-ai` 保持不变，并可与原生路由并列组合。

## 安全与生命周期

OAuth 响应正文会在诊断前缩减为经过审查的错误字段。持久记录和认证标头保留在 Host 进程中；Remote 事件和结果只包含提供方 id、账户展示事实和登录 challenge。POSIX 读取会拒绝所有者之外可访问的认证文档。登录取消、驱动 dispose 和服务 dispose 会关闭回调 listener 或轮询工作，并在返回前结算后台完成任务。

## 验证

包测试固定记录校验、刷新轮换与失败分类、workspace 身份、本地持久化、Remote 安全生命周期、原生请求标头与正文、一次性 401 刷新、模型发现与图像能力、持久图像序列化、SSE 转换、usage 计量、回放状态、不支持的请求控制以及格式错误或截断的流。聚焦覆盖率使每个新源文件的 statement、branch、function 和 line 均保持 100%。模型 UI 测试套件和 base 组合包解析测试覆盖新的组合位置；组装后的 Chromium 运行会记录并回放无密钥的账户认证 golden，源码启动的 headless profile 也可随新增插件正常启动。

## 备选方案

**向 `dsh-credentials` 添加 ChatGPT OAuth。** 不予采纳，因为该服务解析具名扁平字符串，并公开凭证变更语义。OAuth 记录是结构化的，需要作为一个事务轮换，并需要协议拥有的检查和注销。

**在 `dsh-llm-pi-ai` 内实现 Codex。** 不予采纳，因为原生 Responses 回放、已认证目录和 ChatGPT 账户标头不是通用 `pi-ai` 行为。独立适配器让两条路由可分别组合，并让 `pi-ai` 升级保持不变。

**把 Codex CLI 作为子进程复用。** 不予采纳，因为这会把会话回放、工具、流式输出和进程生命周期委托给第二个 agent harness，而不是实现 Harness LLM seam。

**存储或导入 Codex CLI 认证文件。** 不予采纳，因为共享一个独立轮换的 token 文件会产生跨进程所有权和兼容性耦合。Harness 在使用同一公开 OAuth 流程后拥有自己的记录。

## 后果

提供方插件现在可以添加 OAuth 或其他可刷新登录协议，而无需扩大扁平凭证或 loop。Codex 路由会保留提供方原生续接数据，并可与 DeepSeek 和 `pi-ai` 共存。新增 seam 和 UI 比提供方本地 token helper 更大，并且每个新认证驱动都必须定义安全错误、记录校验、刷新序列化和 teardown 行为。浏览器 PKCE 仅适用于本机；远程部署使用设备代码。
