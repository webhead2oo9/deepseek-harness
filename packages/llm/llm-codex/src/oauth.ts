/** Browser PKCE, device-code, token exchange, and refresh for ChatGPT Codex OAuth. */

import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { ModelAuthError } from '@deepseek-ai/dsh-model-auth'
import type { ModelAuthLoginOperation } from '@deepseek-ai/dsh-model-auth'
import {
  createCodexAuthRecord,
  parseCodexAuthRecord,
  refreshedCodexAuthRecord,
} from './jwt.ts'
import type { CodexAuthRecord } from './jwt.ts'

/** Runtime parameters owned by the Codex OAuth driver. */
export interface CodexOAuthOptions {
  issuer: string
  clientId: string
  originator: string
  callbackPorts: readonly number[]
  loginTimeoutMs: number
  deviceTimeoutMs: number
  refreshWindowMs: number
  refreshIntervalMs: number
  allowedWorkspaceIds: readonly string[]
}

/** PKCE verifier and S256 challenge. */
export interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  idToken?: string
  accessToken?: string
  refreshToken?: string
}

/**
 * Generate an RFC 7636 verifier and S256 challenge.
 * @returns a fresh verifier and its SHA-256 challenge.
 */
export function generatePkce(): PkceCodes {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Whether a value is a non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read reviewed OAuth error fields without retaining an arbitrary response body. */
async function oauthFailure(response: Response, operation: string): Promise<ModelAuthError> {
  let code: string | undefined
  try {
    const body = await response.json() as unknown
    if (isObject(body)) {
      const error = body.error
      if (typeof error === 'string') code = error
      else if (isObject(error) && typeof error.code === 'string') code = error.code
      if (code === undefined && typeof body.code === 'string') code = body.code
    }
  } catch {
    // The HTTP status remains sufficient and arbitrary auth response text may contain secrets.
  }
  return new ModelAuthError(
    `${operation} failed (HTTP ${response.status}${code === undefined ? '' : `, ${code}`})`,
    code ?? `HTTP_${response.status}`,
  )
}

/** Parse a token response using only the fields the driver owns. */
async function tokenResponse(response: Response, operation: string): Promise<TokenResponse> {
  if (!response.ok) throw await oauthFailure(response, operation)
  let body: unknown
  try {
    body = await response.json() as unknown
  } catch (error) {
    throw new ModelAuthError(`${operation} returned invalid JSON`, 'INVALID_TOKEN_RESPONSE', { cause: error })
  }
  if (!isObject(body)) {
    throw new ModelAuthError(`${operation} returned an invalid token response`, 'INVALID_TOKEN_RESPONSE')
  }
  const idToken = typeof body.id_token === 'string' ? body.id_token : undefined
  const accessToken = typeof body.access_token === 'string' ? body.access_token : undefined
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : undefined
  return {
    ...idToken === undefined ? {} : { idToken },
    ...accessToken === undefined ? {} : { accessToken },
    ...refreshToken === undefined ? {} : { refreshToken },
  }
}

/** Parse one device-flow JSON body under a stable provider-response failure. */
async function deviceResponse(response: Response, operation: string): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch (error) {
    throw new ModelAuthError(`${operation} returned invalid JSON`, 'INVALID_DEVICE_RESPONSE', { cause: error })
  }
}

/**
 * Exchange an authorization code for the three durable ChatGPT tokens.
 * @param options - resolved OAuth endpoints and client identity.
 * @param code - single-use authorization code.
 * @param redirectUri - exact redirect registered for this attempt.
 * @param verifier - PKCE verifier paired with the authorization request.
 * @param signal - caller cancellation for token exchange I/O.
 * @returns a complete validated durable record.
 */
