# Agent Note: Complete-request compaction admission

Status: implemented

English | [中文](2026-08-17-complete-request-compaction-admission.zh.md)

## Problem

Pressure compaction at `agent/pre-step` measured the durable surface before the claimed message batch, runtime context, final request header, and active adapter capacity were all present. One large incoming message or a route change could therefore move an imminent request from below the configured threshold to beyond the active context window without another proactive check. Provider-confirmed overflow remained a backstop only when the adapter normalized that failure.

Native Codex also distinguishes the catalog's tuned default context window from an optional larger active window. Treating the default as an immutable maximum prevented an explicit extended-window choice, while adopting the catalog maximum by default would increase context use without user intent.

## Decision

The agent loop dispatches the scoped `agent/request-admission` waterfall after it has recorded entered messages, resolved `agent/request`, prepared the exact adapter registration, logged the canonical request header and active capacity, and frozen the complete request, but before adapter stream dispatch. The payload carries the immutable request, active `contextWindow`, turn and step coordinates, rebuild count, and turn signal.

An admission listener returns `{ kind: 'rebuild' }` only after a durable surface replacement advances `Session.surface.replaceGeneration`. The loop rejects no-progress rebuilds and fails the turn after eight progress-making rebuilds, preserves the prepared adapter, call config, system prompt, tools, and capacity, reconstructs messages from `Session.deriveMessages()`, and redispatches admission. No discarded candidate reaches an adapter or produces assistant chunks. This keeps policy in plugins while preserving request reconstruction from the log.

`dsh-compaction-basic` owns proactive admission. It prices the supplied canonical request header and complete current surface with `ctx.tokenMeter`, applies policy to the supplied active capacity, and returns rebuild after pruning or summary replacement advances the surface. It skips only the immediate pass carrying its own replacement generation; a replacement made by any other admission listener is measured on the following pass. It does not resolve model metadata again. Canonical provider overflow remains on `agent/request-error` as the reactive fallback.

The native Codex adapter normalizes recognized HTTP and streamed context-window failures to `CONTEXT_WINDOW_EXCEEDED`. Its optional `modelContextWindow` config selects an active window without changing the default; discovery-provided `max_context_window` clamps the selected override, catalog default, or fallback. Compaction thresholds remain compaction policy rather than adapter policy.

## Testing

Agent-loop tests pin the frozen admission payload, generation-proven message-only rebuild, single adapter dispatch, no-progress rejection, and the repeated-progress rebuild bound. Compaction listener-order tests prove that requests rebuilt before or after its listener are remeasured while its own immediate rebuild pass does not repeat compaction. Real-loop compaction coverage starts from persisted history, adds an entering message that qualifies the complete request for pressure, and proves the first dispatched request contains the checkpoint instead of the shadowed history. Existing real-loop overflow tests continue to prove thrown and in-band recovery. A keyless assembled headless snapshot records proactive compaction between a tool continuation's `step/start` and its first provider chunk, then proves the rebuilt request completes.

Codex adapter tests pin configured-window clamping plus canonical HTTP code/type/message, failed/incomplete response, and generic SSE overflow classification. Type checking and generated scoped-event verification ensure every agent event map supplies the new scoped resolver.

## Alternatives considered

- **Keep pre-step pressure and rely on overflow recovery** — rejected because providers may truncate, accept, or classify oversized requests inconsistently, and the first over-budget request has already crossed the network boundary.
- **Estimate the claimed batch inside `agent/pre-step`** — rejected because runtime context, final routing, adapter defaults, tools, and capacity are not yet fixed there.
- **Re-run complete request construction after compaction** — rejected because only the durable message surface changes. Reusing the prepared route prevents repeated request middleware effects and keeps one adapter registration bound to the attempt.
- **Use the Codex maximum window by default** — rejected because the larger window is an explicit cost/performance choice. The catalog default remains active unless configuration opts in.

## Consequences

Every proactive pressure decision describes the request that would otherwise be dispatched, including newly entered messages and final route capacity. A successful replacement incurs one local message reconstruction and another admission pass but no discarded provider call. Admission plugins cannot rebuild without durable model-visible progress, and repeated progress cannot keep one pending request alive beyond the fixed eight-rebuild protocol bound.

The agent loop gains one awaited extension point and compaction triggers carry exact imminent request facts. Adapters must continue normalizing provider overflow for reactive recovery. Surface compaction still cannot shrink an oversized system/tool envelope or split one indivisible retained message.
