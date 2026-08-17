/**
 * Same-host model authentication provider over `$DSH_HOME/.model-auth.json`.
 * Provider plugins register protocol drivers; this service owns their live
 * login operations and stores each driver's opaque JSON record through atomic
 * owner-only file replacement.
 * @module @deepseek-ai/dsh-model-auth-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  ModelAuth,
  ModelAuthError,
  modelAuthLoginAttemptId,
  modelAuthProviderId,
} from '@deepseek-ai/dsh-model-auth'
import type {
  ModelAuthDriver,
  ModelAuthLoginOperation,
  ModelAuthorization,
} from '@deepseek-ai/dsh-model-auth'
import type {
  ModelAuthLoginAttemptId,
  ModelAuthLoginChallenge,
  ModelAuthLoginMethod,
  ModelAuthProviderId,
  ModelAuthProviderStatus,
} from '@deepseek-ai/dsh-model-auth/types'

/** Basename of the model-auth document inside the Harness home. */
export const MODEL_AUTH_FILENAME = '.model-auth.json'

/** Durable document version; incompatible records fail at read. */
export const MODEL_AUTH_FORMAT_VERSION = 0

/** Plugin configuration for the local model-auth provider. */
export interface Config {
  /** Auth document path; defaults to `.model-auth.json` under the Harness home. */
  path?: string
  /** Harness home used when `path` is omitted. */
  dshHome?: string
}

/** Fully resolved local provider parameters. */
export interface ResolvedSpec {
  /** Absolute durable document path. */
  filename: string
}

