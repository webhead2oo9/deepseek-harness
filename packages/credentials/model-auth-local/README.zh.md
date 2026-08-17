# `@deepseek-ai/dsh-model-auth-local`

[English](README.md) | 中文

`ctx.modelAuth` 的本地 Service Provider。它把驱动拥有的 JSON 记录存入 `$DSH_HOME/.model-auth.json`，按提供方并跨进程序列化变更，并以原子方式替换仅所有者可访问的文档。登录完成、取消、驱动 dispose（资源释放）和服务 dispose 都会在返回前结算其提供方资源。

```yaml
- id: model-auth
  name: '@deepseek-ai/dsh-model-auth-local'
  config:
    path: C:/private/dsh-model-auth.json # optional; defaults under DSH_HOME
```

版本零文档拒绝未知 envelope 字段和不支持的版本。提供方记录对本包保持不透明，并在使用或替换前由已注册驱动校验。

## 模型体验

通过已注册的模型提供方驱动间接影响：所存认证会授权适配器请求，但始终位于会话日志和模型上下文之外。

#### KV Cache 影响

不会直接失效；所存认证绝不会进入请求前缀。

## 已知限制与待完成工作

- 已存的提供方记录依靠仅用户可访问的文件系统权限保护，但静态时不加密。
- Windows 无法对认证文档强制 POSIX 模式位；访问权限遵循用户的 Windows 账户权限。
