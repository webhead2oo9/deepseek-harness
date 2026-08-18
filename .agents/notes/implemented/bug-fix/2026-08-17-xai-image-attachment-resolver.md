# Agent Note: xAI Grok images require the attachment resolver

Status: implemented

English | [中文](2026-08-17-xai-image-attachment-resolver.zh.md)

## Problem

The [xAI subscription adapter](../feature/2026-08-17-xai-subscription-oauth.md) advertises image input from `/v1/language-models` and documents that Grok receives supported image content. The adapter is a thin wrapper around `PiAiAdapter`. That delegate refuses any image block unless `resolveAttachments` returns the durable attachment store. The xAI plugin constructed the delegate with only catalog and OAuth hooks, so a user image or `read_image` result on an image-capable Grok model failed with `pi-ai image input requires the durable attachment service` even when `ctx.attachments` was mounted.

## Decision

`XaiAdapter` accepts the same optional `resolveAttachments` hook as `PiAiAdapter` and `CodexAdapter`. The plugin supplies `() => ctx.get('attachments')` so a store mounted after the adapter is visible on the next request. Image bytes still convert through the shared pi-ai Responses path; this package does not serialize images itself.

## Alternatives considered

**Declare `inject: ['attachments']`.** Rejected because attachments are optional in compositions that omit `read_image`, and a hard inject would park the whole xAI route until a store appears.

**Serialize images inside `XaiAdapter`.** Rejected because the delegate already converts durable refs to Responses `input_image` items; a second serializer would drift from pi-ai.

**Leave the failure as a documented limitation.** Rejected because the live catalog, README, and `read_image` admission all treat Grok as image-capable.

## Consequences

An image-bearing Grok request succeeds when the attachment store is mounted. Without the store, the same `UNSUPPORTED_CONTENT` refusal remains.

## Testing

`packages/llm/llm-xai/tests/index.spec.ts` pins the plugin hook to `ctx.get('attachments')`. `packages/llm/llm-xai/tests/adapter.spec.ts` refuses an image without the hook and, with it, reads the durable bytes into a Responses `input_image` item before the provider request.
