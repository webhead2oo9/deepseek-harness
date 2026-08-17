# Agent Note: Native Codex provider authentication

Status: implemented

English | [中文](2026-08-16-native-codex-provider-auth.zh.md)

## Problem

The Harness could route OpenAI-family models only through the generic `pi-ai` adapter and flat credential references. ChatGPT Codex access uses interactive OAuth, rotating refresh tokens, account-scoped headers, an authenticated model catalog, native Responses events, and provider output items that must survive tool continuations. Adding those facts to `pi-ai`, the credential-reference service, or `agent-loop` would make unrelated plugins own Codex protocol and secret lifecycle.

## Decision

Model-provider authentication is a separate capability seam. `dsh-model-auth` defines a driver registry, safe status and challenge values, Host-only authorization, generated Remote operations, and `model-auth/updated`. `dsh-model-auth-local` implements it with a version-zero private JSON document, atomic replacement, cross-process writer locking, per-provider serialization, and quiescent login cancellation. Driver records stay opaque to the Service Provider.

`dsh-llm-codex` contributes both the `openai-codex` auth driver and a direct `LlmAdapter`. The driver implements browser PKCE and device-code login, workspace allowlisting, proactive refresh, permanent refresh-failure classification, account preservation, and the headers required by the ChatGPT Codex backend. The adapter advertises an explicit Codex protocol compatibility version when discovering models from `/models`, exposes only entries marked for listing and Responses API use, sends native streaming `/responses` requests, retries once with a forced serialized refresh after a 401, and translates Responses events into Harness chunks. A terminal Responses event settles the stream without waiting for a trailing `[DONE]` or transport closure; a stream without a terminal event fails as truncated. Successful finishes retain native output items as adapter replay state.

The base bundle mounts the local auth provider before the Codex plugin. The Models page renders every registered auth driver through the generated Remote namespace; loopback browsers offer PKCE login, remote browsers use device code, and neither receives token values. `pi-ai` remains unchanged and may be composed beside the native route.

## Security and lifecycle

OAuth response bodies are reduced to reviewed error fields before diagnostics. Durable records and authorization headers stay in the Host process; Remote events and results contain only provider ids, account display facts, and login challenges. POSIX reads reject an auth document accessible beyond its owner. Login cancellation, driver disposal, and service disposal close callback listeners or polling work and settle background completion before returning.

## Verification

Package tests pin record validation, refresh rotation and failure classes, workspace identity, local persistence, Remote-safe lifecycle, native request headers and bodies, one-time 401 refresh, model discovery, SSE translation, usage accounting, replay state, unsupported request controls, and malformed or truncated streams. Focused coverage holds every new source file at 100% across statements, branches, functions, and lines. The Models UI suite and base-bundle parse test cover the new composition seats; an assembled Chromium run records and replays the keyless account-authentication golden, and the source-launched headless profile boots with the added plugins.

## Alternatives considered

**Add ChatGPT OAuth to `dsh-credentials`.** Rejected because that service resolves named flat strings and exposes credential mutation semantics. OAuth records are structured, rotate as one transaction, and require protocol-owned inspection and logout.

**Implement Codex inside `dsh-llm-pi-ai`.** Rejected because native Responses replay, authenticated catalogs, and ChatGPT account headers are not generic `pi-ai` behavior. A separate adapter keeps both routes independently composable and leaves `pi-ai` upgrades untouched.

**Reuse the Codex CLI as a subprocess.** Rejected because it would delegate session replay, tools, streaming, and process lifecycle to a second agent harness instead of implementing the Harness LLM seam.

**Store or import the Codex CLI auth file.** Rejected because sharing an independently rotated token file creates cross-process ownership and compatibility coupling. The Harness owns its own record after the same public OAuth flow.

## Consequences

Provider plugins can now add OAuth or another refreshable login protocol without widening flat credentials or the loop. The Codex route preserves provider-native continuation data and can coexist with DeepSeek and `pi-ai`. The added seam and UI are larger than a provider-local token helper, and each new auth driver must define safe errors, record validation, refresh serialization, and teardown behavior. Browser PKCE is local-machine only; remote deployments use device code.
