# @deepseek-ai/dsh-client-ui-settings-subagents

English | [中文](README.zh.md)

This browser Cordis plugin registers the `subagents` settings section. It edits the Host namespace `subagent-model-selection`, whose value contains `allowDirectModelSelection` and a profile dictionary. Each profile has a description, provider, model, and optional multiline child system instruction and adapter-owned reasoning-effort id. The editor omits blank optional fields and shows configured instruction and effort values in the card preview. Profile names and stored fields are preserved exactly; model-adapter data is advisory and does not restrict manual route or effort strings. The exact child route validates an effort when the profile is used.

The page reads `settings.describe` and `llm.models` together. Writes use `settings.mutate` path operations with the namespace descriptor's current revision. A successful mutation adopts the returned value and revision. Composition-owned profiles are marked as deployment defaults: their route fields may be overridden in the user layer, but the UI does not offer rename or delete actions that would only reveal the same base profile again. A read-only settings provider leaves the current value visible and disables all editing controls. Settings-document updates for this namespace, adapter-topology updates, and connection resets refresh a page that has already loaded.

## Model Experience

### Parent delegation schema, indirectly

#### What the model sees

The page changes Host settings consumed by compatible [`subagent` delegation tools](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent). Named profiles add their names and descriptions to the optional `profile` field; enabling direct selection adds optional provider/model fields and, for compatible backends, an optional direct reasoning-effort field. A selected profile's instruction becomes an additional child-only system-prompt section, while its reasoning effort configures child model calls for the exact route. The UI package itself assembles no model request.

#### Token effect

Each configured profile adds its name and description to every parent request that exposes a compatible delegation tool. Direct selection adds two or three optional string fields according to backend reasoning support. A configured instruction also adds its text to each child request using that profile; reasoning effort may change the child model's reasoning-token use. Child token usage depends on the resolved provider/model route and remains in the child session.

#### KV Cache effect

Stable while the profile settings and resulting tool schema are unchanged. A profile or direct-selection change re-registers the tool and may invalidate parent reuse from the changed definition; a later child route uses that provider/model's independent cache.

## Known Limitations and Deferred Work

- Suggestions include only models and reasoning efforts reported by currently connected adapters. Manual strings remain available for adapters, models, or effort ids that are offline, private, or not catalogued; compatibility errors surface only when a child uses the exact route.
