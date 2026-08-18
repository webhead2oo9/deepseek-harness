# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

An [Exa](https://exa.ai)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Exa `POST /search` with focused highlights and maps result metadata into `WebSearchResult`.

This implementation package registers a backend into `ctx.web`; [`@deepseek-ai/dsh-tool-web`](../tool-web/README.md) owns the model-facing `web_search` tool.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | — | Literal secret for compatibility. Prefer `apiKeyEnv`. |
| `apiKeyEnv` | `EXA_API_KEY` | Credential reference resolved for every search. |
| `baseURL` | `https://api.exa.ai` | Exa endpoint base; `/search` is appended. |
| `searchType` | `auto` | Standard retrieval mode: `auto`, `fast`, or `instant`. |
| `numResults` | unset | Default only when the shared request has no `maxResults`. |
| `moderation` | `true` | Ask Exa to filter unsafe results. |
| `highlightsMaxCharacters` | unset | Per-result excerpt character budget; unset uses Exa’s default selection. |
| `maxAgeHours` | unset | Cached-content age: `0` fetches fresh content and `-1` uses cache only. |

The provider registers the `web-search-exa` settings namespace. The Plugins page writes the API key through the credentials domain, so no secret is returned through settings responses.

## Mapping

Each Exa result contributes its URL, optional title, first non-blank highlight, and publication date. A result without a highlight remains a usable citation. The web capability applies the final result bound. Credential-bearing requests reject redirects before following `Location`; cancelled operations return `WEB_ABORTED`.

## Model Experience

`dsh-tool-web` provides the model-visible tool. It receives normalized, bounded sources and provider failures; Exa response fields not mapped into the shared result remain outside model context.

#### KV Cache effect

No direct invalidation; the web-tool consumer owns request-prefix changes.

## Known Limitations and Deferred Work

- The provider supports ordinary Exa retrieval modes only. Deep research, synthesis, and streaming require a separate model-facing capability.
- Category, domain, date, and page-content controls remain outside the provider-neutral request because current providers cannot honor one shared meaning for them.
