import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { translateCodex, codexUsage } from '../src/translate.ts'

async function collect(payloads: string[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of translateCodex((async function* () { yield* payloads })())) chunks.push(chunk)
  return chunks
}

describe('native Codex event translation', () => {
  it('preserves reasoning, text, usage, and replay items', async () => {
    const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }
    const chunks = await collect([
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'plan' }),
      JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'hello' }),
      JSON.stringify({ type: 'response.output_item.done', item: message }),
      JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 5 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'plan' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'plan' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 7, cacheReadTokens: 5, reasoningTokens: 3 } },
      {
        type: 'finish', reason: { kind: 'stop' },
        replayState: { response: { kind: 'codex', version: 0, items: [message] } },
      },
    ])
  })

  it('assembles function calls and prefers the final arguments when no deltas arrive', async () => {
    const item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"x"}' }
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.added', item }),
      JSON.stringify({ type: 'response.output_item.done', item }),
      JSON.stringify({ type: 'response.completed', response: {} }),
      '[DONE]',
    ])
    expect(chunks).toContainEqual({
      type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"path":"x"}',
    })
    expect(chunks).toContainEqual({
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"x"}' },
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps incomplete token limits and provider failures', async () => {
    expect((await collect([
      JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }),
      '[DONE]',
    ])).at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect((await collect([
      JSON.stringify({ type: 'response.failed', response: { error: { message: 'down', code: 'backend' } } }),
      '[DONE]',
    ])).at(-1)).toEqual({
      type: 'finish', reason: { kind: 'error', failure: { message: 'down', code: 'backend' } },
    })
  })

  it('rejects malformed, truncated, and successful empty responses', async () => {
    await expect(collect(['not json'])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect([JSON.stringify({ type: 'response.created' }), '[DONE]']))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
    expect((await collect([JSON.stringify({ type: 'response.completed', response: {} }), '[DONE]'])).at(-1))
      .toMatchObject({ reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
  })

  it('ignores invalid usage objects', () => {
    expect(codexUsage(null)).toBeUndefined()
    expect(codexUsage({})).toBeUndefined()
    expect(codexUsage({ usage: { input_tokens: '1', output_tokens: 2 } })).toBeUndefined()
    expect(codexUsage({ usage: { input_tokens: 1, output_tokens: Number.POSITIVE_INFINITY } })).toBeUndefined()
    expect(codexUsage({ usage: {
      input_tokens: 2,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 'unknown' },
    } })).toEqual({ inputTokens: 0, outputTokens: 1, cacheReadTokens: 5 })
    expect(codexUsage({ usage: {
      input_tokens: 2, output_tokens: 1, input_tokens_details: 'none', output_tokens_details: 'none',
    } })).toEqual({ inputTokens: 2, outputTokens: 1 })
  })

  it('handles id-less deltas, argument deltas, and unknown events', async () => {
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.added', item: null }),
      JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } }),
      JSON.stringify({ type: 'response.output_text.delta', delta: '' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'one' }),
      JSON.stringify({ type: 'response.output_text.delta', delta: ' two' }),
      JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'think' }),
      JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: ' more' }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', delta: '{' }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', delta: '}' }),
      JSON.stringify({ type: 'response.created' }),
      JSON.stringify({ type: 'response.completed', response: {} }),
      '[DONE]',
    ])
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: ' two' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 1, text: ' more' })
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 3, id: '', argumentsDelta: '}' })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('uses final message and reasoning items when no deltas arrived', async () => {
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.done', item: null }),
      JSON.stringify({
        type: 'response.output_item.done',
        item_id: 'message-fallback',
        item: {
          type: 'message',
          content: [null, { type: 'refusal', text: 'ignored' }, { type: 'output_text', text: 'final text' }],
        },
      }),
      JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'reasoning', summary: [null, { text: 1 }, { text: 'final reason' }] },
      }),
      JSON.stringify({ type: 'response.completed', response: {} }),
      '[DONE]',
    ])
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'final text' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 1, text: 'final reason' })
  })

  it('does not replace streamed content with duplicate final item text', async () => {
    const item = { type: 'function_call', id: 'fc', call_id: 'call', name: 'tool', arguments: 'final' }
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.added', item }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc', delta: 'streamed' }),
      JSON.stringify({ type: 'response.output_item.done', item }),
      JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg', delta: 'streamed text' }),
      JSON.stringify({ type: 'response.output_item.done', item: { type: 'message', id: 'msg', content: [{ type: 'output_text', text: 'final text' }] } }),
      JSON.stringify({ type: 'response.reasoning_text.delta', item_id: 'reason', delta: 'streamed reason' }),
      JSON.stringify({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'reason', summary: [{ text: 'final reason' }] } }),
      JSON.stringify({ type: 'response.completed', response: {} }),
      '[DONE]',
    ])
    expect(chunks.filter(chunk => chunk.type === 'tool-call-delta')).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'text-delta')).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toHaveLength(1)
  })

  it('tolerates optional fields across added, delta, and done events', async () => {
    const added = { type: 'response.output_item.added', item_id: 'fallback-id', item: { type: 'function_call', call_id: 'call' } }
    const chunks = await collect([
      JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call' } }),
      JSON.stringify(added),
      JSON.stringify(added),
      JSON.stringify({ type: 'response.reasoning_text.delta' }),
      JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fallback-id' }),
      JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', arguments: 'final' } }),
      JSON.stringify({ type: 'response.output_text.delta', delta: 'existing text' }),
      JSON.stringify({ type: 'response.output_item.done', item: { type: 'message', content: null } }),
      JSON.stringify({ type: 'response.reasoning_text.delta', delta: 'existing reason' }),
      JSON.stringify({ type: 'response.output_item.done', item: { type: 'reasoning', summary: null } }),
      JSON.stringify({ type: 'response.output_item.done', item: { type: 'unknown' } }),
      JSON.stringify({ type: 'response.completed', response: {} }),
      '[DONE]',
    ])
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 2, id: '', argumentsDelta: 'final' })
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: 'tool-calls' } })
  })

  it('maps incomplete and stream-error fallback fields', async () => {
    expect((await collect([
      JSON.stringify({ type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 1, output_tokens: 0 } } }),
      '[DONE]',
    ])).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'CONTENT_FILTER' } } })
    expect((await collect([
      JSON.stringify({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'context_length_exceeded' } },
      }),
      '[DONE]',
    ])).at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
    })
    expect((await collect([
      JSON.stringify({ type: 'error', error: { message: 'socket failed' } }),
      '[DONE]',
    ])).at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: 'socket failed', code: 'CODEX_RESPONSE_FAILED' } } })
    expect((await collect([
      JSON.stringify({ type: 'error', code: 'wire' }),
      '[DONE]',
    ])).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { message: 'Codex stream failed', code: 'wire' } } })
    expect((await collect([
      JSON.stringify({ type: 'error', error: { type: 'context_window_exceeded' } }),
      '[DONE]',
    ])).at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
    })
    expect((await collect([
      JSON.stringify({
        type: 'response.failed',
        response: { error: { message: 'input exceeds model context window', code: 'context_length_exceeded' } },
      }),
      '[DONE]',
    ])).at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } },
    })
  })

  it('rejects typed malformed events and streams without a terminal response event', async () => {
    await expect(collect([JSON.stringify([])])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect([JSON.stringify({ value: 1 })])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    await expect(collect([JSON.stringify({ type: 'response.created' })]))
      .rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})
