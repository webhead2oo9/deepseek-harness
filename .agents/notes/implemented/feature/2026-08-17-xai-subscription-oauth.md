# Agent Note: xAI subscription OAuth provider

Status: implemented

English | [中文](2026-08-17-xai-subscription-oauth.zh.md)

## Problem

The generic `pi-ai` route supports xAI API keys but cannot bind its provider-native OAuth credential to Harness's durable model-auth service. Subscription access needs an interactive device challenge, refresh-token rotation, authenticated model discovery, and Host-only bearer authorization. Importing another agent's credential file would create shared rotation ownership and couple Harness to that agent's storage format.

## Decision

`dsh-llm-xai` registers route and auth-driver id `xai-oauth`. The driver delegates the xAI device-code and refresh exchanges to `@earendil-works/pi-ai`, whose maintained implementation owns the public client identity, scopes, polling rules, refresh skew, and token-response validation. Harness owns the abort signal, quiescent cancellation, opaque durable record validation, serialized refresh through `ctx.modelAuth`, and conversion to a Host-only bearer header.

The adapter discovers chat-capable entries from the authenticated `/v1/language-models` endpoint and serves them through the shared pi-ai OpenAI Responses transport. A 401 during discovery closes the response, forces one serialized refresh, and retries once. Successful catalogs are cached for a configured lifetime. The signed-out route retains a small static seed so authentication and model surfaces remain addressable; authenticated discovery replaces it. Static pi-ai metadata supplies known model capacities, modalities, and reasoning levels, while new ids receive explicit configurable capacity defaults and no inferred reasoning controls.

The production API endpoint is restricted to HTTPS `x.ai` hosts so an OAuth bearer cannot be redirected by configuration. HTTP is accepted only for loopback test endpoints. The base bundle mounts this plugin beside the independent API-key `xai` route available through configurable `llm-pi-ai` profiles.

## Verification

Package tests cover challenge readiness, cancellation settlement, record validation, expiry refresh, signed-out catalog visibility, authenticated discovery, one-time 401 refresh, malformed responses, endpoint restrictions, plugin registration, and invariant ownership. The assembled Web snapshot covers the new account-authentication card, and a source-launched Web instance verifies the real device login, live catalog, and Responses request path.

## Alternatives considered

**Read the Hermes credential file.** Rejected because two processes could rotate the same refresh token independently, and Hermes storage changes would become a Harness compatibility obligation.

**Add OAuth state to `dsh-llm-pi-ai`.** Rejected because that package deliberately resolves flat credential references per route. The model-auth seam already owns structured OAuth persistence, status, refresh serialization, and login lifecycle.

**Copy the xAI grant implementation.** Rejected because pi-ai already maintains the exact public device flow used by the xAI provider. Reusing it deletes duplicated protocol code while leaving durable ownership and lifecycle in Harness.

## Consequences

Personal xAI subscription accounts can authenticate without an API key and select the models their account can access. Eligibility remains provider-controlled, so completing the browser step does not guarantee the subscription tier permits API requests. New model ids are usable immediately with conservative sizing, but gain richer reasoning metadata only after pi-ai catalogs them or deployment configuration is extended.
