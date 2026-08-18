# Agent Note: Subagent model routes use persisted named profiles

Status: implemented

English | [中文](2026-08-17-subagent-model-profiles.zh.md)

## Problem

A delegation tool can set one child model route through its composition `agentOptions`, but every call through that tool shares the route. Exposing raw provider and model identifiers on every call gives the model flexibility without a deployment-owned shortlist or descriptions, while duplicating named tools for each route expands the tool catalog and makes user changes require composition edits.

Subagent backends do not all control an LLM route. In-process children create Harness Agents and can honor provider/model options; fixed external products such as Codex and Claude Code select models through their own configuration. A common selector must not advertise a choice that a backend ignores.

## Decision

`SubagentRuntime` owns the `subagent-model-selection` settings section. It resolves composition defaults with the optional settings provider and publishes one shared value containing `profiles` and `allowDirectModelSelection`. Each profile has a model-facing description, an opaque provider/model pair, and optional child-only system instruction and adapter-owned reasoning effort. The Web `Subagents` settings section edits that namespace, offers live model and exact-route reasoning metadata as suggestions, accepts manual strings for private, dormant, or future providers, and provides instruction and effort editors with a compact card preview.

A `tool-subagent` instance bound to a backend with the `modelRoute` capability exposes configured profile names. It also exposes direct `provider` and `model` fields when the shared opt-in is true, plus `reasoning_effort` when the backend supports it. A call chooses a profile or a complete direct route, never both. The selected route replaces only `agentOptions.provider` and `agentOptions.model`; other child options remain intact. When present, the profile instruction is installed as a separate child-only system-prompt section rather than replacing the deployment persona or changing the delegated user task. Reasoning effort remains an opaque exact-route value and reaches child model calls through the scoped request configuration. Settings changes re-register the tool so the next model request sees the current enum and descriptions.

Provider and model identifiers remain opaque. No built-in provider allowlist validates names at configuration time; the child LLM runtime reports an unavailable route when it attempts the request. Reasoning effort follows the [adapter-owned exact-route capability](../architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md) and fails before provider I/O when unsupported. `spawn` and `fork` advertise routes, instructions, and reasoning effort; `dsh-sdk` advertises routes only. Fixed ACP, Codex, and Claude Code backends do not expose selectors; `dsh-sdk` omits profiles that require an instruction or reasoning effort it cannot install. Forced unsupported fields fail instead of being ignored.

Continuable descriptors persist the resolved provider/model pair, child system instruction, and reasoning effort rather than the profile name. A child therefore resumes with its established route, instruction, and effort even when a profile is renamed, edited, or removed.

## Alternatives considered

**Expose only raw provider/model fields.** This matches the workflow agent override, but gives deployments no concise allowlist or task-oriented descriptions. Direct selection remains available as an explicit setting rather than the default interface.

**Create one delegation tool per model.** Separate tools work with existing composition, but duplicate the prompt, scheduling, and result contract for a routing choice and require a composition edit for every user change.

**Restrict profiles to the live model catalog.** The catalog is advisory and may omit private, temporarily offline, or newly configured adapters. Persisting arbitrary strings keeps external routes such as RunInfra usable while execution remains the authoritative route check.

**Prepend profile instructions to the delegated task.** A task prefix would mix stable role guidance with caller-authored work and repeat it in the user message. A separate child-only system section preserves the distinction and composes with, rather than replaces, the deployment persona.

**Store the selected profile name on continuable children.** Resolving the name again on resume would let an unrelated settings edit move an established conversation to another model. Persisting the resolved route preserves child identity and replay behavior.

**Let unsupported backends ignore route options.** Silent fallback would make the model-visible selector dishonest. The capability flag keeps fixed-model backends usable without advertising unsupported choices and lets the service reject alternate callers before provider startup.

## Consequences

- Users can add, edit, rename, and remove user-owned subagent model profiles in the Web GUI without changing a Cordis composition; deployment defaults can be overridden but not renamed or deleted there.
- Named profiles are the default controlled interface; arbitrary direct routing is a persisted opt-in.
- Profile edits change future delegation schemas and calls but do not retarget or rewrite existing continuable children.
- An optional instruction adds stable profile-specific text to each child request and therefore consumes child context tokens; an optional effort selects adapter-owned reasoning behavior for the exact child route.
- A custom subagent backend supports routes by advertising `modelRoute`, profile instructions through `instruction`, and reasoning effort through `reasoningEffort`.
- Provider capability, settings layering, conditional tool schemas, route persistence, and the Web editor are pinned by package tests plus a real Web settings scenario.
