# `@deepseek-ai/dsh-model-auth`

[English](README.md) | 中文

面向模型提供方的提供方无关认证 Service Definition。驱动注册登录机制、校验不透明记录、刷新凭证，并生成仅 Host 可见的请求标头。消费方只能通过 `ctx.modelAuth` 或生成的 `modelAuth` Remote namespace 获取安全的提供方状态、账户标签和登录 challenge。

该服务不定义任何 OAuth 协议或存储格式。Service Provider 拥有持久记录和登录生命周期；提供方适配器贡献驱动。`model-auth/updated` 只包含受影响的提供方 id。

## 模型体验

通过已注册的模型提供方驱动间接影响：认证会授权适配器请求，但认证值和状态绝不会进入模型输入。

#### KV Cache 影响

不会直接失效；认证值绝不会进入请求前缀。

## 已知限制与待完成工作

- 登录尝试仅存在于当前进程，Harness 重启后不会恢复。
- 每个提供方 id 只能由一个活跃驱动拥有；重复 id 的第二次注册会失败。
