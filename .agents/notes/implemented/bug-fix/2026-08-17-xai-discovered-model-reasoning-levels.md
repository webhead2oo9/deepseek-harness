# Agent Note: xAI discovered models inherit Responses reasoning levels

Status: implemented

English | [中文](2026-08-17-xai-discovered-model-reasoning-levels.zh.md)

## Problem

The xAI subscription adapter discovers chat models from `/v1/language-models` and only attaches a reasoning selector when pi-ai's static catalog has `reasoning: true` for that exact id. The installed catalog's Responses family currently names `grok-4.5`. A newer live id such as `grok-4.6` is usable immediately, but the composer model seat hides the Effort row because `resolveModel` reports no `reasoning`.

xAI's Responses protocol accepts the same `low` / `medium` / `high` `reasoning.effort` values on those Grok releases. Offering no selector leaves the account on the provider default with no way to change it. The [xAI OAuth provider](../feature/2026-08-17-xai-subscription-oauth.md) originally withheld inferred reasoning so a later non-reasoning id would not gain a fake Off control.

## Decision

A live catalog id with no matching pi-ai entry receives `DEFAULT_XAI_REASONING_EFFORTS`: `low`, `medium`, and `high`, with no `off`. That is grok-4.5's Responses map, not pi-ai's five-level default. A live catalog alias that equals a known pi-ai model id inherits that entry's capacity and reasoning map. An installed entry marked non-reasoning still publishes no selector.

The composer Effort row is the existing `ModelSelect` path: it renders `resolveModel().reasoning` and does not invent levels.

## Alternatives considered

**Wait for pi-ai to catalog each Grok release.** Rejected because every new live id would ship without an Effort row until a dependency bump, which is the defect users hit on grok-4.6.

**Parse reasoning fields from `/v1/language-models`.** Rejected because the adapter's accepted envelope does not carry per-model effort lists, and inventing a parser for undocumented fields would fail closed back to no selector.

**Reuse pi-ai's no-map default (`off` / `minimal` / `low` / `medium` / `high`).** Rejected because Grok Responses models do not accept Off, and advertising it would show a control that cannot disable thinking.

**Keep withholding the selector for unknown ids.** Rejected because the live catalog's current chat ids are reasoning models, and hiding the control is worse than offering the three documented Responses levels.

## Consequences

Selecting grok-4.6 or another uncataloged live id shows Low / Medium / High in the model seat. A future non-reasoning xAI chat id keeps that selector until pi-ai catalogs it. Cataloged ids, including grok-4.3's no-map defaults and grok-4.5's explicit map, stay authoritative.

## Testing

`packages/llm/llm-xai/tests/adapter.spec.ts` pins grok-4.6 and other unknown ids to `low` / `medium` / `high` without `off`, alias inheritance of grok-4.5 capacity and efforts, and the existing grok-4.3 no-map default. The keyless headless snapshot discovers uncataloged grok-4.6 through the assembled xAI route and verifies that a selected `medium` effort reaches `reasoning.effort`; the composer separately pins advertised efforts in `apps/web/tests/declared-reasoning.e2e.ts`.
