# `@deepseek-ai/dsh-model-auth`

English | [中文](README.zh.md)

Provider-neutral authentication Service Definition for model providers. Drivers register login mechanisms, validate opaque records, refresh credentials, and produce Host-only request headers. Consumers receive only safe provider status, account labels, and login challenges through `ctx.modelAuth` or the generated `modelAuth` Remote namespace.

The service does not define any OAuth protocol or storage format. A Service Provider owns durable records and login lifecycle; provider adapters contribute drivers. `model-auth/updated` contains only the affected provider id.

## Model Experience

Indirectly, through registered model-provider drivers: authentication authorizes an adapter request, while values and status never enter model input.

#### KV Cache effect

No direct invalidation; authentication values never enter a request prefix.

## Known Limitations and Deferred Work

- Login attempts are process-local and are not resumed after a Harness restart.
- One live driver owns each provider id; a second registration with the same id fails.