/**
 * Resolve the durable auth path once at provider construction.
 * @param config - raw local-provider configuration.
 * @returns absolute durable document location.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    filename: resolve(config.path ?? join(resolveDshHome(config.dshHome), MODEL_AUTH_FILENAME)),
  }
}

interface AuthDocument {
  version: typeof MODEL_AUTH_FORMAT_VERSION
  providers: Record<string, unknown>
}

interface ActiveLogin {
  provider: ModelAuthProviderId
  attemptId: ModelAuthLoginAttemptId
  controller: AbortController
  operation: ModelAuthLoginOperation
  settled: Promise<void>
}

interface StartingLogin {
  controller: AbortController
  settled: Promise<void>
  reason: string
}

const EMPTY_DOCUMENT = (): AuthDocument => ({
  version: MODEL_AUTH_FORMAT_VERSION,
  providers: {},
})

const GROUP_OTHER_BITS = 0o077

/** Whether a filesystem error means the auth document is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Reject a POSIX auth document readable outside its owner before reading it. */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (isENOENT(error)) return
    throw error
  }
  /* v8 ignore next -- native Windows has no POSIX permission bits to enforce */
  if (process.platform === 'win32') return
  /* v8 ignore start -- the POSIX peer is exercised only on POSIX runners */
  if ((mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(
      `model-auth-local: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  /* v8 ignore stop */
}

/** Whether a value is a non-array JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the strict durable envelope without inspecting provider-owned records.
 * @param text - complete UTF-8 JSON document.
 * @param filename - path used only in diagnostics.
 * @returns detached version-zero document.
 */
export function parseAuthDocument(text: string, filename: string): AuthDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(`model-auth-local: invalid JSON document at ${filename}`)
  }
  if (!isObject(parsed)) {
    throw new TypeError(`model-auth-local: ${filename} must contain an object`)
  }
  const keys = Object.keys(parsed)
  if (keys.some(key => key !== 'version' && key !== 'providers')) {
    throw new TypeError(`model-auth-local: ${filename} has unknown top-level fields`)
  }
  if (parsed.version !== MODEL_AUTH_FORMAT_VERSION) {
    throw new Error(
      `model-auth-local: ${filename} has unsupported format version ${String(parsed.version)}`,
    )
  }
  if (!isObject(parsed.providers)) {
    throw new TypeError(`model-auth-local: ${filename} field "providers" must be an object`)
  }
  for (const provider of Object.keys(parsed.providers)) modelAuthProviderId(provider)
  return {
    version: MODEL_AUTH_FORMAT_VERSION,
    providers: structuredClone(parsed.providers),
  }
}

/** Render and verify that every provider-owned record is lossless JSON. */
function renderAuthDocument(document: AuthDocument): string {
  let text: string
  try {
    text = JSON.stringify(document, undefined, 2)
  } catch (error) {
    throw new ModelAuthError('model auth driver returned a record that is not JSON-serializable', 'INVALID_RECORD', {
      cause: error,
    })
  }
  return `${text}\n`
}

/** File-backed model-auth registry and runtime. */
export class LocalModelAuth extends ModelAuth {
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
  })

  private readonly spec: ResolvedSpec
  private readonly drivers = new Map<ModelAuthProviderId, ModelAuthDriver>()
  private readonly attempts = new Map<ModelAuthLoginAttemptId, ActiveLogin>()
  private readonly activeByProvider = new Map<ModelAuthProviderId, ModelAuthLoginAttemptId>()
  private readonly startingByProvider = new Map<ModelAuthProviderId, StartingLogin>()
  private readonly failures = new Map<ModelAuthProviderId, string>()
  private readonly tails = new Map<ModelAuthProviderId, Promise<void>>()
  private readonly work = new Set<Promise<void>>()
  private closed = false

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.spec = resolveSpec(config)
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    await this.readDocument()
    yield async () => {
      this.closed = true
      const providers = new Set([...this.startingByProvider.keys(), ...this.activeByProvider.keys()])
      await Promise.allSettled([...providers].map(provider => (
        this.cancelProviderLogin(provider, 'model-auth service disposed')
      )))
      await Promise.allSettled(this.work)
      this.startingByProvider.clear()
      this.attempts.clear()
      this.activeByProvider.clear()
      this.failures.clear()
      this.drivers.clear()
    }
  }

  override register(driver: ModelAuthDriver): () => Promise<void> {
    if (this.closed) throw new ModelAuthError('model-auth service is disposed', 'DISPOSED')
    if (this.drivers.has(driver.id)) {
      throw new ModelAuthError(`model auth provider "${driver.id}" is already registered`, 'DUPLICATE_PROVIDER')
    }
    if (driver.methods.length === 0 || new Set(driver.methods).size !== driver.methods.length) {
      throw new ModelAuthError(`model auth provider "${driver.id}" must declare unique login methods`, 'INVALID_DRIVER')
    }
    const dispose = this.ctx.effect(function* (this: LocalModelAuth) {
      this.drivers.set(driver.id, driver)
      this.notifyUpdated(driver.id)
      yield async () => {
        await this.cancelProviderLogin(driver.id, `model auth provider "${driver.id}" was disposed`)
        this.failures.delete(driver.id)
        this.drivers.delete(driver.id)
        this.notifyUpdated(driver.id)
      }
    }.bind(this), 'modelAuth.register()')
    return dispose
  }

  override hasProvider(provider: ModelAuthProviderId): boolean {
    return this.drivers.has(provider)
  }

  override async list(): Promise<ModelAuthProviderStatus[]> {
    const statuses: ModelAuthProviderStatus[] = []
    for (const provider of this.drivers.keys()) statuses.push(await this.status(provider))
    return statuses
  }

  override async status(provider: ModelAuthProviderId): Promise<ModelAuthProviderStatus> {
    const driver = this.driver(provider)
    const attemptId = this.activeByProvider.get(provider)
    if (attemptId !== undefined) {
      const attempt = this.liveAttempt(attemptId)
      return {
        ...this.safeStatus(driver, 'signing-in'),
        challenge: this.challenge(provider, attemptId, attempt.operation),
      }
    }
    const failure = this.failures.get(provider)
    if (failure !== undefined) return this.safeStatus(driver, 'error', undefined, failure)
    const record = (await this.readDocument()).providers[provider]
    if (record === undefined) return this.safeStatus(driver, 'signed-out')
    try {
      return this.safeStatus(driver, 'signed-in', driver.inspect(record))
    } catch (error) {
      return this.safeStatus(driver, 'error', undefined, this.safeError(error))
    }
  }

  override beginLogin(
    provider: ModelAuthProviderId,
    method: ModelAuthLoginMethod,
  ): Promise<ModelAuthLoginChallenge> {
    return this.serial(provider, async () => {
      const driver = this.driver(provider)
      if (!driver.methods.includes(method)) {
        throw new ModelAuthError(
          `model auth provider "${provider}" does not support ${method} login`,
          'UNSUPPORTED_LOGIN_METHOD',
        )
      }
      if (this.activeByProvider.has(provider)) {
        throw new ModelAuthError(`model auth provider "${provider}" already has a live login`, 'LOGIN_ACTIVE')
      }
      const controller = new AbortController()
      let settleStarting!: () => void
      const starting: StartingLogin = {
        controller,
        settled: new Promise<void>((resolve) => { settleStarting = resolve }),
        reason: 'model auth login cancelled during startup',
      }
      this.startingByProvider.set(provider, starting)
      try {
        const operation = await driver.startLogin(method, controller.signal)
        if (controller.signal.aborted) {
          await operation.cancel(starting.reason)
          throw new ModelAuthError(starting.reason, 'LOGIN_CANCELLED')
        }
        const attemptId = modelAuthLoginAttemptId(crypto.randomUUID())
        const active = {} as ActiveLogin
        const settled = this.finishLogin(provider, attemptId, operation)
        Object.assign(active, { provider, attemptId, controller, operation, settled })
        this.attempts.set(attemptId, active)
        this.activeByProvider.set(provider, attemptId)
        this.failures.delete(provider)
        this.track(settled)
        this.notifyUpdated(provider)
        return this.challenge(provider, attemptId, operation)
      } finally {
        this.startingByProvider.delete(provider)
        settleStarting()
      }
    })
  }

  override async cancelLogin(attemptId: ModelAuthLoginAttemptId): Promise<void> {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) {
      throw new ModelAuthError(`model auth login attempt "${attemptId}" is not active`, 'NO_LOGIN')
    }
    attempt.controller.abort(new Error('model auth login cancelled'))
    await attempt.operation.cancel('model auth login cancelled')
    await attempt.settled
  }

  override resolve(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization> {
    return this.resolveAuthorization(provider, false, signal)
  }

  override refresh(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<ModelAuthorization> {
    return this.resolveAuthorization(provider, true, signal)
  }

  override async logout(provider: ModelAuthProviderId, signal?: AbortSignal): Promise<void> {
    const attemptId = this.activeByProvider.get(provider)
    if (attemptId !== undefined) {
      const attempt = this.liveAttempt(attemptId)
      attempt.controller.abort(new Error('model auth logout cancelled the active login'))
      await attempt.operation.cancel('model auth logout cancelled the active login')
      await attempt.settled
    }
    await this.serial(provider, async () => {
      const driver = this.driver(provider)
      await this.withDocumentLock(async (document) => {
        const record = document.providers[provider]
        if (record === undefined) return false
        if (driver.logout !== undefined) await driver.logout(record, signal)
        const { [provider]: _removed, ...remaining } = document.providers
        document.providers = remaining
        await this.writeDocument(document)
        return true
      })
      this.failures.delete(provider)
      this.notifyUpdated(provider)
    })
  }

  /** Resolve one registered driver or fail before touching durable state. */
  private driver(provider: ModelAuthProviderId): ModelAuthDriver {
    const driver = this.drivers.get(provider)
    if (driver === undefined) {
      throw new ModelAuthError(`model auth provider "${provider}" is not registered`, 'NO_PROVIDER')
    }
    return driver
  }

  /** Construct detached status with the driver's registration facts. */
  private safeStatus(
    driver: ModelAuthDriver,
    state: ModelAuthProviderStatus['state'],
    account?: ModelAuthProviderStatus['account'],
    error?: string,
  ): ModelAuthProviderStatus {
    return {
      provider: driver.id,
      displayName: driver.displayName,
      methods: [...driver.methods],
      state,
      ...account === undefined ? {} : { account: structuredClone(account) },
      ...error === undefined ? {} : { error },
    }
  }

  /** Attach service-owned ids to one driver challenge. */
  private challenge(
    provider: ModelAuthProviderId,
    attemptId: ModelAuthLoginAttemptId,
    operation: ModelAuthLoginOperation,
  ): ModelAuthLoginChallenge {
    const challenge = operation.challenge
    switch (challenge.kind) {
      case 'browser':
        return { kind: 'browser', provider, attemptId, authorizationUrl: challenge.authorizationUrl }
      case 'device':
        return {
          kind: 'device',
          provider,
          attemptId,
          verificationUrl: challenge.verificationUrl,
          userCode: challenge.userCode,
          expiresAt: challenge.expiresAt,
        }
    }
  }

  /** Cancel startup or an active attempt and wait until its provider resources settle. */
  private async cancelProviderLogin(provider: ModelAuthProviderId, reason: string): Promise<void> {
    const starting = this.startingByProvider.get(provider)
    if (starting !== undefined) {
      starting.reason = reason
      starting.controller.abort(new Error(reason))
      await starting.settled
    }
    const attemptId = this.activeByProvider.get(provider)
    if (attemptId === undefined) return
    const attempt = this.liveAttempt(attemptId)
    attempt.controller.abort(new Error(reason))
    await attempt.operation.cancel(reason)
    await attempt.settled
  }

  /** Persist a completed login or publish its safe failure, then remove its live state. */
  private async finishLogin(
    provider: ModelAuthProviderId,
    attemptId: ModelAuthLoginAttemptId,
    operation: ModelAuthLoginOperation,
  ): Promise<void> {
    try {
      const record = await operation.completion
      await this.serial(provider, async () => {
        const driver = this.driver(provider)
        driver.inspect(record)
        await this.withDocumentLock(async (document) => {
          document.providers[provider] = structuredClone(record)
          await this.writeDocument(document)
        })
        this.failures.delete(provider)
        this.removeAttempt(attemptId)
        this.notifyUpdated(provider)
      })
    } catch (error) {
      await this.serial(provider, () => {
        this.failures.set(provider, this.safeError(error))
        this.removeAttempt(attemptId)
        this.notifyUpdated(provider)
        return Promise.resolve()
      })
    }
  }

  /** Remove both indexes for one live attempt. */
  private removeAttempt(attemptId: ModelAuthLoginAttemptId): void {
    const attempt = this.liveAttempt(attemptId)
    this.attempts.delete(attemptId)
    this.activeByProvider.delete(attempt.provider)
  }

  /** Resolve an attempt id owned by the active-provider index. */
  private liveAttempt(attemptId: ModelAuthLoginAttemptId): ActiveLogin {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) {
      throw new ModelAuthError(`model auth attempt "${attemptId}" is missing from the live index`, 'INVARIANT')
    }
    return attempt
  }

  /** Resolve authorization while holding the provider and durable writer locks. */
  private resolveAuthorization(
    provider: ModelAuthProviderId,
    forceRefresh: boolean,
    signal?: AbortSignal,
  ): Promise<ModelAuthorization> {
    return this.serial(provider, async () => {
      const driver = this.driver(provider)
      return this.withDocumentLock(async (document) => {
        const record = document.providers[provider]
        if (record === undefined) {
          throw new ModelAuthError(`model auth provider "${provider}" is not signed in`, 'NOT_AUTHENTICATED')
        }
        const resolved = await driver.resolve(record, {
          forceRefresh,
          ...signal === undefined ? {} : { signal },
        })
        if (resolved.record !== undefined) {
          driver.inspect(resolved.record)
          document.providers[provider] = structuredClone(resolved.record)
          await this.writeDocument(document)
          this.notifyUpdated(provider)
        }
        return {
          headers: { ...resolved.authorization.headers },
        }
      })
    })
  }

  /** Serialize every state-changing operation for one provider. */
  private async serial<T>(provider: ModelAuthProviderId, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new ModelAuthError('model-auth service is disposed', 'DISPOSED')
    const previous = this.tails.get(provider) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const tail = previous.then(() => gate)
    this.tails.set(provider, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(provider) === tail) this.tails.delete(provider)
    }
  }

  /** Keep teardown aware of a background login completion. */
  private track(task: Promise<void>): void {
    this.work.add(task)
    void task.then(
      () => { this.work.delete(task) },
      () => { this.work.delete(task) },
    )
  }

  /** Return a credential-free failure string. Drivers must sanitize provider bodies before throwing. */
  private safeError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) return error.message
    return 'model authentication failed'
  }

  /** Read one complete document; atomic writers make lock-free reads consistent. */
  private async readDocument(): Promise<AuthDocument> {
    await assertOwnerOnly(this.spec.filename)
    try {
      const text = await readFile(this.spec.filename, 'utf8')
      return parseAuthDocument(text, this.spec.filename)
    } catch (error) {
      if (isENOENT(error)) return EMPTY_DOCUMENT()
      throw error
    }
  }

  /** Run a read-change-write operation under the file's cross-process writer lock. */
  private async withDocumentLock<T>(operation: (document: AuthDocument) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
    return withFileLock(this.spec.filename, async () => operation(await this.readDocument()))
  }

  /** Atomically replace the private auth document. */
  private writeDocument(document: AuthDocument): Promise<void> {
    return writeFileAtomic(this.spec.filename, renderAuthDocument(document), {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

export default LocalModelAuth
