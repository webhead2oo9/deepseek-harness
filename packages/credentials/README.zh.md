# credentials/：凭据引用

[English](README.md) | 中文

凭据能力家族将引用解析与提供方分离：

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`credentials/`](credentials/README.md) | 凭据引用 seam | `ctx.credentials` |
| [`credentials-local/`](credentials-local/README.md) | 环境与本地文件提供方 | 注册 `ctx.credentials` |
| [`model-auth/`](model-auth/README.md) | 可刷新的模型提供方认证 seam | `ctx.modelAuth` |
| [`model-auth-local/`](model-auth-local/README.md) | 私有本地模型认证提供方 | 注册 `ctx.modelAuth` |

扁平凭证携带引用而非机密值。结构化模型认证让协议拥有的记录保持不透明，只公开 Host 请求认证信息和对浏览器安全的状态。变更、优先级、登录生命周期和存储语义由子级 README 负责。

子系统参考——`CredentialRef`、按操作解析、对 UI 安全的 `CredentialInfo`、提供方层——见 [docs/subsystems/credentials.md](../../docs/subsystems/credentials.md)。