export async function exchangeAuthorizationCode(
  options: CodexOAuthOptions,
  code: string,
  redirectUri: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<CodexAuthRecord> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: options.clientId,
    code_verifier: verifier,
  })
  let response: Response
  try {
    response = await fetch(`${options.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (signal?.aborted) throw new ModelAuthError('Codex login was cancelled', 'LOGIN_CANCELLED', { cause: error })
    throw new ModelAuthError('Codex token exchange could not reach OpenAI', 'AUTH_TRANSPORT', { cause: error })
  }
  const tokens = await tokenResponse(response, 'Codex token exchange')
  if (tokens.idToken === undefined || tokens.accessToken === undefined || tokens.refreshToken === undefined) {
    throw new ModelAuthError('Codex token exchange returned incomplete credentials', 'INVALID_TOKEN_RESPONSE')
  }
  const record = createCodexAuthRecord({
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  })
  assertAllowedWorkspace(options, record)
  return record
}

/**
 * Refresh one record, preserving token fields OpenAI did not rotate.
 * @param options - resolved OAuth endpoints and refresh policy.
 * @param currentValue - opaque durable value from the model-auth store.
 * @param signal - caller cancellation for refresh I/O.
 * @returns a complete validated replacement record.
 */
export async function refreshCodexRecord(
  options: CodexOAuthOptions,
  currentValue: unknown,
  signal?: AbortSignal,
): Promise<CodexAuthRecord> {
  const current = parseCodexAuthRecord(currentValue)
  let response: Response
  try {
    response = await fetch(`${options.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: options.clientId,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      }),
      ...signal === undefined ? {} : { signal },
    })
  } catch (error) {
    if (signal?.aborted) throw new ModelAuthError('Codex credential refresh was cancelled', 'ABORTED', { cause: error })
    throw new ModelAuthError('Codex credential refresh could not reach OpenAI', 'AUTH_TRANSPORT', { cause: error })
  }
  if (!response.ok) {
    const failure = await oauthFailure(response, 'Codex credential refresh')
    if (response.status === 401
      || ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(failure.code)) {
      throw new ModelAuthError('Codex sign-in has expired; sign in again', 'AUTH_EXPIRED', { cause: failure })
    }
    throw failure
  }
  const tokens = await tokenResponse(response, 'Codex credential refresh')
  if (tokens.idToken === undefined && tokens.accessToken === undefined && tokens.refreshToken === undefined) {
    throw new ModelAuthError('Codex credential refresh returned no credentials', 'INVALID_TOKEN_RESPONSE')
  }
  const next = refreshedCodexAuthRecord(current, tokens)
  assertAllowedWorkspace(options, next)
  if (current.accountId !== undefined && next.accountId !== current.accountId) {
    throw new ModelAuthError('Codex credential refresh changed the selected account', 'ACCOUNT_CHANGED')
  }
  return next
}

/**
 * Whether a record has entered its proactive refresh window.
 * @param options - resolved refresh policy.
 * @param value - opaque durable record.
 * @param now - comparison instant in Unix milliseconds.
 * @returns whether the next authorization resolution must refresh.
 */
export function shouldRefreshCodexRecord(options: CodexOAuthOptions, value: unknown, now = Date.now()): boolean {
  const record = parseCodexAuthRecord(value)
  if (record.accessTokenExpiresAt !== undefined) {
    return new Date(record.accessTokenExpiresAt).getTime() <= now + options.refreshWindowMs
  }
  return new Date(record.refreshedAt).getTime() <= now - options.refreshIntervalMs
}

/**
 * Enforce an optional workspace allowlist against the token-selected account.
 * @param options - resolved workspace policy.
 * @param record - validated record selected for authorization.
 */
export function assertAllowedWorkspace(options: CodexOAuthOptions, record: CodexAuthRecord): void {
  if (options.allowedWorkspaceIds.length === 0) return
  if (record.accountId !== undefined && options.allowedWorkspaceIds.includes(record.accountId)) return
  throw new ModelAuthError('The selected ChatGPT workspace is not allowed by this Harness configuration', 'WORKSPACE_NOT_ALLOWED')
}

/**
 * Build the browser authorization URL from the exact callback port already bound.
 * @param options - resolved OAuth client and workspace policy.
 * @param redirectUri - exact loopback callback URI.
 * @param pkce - attempt-specific verifier challenge pair.
 * @param state - attempt-specific callback correlation value.
 * @returns complete OpenAI authorization URL.
 */
export function buildAuthorizationUrl(
  options: CodexOAuthOptions,
  redirectUri: string,
  pkce: PkceCodes,
  state: string,
): string {
  const url = new URL('/oauth/authorize', options.issuer)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: options.originator,
    ...options.allowedWorkspaceIds.length === 0
      ? {}
      : { allowed_workspace_id: options.allowedWorkspaceIds.join(',') },
  }).toString()
  return url.toString()
}

/** Listen on the first configured loopback callback port that is available. */
async function bindCallbackServer(
  ports: readonly number[],
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  let lastError: unknown
  for (const port of ports) {
    const server = createServer(handler)
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => { rejectListen(error) }
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError)
          resolveListen()
        })
      })
      return { server, port }
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EADDRINUSE') throw error
    }
  }
  throw new ModelAuthError('Codex login callback ports are already in use', 'CALLBACK_PORT_IN_USE', {
    cause: lastError,
  })
}

