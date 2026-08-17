# Agent Note：xAI 订阅 OAuth 提供方

Status: implemented

[English](2026-08-17-xai-subscription-oauth.md) | 中文

## 问题

通用 `pi-ai` 路由支持 xAI API key，但无法把其提供方原生 OAuth 凭据绑定到 Harness 的持久模型认证服务。订阅访问需要交互式设备挑战、refresh token 轮换、已认证模型发现以及仅 Host 可见的 bearer 认证。导入其他 agent 的凭据文件会造成共享轮换所有权，并使 Harness 耦合到该 agent 的存储格式。

## 决策

`dsh-llm-xai` 注册路由和认证驱动 ID `xai-oauth`。驱动把 xAI 设备码与刷新交换委托给 `@earendil-works/pi-ai`；其受维护的实现负责公开客户端身份、权限范围、轮询规则、刷新提前量和 token 响应校验。Harness 负责中止信号、取消后的完全停稳、不透明持久记录校验、通过 `ctx.modelAuth` 执行串行刷新，以及转换为仅 Host 可见的 bearer 标头。

适配器从已认证的 `/v1/language-models` 端点发现可聊天条目，并通过共享的 pi-ai OpenAI Responses 传输提供这些模型。发现期间收到 401 时会关闭响应、强制执行一次串行刷新并重试一次。成功目录按配置时长缓存；并发刷新保持独立可取消，因为每个调用方都拥有自己的请求。未登录路由保留一个小型静态种子，使认证与模型界面始终可寻址；认证后的发现会替换它。静态 pi-ai 元数据提供已知模型的容量、模态和推理等级。没有该元数据的在线目录 ID 保留可配置的容量默认值，并继承 [xAI 已发现模型的推理等级](../bug-fix/2026-08-17-xai-discovered-model-reasoning-levels.md) 中所述的 Responses 系列推理等级。

生产 API 端点仅允许使用 HTTPS 的 `x.ai` 主机，防止通过配置把 OAuth bearer 重定向出去。HTTP 只允许用于回环测试端点。base bundle 将该插件与可通过 `llm-pi-ai` profile 配置的独立 API-key `xai` 路由并列挂载。

## 验证

包测试使源文件保持 100% 覆盖率，并固定挑战就绪、取消结算、记录校验、到期刷新、未登录目录可见性、已认证发现、调用方本地取消、一次性 401 刷新、畸形响应、端点限制、插件注册与清理以及 invariant 所有权。组装后的 Web snapshot 覆盖账户认证卡。无密钥的 headless 产品 profile snapshot 会加载隔离的 OAuth 记录，针对确定性的 loopback 服务器执行已认证发现和 Responses 请求，并固定所得会话日志；从源码启动的 Web 实例验证真实设备登录、在线目录和 Responses 请求路径。

## 备选方案

**读取 Hermes 凭据文件。** 不予采用，因为两个进程可能独立轮换同一 refresh token，而且 Hermes 存储变化会成为 Harness 的兼容性义务。

**向 `dsh-llm-pi-ai` 添加 OAuth 状态。** 不予采用，因为该包刻意按路由解析扁平凭据引用。模型认证 seam 已负责结构化 OAuth 持久化、状态、刷新串行化和登录生命周期。

**复制 xAI grant 实现。** 不予采用，因为 pi-ai 已维护 xAI 提供方使用的同一公开设备流程。复用它可删除重复协议代码，同时让 Harness 继续拥有持久状态与生命周期。

## 结果

个人 xAI 订阅账户可以在没有 API key 的情况下认证，并选择其账户可访问的模型。资格仍由提供方控制，因此完成浏览器步骤并不保证订阅等级允许 API 请求。新模型 ID 可立即以保守容量使用，并带有 Responses 系列推理选择器。
