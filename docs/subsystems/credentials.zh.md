# 用户凭据

[English](credentials.md) | 中文

[dsh-credentials](../../packages/credentials/credentials) 的凭据 seam 把机密挡在配置之外：settings 分节与 `cordis.yml` 条目携带的是*引用*（环境变量名），值归 [dsh-credentials-local](../../packages/credentials/credentials-local) 这类提供方所有，消费方每个操作解析一次引用——LLM（大语言模型）适配器每次模型请求解析一次，因此轮换后的凭据无需任何重启即可作用于紧随其后的下一次请求。一条 seam 级规则约束每个提供方：空的存储值在任何地方都视为不存在。

来源：[`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## 标识

引用以 POSIX 风格环境变量名命名一条凭据。brand 防止调用方将凭据引用与在包或进程之间传递的其他字符串混用；构造时校验 shell 标识符语法。

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

## 解析

`resolve(ref)` 返回值及提供该值的来源层（由提供方定义）；未配置期间返回 `undefined`。消费方在每个操作中重新解析，绝不跨操作缓存——这种按操作进行的读取正是热更新机制。

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}
```

## 描述

`describe(ref)` 在绝不暴露值的前提下回应配置界面：引用当前是否可解析、来自哪一层、`set` 当前能否成功。本地提供方把由当前进程环境供值的引用报告为 `writable: false`——那样的写入会表面成功而解析持续返回遮蔽值，因此 seam 直接拒绝，界面也得以提前把该引用渲染为只读。

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

## 已提交的变更

`credentials/updated (ref)` 在提供方管理的来源发生已提交变更后发出——`set`、`unset` 或在存储中观察到的外部编辑。进程环境自身的变化不可观测，永不发出事件。消费方不需要该事件（它们按操作重新解析）；它服务于配置界面刷新「已配置」徽标。

## 模型提供方认证

[dsh-model-auth](../../packages/credentials/model-auth) 是面向需要登录、刷新和账户状态而非静态 API 密钥的提供方的独立结构化认证 seam。提供方插件注册协议驱动；[dsh-model-auth-local](../../packages/credentials/model-auth-local) 拥有登录生命周期和不透明持久记录；适配器在请求前立即解析仅 Host 可见的授权信息。生成的 Remote 只暴露提供方状态、安全账户标签、登录 challenge、取消和登出。

`ModelAuthProviderId` 为认证与对应 LLM 路由共用的稳定驱动键提供 brand。`model-auth/updated (provider)` 在注册、登录、刷新、登出或已存记录状态变化后只携带该 id，因此浏览器消费方可重新读取安全状态而不会收到凭据。

来源：[`packages/credentials/model-auth/src/index.ts`](../../packages/credentials/model-auth/src/index.ts)

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
