# `@deepseek-ai/dsh-llm-xai`

English | [中文](README.zh.md)

xAI subscription provider for DeepSeek Harness. The plugin registers the `xai-oauth` model-auth driver and LLM route, signs in through xAI's device-code flow, stores the resulting OAuth credential through `ctx.modelAuth`, discovers chat-capable models from `/v1/language-models`, and sends requests through the OpenAI Responses protocol implemented by `@deepseek-ai/dsh-llm-pi-ai`.

The login uses the public xAI client identity and scopes maintained by `@earendil-works/pi-ai`. Access tokens refresh before use after their refresh-skewed expiry. A 401 from model discovery forces one serialized refresh and one retry. Login cancellation aborts polling and settles only after the provider operation stops.

```yaml
- id: llm-xai
  name: '@deepseek-ai/dsh-llm-xai'
  config:
    modelCacheTtlMs: 300000
```

`baseURL` defaults to `https://api.x.ai/v1`. Production configuration accepts only HTTPS `x.ai` hosts so a stored bearer token cannot be redirected to another origin; HTTP loopback endpoints remain available for tests. Discovered models inherit static pi-ai capacity and reasoning metadata when available, with configurable conservative fallbacks for newer model ids.

This route is intended for personal subscription access. xAI controls account eligibility and may reject OAuth API access for accounts or subscription tiers that do not include it.

## Model Experience

### Grok request

#### What the model sees

The selected model receives `GenerateOptions.system`, text and supported image content, tool schemas, tool results, and supported request controls through the OpenAI Responses protocol. OAuth values, account state, discovery responses, and login challenges never enter model input.

#### Token effect

xAI determines exact tokenization. Harness forwards the provider's reported input and output usage through the shared pi-ai stream translation.

#### KV Cache effect

The session id is forwarded to the Responses implementation for provider-supported affinity. Harness does not promise cache reuse across model or provider changes.

### Grok response

#### What the model sees

Responses events become ordered `StreamChunk` reasoning, text, tool-call, usage, and finish values. Subsequent requests receive the reconstructed conversation through the shared pi-ai context translation.

#### Token effect

Provider usage is retained when xAI supplies it. Unknown or omitted usage fields are not estimated by this adapter.

#### KV Cache effect

Completed assistant and tool content appends after the prior request prefix. Provider-native cache policy remains controlled by xAI.

## Known Limitations and Deferred Work

- xAI account and subscription eligibility are provider-controlled; a successful browser authorization may still be followed by an API authorization error.
- Newly discovered model ids use configured fallback capacities and expose no reasoning selector until pi-ai publishes matching metadata.
- The device flow provides no account profile fields, so the signed-in card cannot display an email or subscription name.