/** Close one callback server and settle only after its listener releases. */
async function closeServer(server: Server): Promise<void> {
  /* v8 ignore next -- callers pass only a server returned after its listen callback */
  if (!server.listening) return
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      /* v8 ignore next -- Node does not return a close error for this listening, callback-free server */
      if (error !== undefined) rejectClose(error)
      else resolveClose()
    })
  })
}

/** Write a short no-store browser result page. */
function browserResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(`<!doctype html><meta charset="utf-8"><title>DeepSeek Harness</title><p>${message}</p>`)
}

/**
 * Start a loopback PKCE login and return only after the callback listener is ready.
 * @param options - resolved OAuth endpoints, ports, and timeouts.
 * @param serviceSignal - owning model-auth service cancellation.
 * @returns live login challenge, completion, and quiescent cancellation.
 */
export async function startBrowserLogin(
  options: CodexOAuthOptions,
  serviceSignal: AbortSignal,
): Promise<ModelAuthLoginOperation> {
  const controller = new AbortController()
  const signal = AbortSignal.any([serviceSignal, controller.signal])
  const pkce = generatePkce()
  const state = randomBytes(32).toString('base64url')
  let resolveOutcome!: (record: CodexAuthRecord) => void
  let rejectOutcome!: (error: unknown) => void
  const outcome = new Promise<CodexAuthRecord>((resolvePromise, rejectPromise) => {
    resolveOutcome = resolvePromise
    rejectOutcome = rejectPromise
  })
  let terminal = false
  let processing = false
  let redirectUri = ''

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      /* v8 ignore start -- requires a request already accepted in the sub-microtask between terminal settlement and server close */
      if (terminal) {
        browserResponse(response, 410, 'This Codex login is no longer active.')
        return
      }
      /* v8 ignore stop */
      /* v8 ignore next -- node:http server requests always carry a request-target URL */
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method !== 'GET' || url.pathname !== '/auth/callback') {
        browserResponse(response, 404, 'Not found.')
        return
      }
      if (url.searchParams.get('state') !== state) {
        browserResponse(response, 400, 'The login state did not match. Return to Harness and try again.')
        return
      }
      if (processing) {
        browserResponse(response, 409, 'This login callback is already being processed.')
        return
      }
      processing = true
      const providerError = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (providerError !== null) {
        const error = new ModelAuthError(`Codex login was rejected (${providerError})`, 'LOGIN_REJECTED')
        terminal = true
        browserResponse(response, 400, 'Codex sign-in was not completed. Return to Harness for details.')
        rejectOutcome(error)
        return
      }
      if (code === null || code.length === 0) {
        const error = new ModelAuthError('Codex login callback omitted the authorization code', 'INVALID_CALLBACK')
        terminal = true
        browserResponse(response, 400, 'Codex sign-in returned an invalid callback.')
        rejectOutcome(error)
        return
      }
      try {
        const record = await exchangeAuthorizationCode(options, code, redirectUri, pkce.verifier, signal)
        terminal = true
        browserResponse(response, 200, 'Codex sign-in completed. You can close this window and return to DeepSeek Harness.')
        resolveOutcome(record)
      } catch (error) {
        terminal = true
        browserResponse(response, 500, 'Codex sign-in could not be completed. Return to Harness for details.')
        rejectOutcome(error)
      }
    /* v8 ignore start -- only a Node response-stream failure outside the guarded token exchange reaches this fallback */
    })().catch((error: unknown) => {
      terminal = true
      if (!response.headersSent) browserResponse(response, 500, 'Codex sign-in could not be completed.')
      rejectOutcome(error)
    })
    /* v8 ignore stop */
  }

  const { server, port } = await bindCallbackServer(options.callbackPorts, handler)
  redirectUri = `http://localhost:${port}/auth/callback`
  const authorizationUrl = buildAuthorizationUrl(options, redirectUri, pkce, state)
  const timeout = setTimeout(() => {
    terminal = true
    const error = new ModelAuthError('Codex browser login timed out', 'LOGIN_TIMEOUT')
    rejectOutcome(error)
    controller.abort(error)
  }, options.loginTimeoutMs)
  const onAbort = (): void => {
    terminal = true
    rejectOutcome(new ModelAuthError('Codex login was cancelled', 'LOGIN_CANCELLED'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const cleanup = async (): Promise<void> => {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
    await closeServer(server)
  }
  const completion = outcome.then(async (record) => {
    await cleanup()
    return record
  }, async (error: unknown) => {
    await cleanup()
    throw error
  })
  /* v8 ignore start -- post-listen callback-server errors are OS events that cannot be induced portably */
  server.on('error', (error) => {
    terminal = true
    rejectOutcome(new ModelAuthError('Codex login callback server failed', 'CALLBACK_SERVER', { cause: error }))
  })
  /* v8 ignore stop */
  return {
    challenge: { kind: 'browser', authorizationUrl },
    completion,
    cancel: async (reason?: string): Promise<void> => {
      controller.abort(reason ?? 'Codex login cancelled')
      await completion.catch(() => {})
    },
  }
}

/** Abort-aware delay used only between device-auth polls. */
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new ModelAuthError('Codex device login was cancelled', 'LOGIN_CANCELLED')
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveDelay()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timeout)
      rejectDelay(new ModelAuthError('Codex device login was cancelled', 'LOGIN_CANCELLED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes the single-thread race between the precheck and listener registration */
    if (signal.aborted) onAbort()
  })
}

