import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { parseCodexReplayState, serializeCodexMessages, serializeCodexRequest } from '../src/serialize.ts'

describe('native Codex request serialization', () => {
  it('uses native replay items and tool outputs without pi-ai', () => {
    const replay = { version: 0, items: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [] }] }
    const request = serializeCodexRequest({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      system: 'be concise',
      messages: [
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }),
        createAssistantMessage({ source: { provider: 'openai-codex', model: 'gpt-5-codex', replayState: replay }, content: [] }),
        createToolResultMessage({ callId: CallId('call_1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
      ],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
      reasoningEffort: 'high' as never,
    })
    expect(request.instructions).toBe('be concise')
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      replay.items[0],
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ])
    expect(request.tools?.[0]).toMatchObject({ type: 'function', name: 'read', strict: false })
    expect(request.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })

  it('rejects controls and content unsupported by the Codex backend', () => {
    const base = { provider: 'openai-codex', model: 'x', messages: [] }
    expect(() => serializeCodexRequest({ ...base, temperature: 1 })).toThrow(/temperature/)
    expect(() => serializeCodexRequest({ ...base, maxTokens: 1 })).toThrow(/maxTokens/)
    expect(() => serializeCodexRequest({ ...base, stop: ['x'] })).toThrow(/stop/)
    expect(() => serializeCodexRequest({
      ...base,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {} as never }] })],
    })).toThrow(/image/)
  })

  it('validates durable replay state', () => {
    const source = { version: 0, items: [{ type: 'message' }] }
    const parsed = parseCodexReplayState(source)
    expect(parsed).toEqual({
      version: 0, items: [{ type: 'message' }],
    })
    expect(parsed).not.toBe(source)
    expect(() => parseCodexReplayState(null)).toThrow(/replay/)
    expect(() => parseCodexReplayState({ version: 0, items: {} })).toThrow(/replay/)
    expect(() => parseCodexReplayState({ version: 0, items: [null] })).toThrow(/replay/)
    expect(() => parseCodexReplayState({ version: 1, items: [] })).toThrow(/replay/)
  })

  it('serializes assistant fallback text and tool calls', () => {
    const assistant = createAssistantMessage({
      source: { provider: 'openai-codex', model: 'gpt-5-codex' },
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: CallId('call_1'), name: 'read', arguments: '{"path":"x"}' },
      ],
    })
    expect(serializeCodexMessages([assistant])).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"x"}' },
    ])
    expect(serializeCodexMessages([createAssistantMessage({
      source: { provider: 'openai-codex', model: 'gpt-5-codex' }, content: [],
    })])).toEqual([])
    expect(() => serializeCodexMessages([createAssistantMessage({
      source: { provider: 'openai-codex', model: 'gpt-5-codex' },
      content: [{ type: 'reasoning', text: 'private' }],
    })])).toThrow(/reasoning can only be replayed/)
  })

  it('preserves system and empty tool-result message semantics', () => {
    const messages = [
      { id: 'system' as never, role: 'system' as const, source: { kind: 'user' as const }, content: [] } as Message,
      createToolResultMessage({ callId: CallId('call_1'), content: [], isError: false }),
      {
        id: 'mixed' as never,
        role: 'user' as const,
        source: { kind: 'user' as const },
        content: [
          { type: 'text' as const, text: 'context' },
          { type: 'tool-result' as const, toolCallId: CallId('call_2'), content: [{ type: 'text' as const, text: 'done' }], isError: true },
        ],
      } as Message,
    ]
    expect(serializeCodexMessages(messages)).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '' }] },
      { type: 'function_call_output', call_id: 'call_1', output: '(no output)' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'context' }] },
      { type: 'function_call_output', call_id: 'call_2', output: 'done' },
    ])
  })

  it('omits empty optional request fields and carries the session cache key', () => {
    const request = serializeCodexRequest({
      provider: 'openai-codex', model: 'gpt-5-codex', messages: [], tools: [], sessionId: 'session-1' as never,
    })
    expect(request).toMatchObject({ instructions: '', parallel_tool_calls: false, prompt_cache_key: 'session-1' })
    expect(request).not.toHaveProperty('tools')
    expect(request).not.toHaveProperty('reasoning')
  })
})
