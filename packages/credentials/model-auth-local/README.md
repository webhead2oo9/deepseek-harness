# `@deepseek-ai/dsh-model-auth-local`

English | [中文](README.zh.md)

Local Service Provider for `ctx.modelAuth`. It stores driver-owned JSON records in `$DSH_HOME/.model-auth.json`, serializes changes per provider and across processes, and replaces the owner-only document atomically. Login completion, cancellation, driver disposal, and service disposal settle their provider resources before returning.

```yaml
- id: model-auth
  name: '@deepseek-ai/dsh-model-auth-local'
  config:
    path: C:/private/dsh-model-auth.json # optional; defaults under DSH_HOME
```

The version-zero document rejects unknown envelope fields and unsupported versions. Provider records remain opaque to this package and are validated by their registered drivers before use or replacement.

## Model Experience

Indirectly, through registered model-provider drivers: stored authentication authorizes adapter requests but remains outside the session log and model context.

#### KV Cache effect

No direct invalidation; stored authentication never enters a request prefix.

## Known Limitations and Deferred Work

- Stored provider records are protected by user-only filesystem access but are not encrypted at rest.
- Windows cannot enforce POSIX mode bits on the auth document; access follows the user's Windows account permissions.