/**
 * Start the device-code flow and poll in the operation's completion promise.
 * @param options - resolved OAuth endpoints and device timeout.
 * @param serviceSignal - owning model-auth service cancellation.
 * @returns live device challenge, completion, and quiescent cancellation.
 */
export async function startDeviceLogin(
  options: CodexOAuthOptions,
  serviceSignal: AbortSignal,
): Promise<ModelAuthLoginOperation> {
  const controller = new AbortController()
  const signal = AbortSignal.any([serviceSignal, controller.signal])
  const apiBase = `${options.issuer}/api/accounts`
  let response: Response
  try {
    response = await fetch(`${apiBase}/deviceauth/usercode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: options.clientId }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw new ModelAuthError('Codex device login was cancelled', 'LOGIN_CANCELLED', { cause: error })
    throw new ModelAuthError('Codex device login could not reach OpenAI', 'AUTH_TRANSPORT', { cause: error })
  }
  if (!response.ok) throw await oauthFailure(response, 'Codex device login')
  const body = await deviceResponse(response, 'Codex device login')
  if (!isObject(body)
    || typeof body.device_auth_id !== 'string'
    || typeof (body.user_code ?? body.usercode) !== 'string') {
    throw new ModelAuthError('Codex device login returned an invalid challenge', 'INVALID_DEVICE_RESPONSE')
  }
  const deviceAuthId = body.device_auth_id
  const userCode = (body.user_code ?? body.usercode) as string
  const intervalSeconds = typeof body.interval === 'string'
    ? Number(body.interval)
    : typeof body.interval === 'number'
      ? body.interval
      : 5
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new ModelAuthError('Codex device login returned an invalid polling interval', 'INVALID_DEVICE_RESPONSE')
  }
  const expiresAtMs = Date.now() + options.deviceTimeoutMs
  const completion = (async (): Promise<CodexAuthRecord> => {
    while (Date.now() < expiresAtMs) {
      let poll: Response
      try {
        poll = await fetch(`${apiBase}/deviceauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw new ModelAuthError('Codex device login was cancelled', 'LOGIN_CANCELLED', { cause: error })
        throw new ModelAuthError('Codex device login polling could not reach OpenAI', 'AUTH_TRANSPORT', { cause: error })
      }
      if (poll.ok) {
        const codeBody = await deviceResponse(poll, 'Codex device login')
        if (!isObject(codeBody)
          || typeof codeBody.authorization_code !== 'string'
          || typeof codeBody.code_verifier !== 'string') {
          throw new ModelAuthError('Codex device login returned an invalid authorization code', 'INVALID_DEVICE_RESPONSE')
        }
        return exchangeAuthorizationCode(
          options,
          codeBody.authorization_code,
          `${options.issuer}/deviceauth/callback`,
          codeBody.code_verifier,
          signal,
        )
      }
      if (poll.status !== 403 && poll.status !== 404) throw await oauthFailure(poll, 'Codex device login polling')
      await delay(Math.min(intervalSeconds * 1_000, expiresAtMs - Date.now()), signal)
    }
    throw new ModelAuthError('Codex device login timed out', 'LOGIN_TIMEOUT')
  })()
  return {
    challenge: {
      kind: 'device',
      verificationUrl: `${options.issuer}/codex/device`,
      userCode,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    completion,
    cancel: async (reason?: string): Promise<void> => {
      controller.abort(reason ?? 'Codex device login cancelled')
      await completion.catch(() => {})
    },
  }
}
