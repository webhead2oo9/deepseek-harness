import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { parseCodexReplayState, serializeCodexMessages, serializeCodexRequest } from '../src/serialize.ts'

describe('native Codex request serialization', () => {
  it('uses native replay items and tool outputs without pi-ai', async () => {
    const replay = {
      response: {
        kind: 'codex', version: 0,
        items: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [] }],
      },
    }
    const request = await serializeCodexRequest({
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
      replay.response.items[0],
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ])
    expect(request.tools?.[0]).toMatchObject({ type: 'function', name: 'read', strict: false })
    expect(request.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })

  it('rejects unsupported controls and unresolved image content', async () => {
    const base = { provider: 'openai-codex', model: 'x', messages: [] }
    await expect(serializeCodexRequest({ ...base, temperature: 1 })).rejects.toThrow(/temperature/)
    await expect(serializeCodexRequest({ ...base, maxTokens: 1 })).rejects.toThrow(/maxTokens/)
    await expect(serializeCodexRequest({ ...base, stop: ['x'] })).rejects.toThrow(/stop/)
    await expect(serializeCodexRequest({
      ...base,
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {} as never }] })],
    })).rejects.toThrow(/attachment service/)
  })

  it('serializes durable images in user messages and tool outputs', async () => {
    const attachment: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    }
    const readImage = async () => ({ ref: attachment, data: Uint8Array.of(1, 2, 3) })
    const attachments = { readImage } as unknown as AttachmentStore
    const request = await serializeCodexRequest({
      provider: 'openai-codex', model: 'gpt-5.6-sol',
      messages: [
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'inspect' }, { type: 'image', attachment }],
        }),
        createToolResultMessage({
          callId: CallId('call_1'), isError: false,
          content: [{ type: 'image', attachment }],
        }),
      ],
    }, attachments)
    const image = { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' }
    expect(request.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect' }, image] },
      { type: 'function_call_output', call_id: 'call_1', output: [image] },
    ])
  })

  it('rejects assistant images and ignores provider-output blocks in user input', async () => {
    await expect(serializeCodexMessages([createAssistantMessage({
      source: { provider: 'openai-codex', model: 'gpt-5.6-sol' },
      content: [{ type: 'image', attachment: {} as never }],
    })])).rejects.toThrow(/assistant output/)
    expect(await serializeCodexMessages([createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'reasoning', text: 'not user input' }],
    })])).toEqual([{
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }],
    }])
    expect(await serializeCodexMessages([createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: '' }],
    })])).toEqual([{
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }],
    }])
  })

  it('flattens nested tool-result content into its owning function output', async () => {
    const message = createToolResultMessage({
      callId: CallId('outer'), isError: false,
      content: [{
        type: 'tool-result', toolCallId: CallId('inner'), isError: false,
        content: [{ type: 'text', text: 'nested' }],
      }],
    })
    expect(await serializeCodexMessages([message])).toEqual([{
      type: 'function_call_output', call_id: 'outer', output: 'nested',
    }])
  })

  it('validates durable replay state', () => {
    const source = { response: { kind: 'codex', version: 0, items: [{ type: 'message' }] } }
    const parsed = parseCodexReplayState(source)
    expect(parsed).toEqual({
      response: { kind: 'codex', version: 0, items: [{ type: 'message' }] },
    })
    expect(parsed).not.toBe(source)
    expect(() => parseCodexReplayState(null)).toThrow(/replay/)
    expect(() => parseCodexReplayState({ response: { kind: 'codex', version: 0, items: {} } })).toThrow(/replay/)
    expect(() => parseCodexReplayState({ response: { kind: 'codex', version: 0, items: [null] } })).toThrow(/replay/)
    expect(() => parseCodexReplayState({ response: { kind: 'codex', version: 1, items: [] } })).toThrow(/replay/)
    expect(() => parseCodexReplayState({
      response: { kind: 'codex', version: 0, items: [] }, blocks: [],
    })).toThrow(/replay/)
  })

  it('serializes assistant fallback text and tool calls', async () => {
    const assistant = createAssistantMessage({
      source: { provider: 'openai-codex', model: 'gpt-5-codex' },
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: CallId('call_1'), name: 'read', arguments: '{"path":"x"}' },
      ],
    })
    expect(await serializeCodexMessages([assistant])).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"x"}' },
    ])
    expect(await serializeCodexMessages([createAssistantMessage({
      source: { provider: 'openai-codex', model: 'gpt-5-codex' }, content: [],
    })])).toEqual([])
    await expect(serializeCodexMessages([createAssistantMessage({
      source: { provider: 'openai-codex', model: 'gpt-5-codex' },
      content: [{ type: 'reasoning', text: 'private' }],
    })])).rejects.toThrow(/reasoning can only be replayed/)
  })

  it('preserves system and empty tool-result message semantics', async () => {
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
    expect(await serializeCodexMessages(messages)).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '' }] },
      { type: 'function_call_output', call_id: 'call_1', output: '(no output)' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'context' }] },
      { type: 'function_call_output', call_id: 'call_2', output: 'done' },
    ])
  })

  it('omits empty optional request fields and carries the session cache key', async () => {
    const request = await serializeCodexRequest({
      provider: 'openai-codex', model: 'gpt-5-codex', messages: [], tools: [], sessionId: 'session-1' as never,
    })
    expect(request).toMatchObject({ instructions: '', parallel_tool_calls: false, prompt_cache_key: 'session-1' })
    expect(request).not.toHaveProperty('tools')
    expect(request).not.toHaveProperty('reasoning')
  })
})
