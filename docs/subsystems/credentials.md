# User Credentials

English | [中文](credentials.zh.md)

The credential seam of [dsh-credentials](../../packages/credentials/credentials) keeps secrets out of configuration: settings sections and `cordis.yml` entries carry *references* (environment-variable names), providers such as [dsh-credentials-local](../../packages/credentials/credentials-local) own the values, and consumers resolve a reference once per operation — the LLM adapters resolve once per model request, so a rotated credential reaches the very next request without any restart. One seam-wide rule binds every provider: an empty stored value is absent everywhere.

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## Identity

A reference names one credential as a POSIX-style environment-variable name. The brand prevents callers from mixing credential references with other strings passed between packages or processes; construction validates the shell-identifier syntax.

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

## Resolution

`resolve(ref)` returns the value with the provider-defined source layer that supplied it, or `undefined` while unconfigured. Consumers re-resolve at each operation and never cache across operations — that per-operation read is the hot-update mechanism.

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}
```

## Description

`describe(ref)` answers configuration surfaces without ever exposing a value: whether the reference resolves, from which layer, and whether `set` would currently succeed. The local provider reports a reference supplied by the live process environment as `writable: false` — a write would appear to succeed while resolution kept returning the shadowing value, so the seam rejects it and the UI can render the reference read-only up front.

```ts type-equiv
/** Source and writability facts for one reference, safe for configuration UIs — never the value. */
interface CredentialInfo {
  /** Whether {@link CredentialProvider.resolve} would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
}
```

## Change commits

`credentials/updated (ref)` fires after a committed change to a provider-managed source — a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Consumers do not need the event (they re-resolve per operation); it exists for configuration surfaces refreshing a "configured" badge.

## Model-provider authentication

[dsh-model-auth](../../packages/credentials/model-auth) is the separate structured-authentication seam for providers that require login, refresh, and account state instead of a static API key. Provider plugins register protocol drivers; [dsh-model-auth-local](../../packages/credentials/model-auth-local) owns login lifecycle and opaque durable records; adapters resolve Host-only authorization immediately before a request. Generated Remotes expose only provider status, safe account labels, login challenges, cancellation, and logout.

`ModelAuthProviderId` brands the stable driver key shared by authentication and the corresponding LLM route. `model-auth/updated (provider)` carries only that id after registration, login, refresh, logout, or stored-record status changes, so browser consumers re-read safe status without receiving credentials.

Source: [`packages/credentials/model-auth/src/index.ts`](../../packages/credentials/model-auth/src/index.ts)

```ts type-equiv
/** Nominal identifier for one model-auth driver. */
type ModelAuthProviderId = Branded<'ModelAuthProviderId'>
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcredentials--credentialprovider-abstract-seam"></a>

### `ctx.credentials` — `CredentialProvider` (abstract seam)

Abstract credential service. Providers implement the four operations over their source layers; one seam-wide rule binds them all: an empty stored value is absent everywhere — `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a configured secret.

```ts cordis-catalog
/**
 * Resolve one reference to its current value. Resolution is per call:
 * consumers re-resolve at each operation and must not cache across
 * operations — that per-operation read is what makes a changed credential
 * reach the next operation without a restart.
 * @param ref - the reference to resolve.
 * @returns the value and its source, or `undefined` while unconfigured.
 */
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

/**
 * Describe one reference for configuration surfaces without exposing the
 * value.
 * @param ref - the reference to describe.
 * @returns configured state, supplying source, and writability.
 */
abstract describe(ref: CredentialRef): Promise<CredentialInfo>

/**
 * Durably store one value in the provider-managed writable source. Rejects
 * while a read-only source shadows the reference — the write would appear
 * to succeed while resolution keeps returning the shadowing value — and
 * rejects an empty value (use {@link unset}).
 * @param ref - the reference to store.
 * @param value - the non-empty secret value.
 */
abstract set(ref: CredentialRef, value: string): Promise<void>

/**
 * Remove one reference from the provider-managed writable source; removing
 * an absent reference is a no-op. Rejects while a read-only source shadows
 * the reference, like {@link set}.
 * @param ref - the reference to remove.
 */
abstract unset(ref: CredentialRef): Promise<void>
```

Source: [`packages/credentials/credentials/src/index.ts:60`](../../packages/credentials/credentials/src/index.ts)

<a id="ctxmodelauth--modelauth-abstract-seam"></a>

### `ctx.modelAuth` — `ModelAuth` (abstract seam)

Provider-neutral model authentication service.

```ts cordis-catalog
/**
 * Register one provider driver for the contributing plugin's lifetime.
 * @param driver - provider protocol implementation.
 * @returns effect disposer that unregisters the driver after its work settles.
 */
abstract register(driver: ModelAuthDriver): () => void

/**
 * Whether a driver is currently registered under this id.
 * @param provider - provider registry id.
 * @returns whether that driver is live.
 */
abstract hasProvider(provider: ModelAuthProviderId): boolean

/**
 * List registered providers without exposing credential values.
 * @returns safe status and any live login challenge in registration order.
 */
abstract list(): Promise<ModelAuthProviderStatus[]>

/**
 * Read safe status for one registered provider.
 * @param provider - provider registry id.
 * @returns current browser-safe lifecycle, live challenge, and account facts.
 */
abstract status(provider: ModelAuthProviderId): Promise<ModelAuthProviderStatus>

/**
 * Start a login after provider resources are ready.
 * @param provider - provider registry id.
 * @param method - registered browser or device mechanism.
 * @returns the safe user action needed to continue.
 */
abstract beginLogin( provider: ModelAuthProviderId, method: ModelAuthLoginMethod, ): Promise<ModelAuthLoginChallenge>

/**
 * Cancel one live login and wait for its provider resources to close.
 * @param attemptId - live attempt returned by {@link beginLogin}.
 */
abstract cancelLogin(attemptId: ModelAuthLoginAttemptId): Promise<void>

/**
 * Resolve current request authorization, refreshing inside the provider operation when required.
 * @param provider - provider registry id.
 * @param signal - caller cancellation for refresh I/O.
 * @returns Host-only request authorization headers.
 */
abstract resolve(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization>

/**
 * Force a refresh and return the resulting request authorization.
 * @param provider - provider registry id.
 * @param signal - caller cancellation for refresh I/O.
 * @returns Host-only request authorization headers.
 */
abstract refresh(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization>

/**
 * Complete provider logout and remove the local durable record.
 * @param provider - provider registry id.
 * @param signal - caller cancellation for provider logout I/O.
 */
abstract logout(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<void>

/**
 * List browser-safe authentication state through the generated Remote API.
 * @returns safe status for every registered provider.
 */
@Remote('list') remoteList(): Promise<ModelAuthProviderStatus[]>

/**
 * Begin an interactive provider login through the generated Remote API.
 * @param provider - untrusted wire provider id.
 * @param method - requested browser or device mechanism.
 * @returns the safe user action needed to continue.
 */
@Remote('beginLogin') remoteBeginLogin(provider: string, method: ModelAuthLoginMethod): Promise<ModelAuthLoginChallenge>

/**
 * Cancel a live login through the generated Remote API.
 * @param attemptId - untrusted wire login-attempt id.
 * @returns after provider resources close.
 */
@Remote('cancelLogin') remoteCancelLogin(attemptId: string): Promise<void>

/**
 * Remove one provider's stored authentication through the generated Remote API.
 * @param provider - untrusted wire provider id.
 * @param signal - request cancellation propagated into provider logout.
 * @returns after provider logout and local deletion commit.
 */
@Remote('logout') remoteLogout(provider: string, signal: AbortSignal): Promise<void>
```

Source: [`packages/credentials/model-auth/src/index.ts:127`](../../packages/credentials/model-auth/src/index.ts)

<a id="credentials-events"></a>

### `credentials/*` events

<a id="credentialsupdated--emit"></a>

#### `credentials/updated` — emit

Committed change to a provider-managed credential source: a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Listener failures are contained and logged — a sync throw and an async rejection alike — without changing the committed operation's outcome, except `INVARIANT`-coded failures, which rethrow after every listener ran; that rethrow reaches the emitter only from synchronous listeners, so invariant checks on this event must not be async functions.

```ts cordis-catalog
/**
 * Committed change to a provider-managed credential source: a `set`, an
 * `unset`, or an external edit observed in storage. Ambient
 * process-environment changes are not observable and never emit. Listener
 * failures are contained and logged — a sync throw and an async rejection
 * alike — without changing the committed operation's outcome, except
 * `INVARIANT`-coded failures, which rethrow after every listener ran;
 * that rethrow reaches the emitter only from synchronous listeners, so
 * invariant checks on this event must not be async functions.
 * @param ref - the reference whose stored value changed.
 * @mode emit
 */
'credentials/updated'(ref: CredentialRef): void
```

Source: [`packages/credentials/credentials/src/types.ts:29`](../../packages/credentials/credentials/src/types.ts)

<a id="model-auth-events"></a>

### `model-auth/*` events

<a id="model-authupdated--emit"></a>

#### `model-auth/updated` — emit

A provider registration, login lifecycle, stored account, or logout changed. The payload contains only the provider id; consumers re-read status and no credential value crosses the event.

```ts cordis-catalog
/**
 * A provider registration, login lifecycle, stored account, or logout
 * changed. The payload contains only the provider id; consumers re-read
 * status and no credential value crosses the event.
 * @param provider - provider whose safe status changed.
 * @mode emit
 */
'model-auth/updated'(provider: ModelAuthProviderId): void
```

Source: [`packages/credentials/model-auth/src/types.ts:76`](../../packages/credentials/model-auth/src/types.ts)
<!-- END GENERATED cordis-surface -->
