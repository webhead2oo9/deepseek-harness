# `@deepseek-ai/dsh-llm-codex`

English | [中文](README.zh.md)

Native OpenAI Codex provider for the Harness LLM seam. The package registers route `openai-codex`, implements the ChatGPT OAuth flows used by Codex, calls the Codex Responses backend directly, and does not depend on `pi-ai`.

## Sign in and use it

The shipped base bundle mounts this plugin and `dsh-model-auth-local`. In the Web profile, open **Settings → Models → Account authentication**, then choose **Sign in** on the Host machine or **Use device code** from a remote browser. After status changes to **Signed in**, select an `OpenAI Codex` model in the model picker. Tokens are stored in `$DSH_HOME/.model-auth.json`; the browser receives only account status and the login challenge.

For a custom composition, mount the auth Service Provider before this plugin:

```yaml
- id: model-auth
  name: '@deepseek-ai/dsh-model-auth-local'
- id: llm-codex
  name: '@deepseek-ai/dsh-llm-codex'
```

`baseURL`, OAuth issuer and client identity, callback ports, workspace allowlist, login and refresh timers, model-catalog cache duration, fallback and active context windows, stream idle timeout, and retry policy are explicit Cordis plugin config fields. Defaults target OpenAI's public ChatGPT Codex service. `clientVersion` defaults to the adapter's Codex protocol compatibility version because the backend uses it to filter the model catalog; override it only for a backend that expects a different version. `modelContextWindow` opts into a non-default active window; when discovery supplies `max_context_window`, the adapter clamps the selected override, catalog default, or fallback to that model maximum. Omitting it preserves the catalog's tuned default and leaves compaction thresholds under `dsh-compaction-basic` policy. Non-HTTPS endpoints are rejected except loopback test servers.

The adapter obtains the authenticated model catalog from `/models` and exposes only models marked for listing and supported by the Responses API. Every exposed model accepts text and image input. The adapter reads durable images from the attachment service and sends them as base64 data-URL `input_image` items in user messages or tool results. It sends native streaming requests to `/responses` and refreshes once after a 401 before returning an auth failure. A terminal Responses event settles the stream without requiring a trailing `[DONE]`; transport end or `[DONE]` before a terminal event fails with `STREAM_CLOSED`. Successful responses retain provider-native output items as replay state so encrypted reasoning and tool-call identity return unchanged on later turns. HTTP and streamed context-window failures are normalized to `CONTEXT_WINDOW_EXCEEDED` so the configured compaction backend can repair and retry them. Temperature, stop sequences, and explicit `maxTokens` are rejected because this route does not map them to the Codex backend.

## Model Experience

### Codex request

#### What the model sees

The selected model receives `GenerateOptions.system`, text and durable image content, tool schemas, tool results, reasoning effort, and provider-native replay items. OAuth values, account status, transport headers, and login UI never enter model input.

#### Token effect

Provider tokenization determines exact input. Native replay may include encrypted reasoning required for a tool continuation without exposing that content to Harness.

#### KV Cache effect

The session id becomes `prompt_cache_key`. Unchanged instructions and history preserve the earlier request prefix; provider or model changes select a different cache domain.

### Codex response

#### What the model sees

Responses SSE events become ordered reasoning, text, and tool-call chunks. A later request replays the completed native output items.

#### Token effect

Usage reports uncached input, cache reads, output, and reasoning counts when supplied by the provider.

#### KV Cache effect

Retained response items append after the prior reusable prefix. Harness does not rewrite their provider ids or encrypted reasoning fields.

## Known Limitations and Deferred Work

- Request controls without a native Codex mapping fail before network I/O.
- Browser login requires the browser and Host to share the loopback machine; remote browsers use device code.
- Windows cannot enforce POSIX mode bits on the auth document; the file remains atomically replaced under the user's Harness home.
