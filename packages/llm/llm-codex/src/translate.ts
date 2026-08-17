/** Translate native Codex Responses events into Harness stream chunks. */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { CODEX_REPLAY_VERSION } from './serialize.ts'
import { DONE } from './sse.ts'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  itemId?: string
  callId?: string
  name?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTextPart(value: unknown): value is { text: string } {
  return isObject(value) && typeof value.text === 'string'
}

function isOutputTextPart(value: unknown): value is { type: 'output_text'; text: string } {
  return isObject(value) && value.type === 'output_text' && typeof value.text === 'string'
}

function stringField(value: unknown, field: string): string | undefined {
  return isObject(value) && typeof value[field] === 'string' ? value[field] : undefined
}

function numericField(value: unknown, field: string): number | undefined {
  return isObject(value) && typeof value[field] === 'number' && Number.isFinite(value[field])
    ? value[field]
    : undefined
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Convert a completed Responses usage object into disjoint Harness counts.
 * @param response - completed response object carrying provider usage.
 * @returns usage when the provider supplied valid token counts.
 */
export function codexUsage(response: unknown): TokenUsage | undefined {
  if (!isObject(response) || !isObject(response.usage)) return undefined
  const usage = response.usage
  const totalInput = numericField(usage, 'input_tokens')
  const output = numericField(usage, 'output_tokens')
  if (totalInput === undefined || output === undefined) return undefined
  const details = isObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const cacheRead = details === undefined ? undefined : numericField(details, 'cached_tokens')
  const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined
  const reasoning = outputDetails === undefined ? undefined : numericField(outputDetails, 'reasoning_tokens')
  return {
    inputTokens: Math.max(0, totalInput - (cacheRead ?? 0)),
    outputTokens: output,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

function responseFailure(response: unknown, fallback: string): FinishReason {
  const error = isObject(response) && isObject(response.error) ? response.error : undefined
  const incomplete = isObject(response) && isObject(response.incomplete_details)
    ? response.incomplete_details
    : undefined
  const reason = stringField(incomplete, 'reason')
  if (reason === 'max_output_tokens') return { kind: 'max-tokens' }
  return {
    kind: 'error',
    failure: {
      message: stringField(error, 'message') ?? fallback,
      code: stringField(error, 'code') ?? (reason?.toUpperCase() ?? 'CODEX_RESPONSE_FAILED'),
    },
  }
}

/**
 * Consume a native Responses event stream through its terminal response event.
 * @param payloads - SSE data payloads in provider order.
 * @returns ordered block deltas followed by block ends, usage, and finish.
 */
export async function* translateCodex(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let finish: FinishReason | undefined
  let usage: TokenUsage | undefined
  const order: OpenBlock[] = []
  const byItem = new Map<string, OpenBlock>()
  const replayItems: Record<string, unknown>[] = []

  function open(kind: OpenBlock['kind'], itemId?: string): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '', ...itemId === undefined ? {} : { itemId } }
    order.push(block)
    if (itemId !== undefined) byItem.set(itemId, block)
    return block
  }

  function findOrOpen(kind: OpenBlock['kind'], itemId?: string): OpenBlock {
    const existing = itemId === undefined ? undefined : byItem.get(itemId)
    return existing ?? open(kind, itemId)
  }

  function terminalChunks(reason: FinishReason): StreamChunk[] {
    const chunks: StreamChunk[] = order.map(block => ({
      type: 'block-end', index: block.index, block: closeBlock(block),
    }))
    if (usage !== undefined) chunks.push({ type: 'usage', usage })
    chunks.push({
      type: 'finish',
      reason: reason.kind === 'stop' && order.length === 0
        ? {
          kind: 'error',
          failure: { message: 'Codex returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
        }
        : reason,
      ...reason.kind === 'stop' || reason.kind === 'tool-calls'
        ? { replayState: { response: { kind: 'codex', version: CODEX_REPLAY_VERSION, items: replayItems } } }
        : {},
    })
    return chunks
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      throw new LlmError('Codex stream ended before a terminal response event', 'STREAM_CLOSED')
    }

    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(payload) as unknown
      if (!isObject(parsed) || typeof parsed.type !== 'string') throw new Error('event object has no type')
      event = parsed
    } catch (error) {
      throw new LlmError(`malformed Codex SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE', { cause: error })
    }

    const itemId = stringField(event, 'item_id')
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item
        if (!isObject(item) || item.type !== 'function_call') break
        const id = stringField(item, 'id') ?? itemId
        const block = findOrOpen('tool-call', id)
        const callId = stringField(item, 'call_id')
        const toolName = stringField(item, 'name')
        if (callId !== undefined) block.callId = callId
        if (toolName !== undefined) block.name = toolName
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        break
      }
      case 'response.output_text.delta': {
        const delta = stringField(event, 'delta')
        if (delta === undefined || delta.length === 0) break
        let block = itemId === undefined ? order.find(entry => entry.kind === 'text') : byItem.get(itemId)
        if (block === undefined) {
          block = open('text', itemId)
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += delta
        yield { type: 'text-delta', index: block.index, text: delta }
        break
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const delta = stringField(event, 'delta')
        if (delta === undefined || delta.length === 0) break
        let block = itemId === undefined ? order.find(entry => entry.kind === 'reasoning') : byItem.get(itemId)
        if (block === undefined) {
          block = open('reasoning', itemId)
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        block.text += delta
        yield { type: 'reasoning-delta', index: block.index, text: delta }
        break
      }
      case 'response.function_call_arguments.delta': {
        const delta = stringField(event, 'delta') ?? ''
        let block = itemId === undefined ? undefined : byItem.get(itemId)
        if (block === undefined) {
          block = open('tool-call', itemId)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.text += delta
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: delta,
        }
        break
      }
      case 'response.output_item.done': {
        const item = event.item
        if (!isObject(item)) break
        replayItems.push(structuredClone(item))
        const id = stringField(item, 'id') ?? itemId
        if (item.type === 'function_call') {
          let block = id === undefined ? undefined : byItem.get(id)
          if (block === undefined) {
            block = open('tool-call', id)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          const callId = stringField(item, 'call_id')
          const toolName = stringField(item, 'name')
          if (callId !== undefined) block.callId = callId
          if (toolName !== undefined) block.name = toolName
          const finalArguments = stringField(item, 'arguments')
          if (finalArguments !== undefined && block.text.length === 0 && finalArguments.length > 0) {
            block.text = finalArguments
            yield {
              type: 'tool-call-delta', index: block.index, id: CallId(block.callId ?? ''),
              ...block.name === undefined ? {} : { name: block.name }, argumentsDelta: finalArguments,
            }
          }
        } else if (item.type === 'message') {
          const content = Array.isArray(item.content) ? item.content : []
          const finalText = content
            .filter(isOutputTextPart)
            .map(part => part.text)
            .join('')
          let block = id === undefined ? order.find(entry => entry.kind === 'text') : byItem.get(id)
          if (finalText.length > 0 && block === undefined) {
            block = open('text', id)
            block.text = finalText
            yield { type: 'block-start', index: block.index, blockType: 'text' }
            yield { type: 'text-delta', index: block.index, text: finalText }
          }
        } else if (item.type === 'reasoning') {
          const summary = Array.isArray(item.summary) ? item.summary : []
          const finalText = summary
            .filter(isTextPart)
            .map(part => part.text)
            .join('')
          let block = id === undefined ? order.find(entry => entry.kind === 'reasoning') : byItem.get(id)
          if (finalText.length > 0 && block === undefined) {
            block = open('reasoning', id)
            block.text = finalText
            yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            yield { type: 'reasoning-delta', index: block.index, text: finalText }
          }
        }
        break
      }
      case 'response.completed':
        finish = order.some(block => block.kind === 'tool-call') ? { kind: 'tool-calls' } : { kind: 'stop' }
        usage = codexUsage(event.response)
        break
      case 'response.incomplete':
        finish = responseFailure(event.response, 'Codex returned an incomplete response')
        usage = codexUsage(event.response)
        break
      case 'response.failed':
        finish = responseFailure(event.response, 'Codex response failed')
        usage = codexUsage(event.response)
        break
      case 'error':
        finish = responseFailure({ error: event.error ?? event }, 'Codex stream failed')
        break
      default:
        break
    }
    if (finish !== undefined) {
      for (const chunk of terminalChunks(finish)) yield chunk
      return
    }
  }
  throw new LlmError('Codex SSE payload stream ended before a terminal response event', 'STREAM_CLOSED')
}
