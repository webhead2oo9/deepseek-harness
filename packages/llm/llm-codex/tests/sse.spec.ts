import { describe, expect, it, vi } from 'vitest'
import { parseCodexSse } from '../src/sse.ts'

function bytes(text: string): ReadableStream<BufferSource> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe('Codex SSE framing', () => {
  it('emits data through the terminal sentinel and reports comments', async () => {
    const comment = vi.fn()
    const payloads: string[] = []
    for await (const payload of parseCodexSse(bytes(': pulse\n\ndata: one\n\ndata: [DONE]\n\ndata: ignored\n\n'), comment)) payloads.push(payload)
    expect(payloads).toEqual(['one', '[DONE]'])
    expect(comment).toHaveBeenCalledWith('pulse')
  })

  it('allows transport end because the event translator validates protocol completion', async () => {
    const payloads: string[] = []
    for await (const payload of parseCodexSse(bytes('data: partial\n\n'))) payloads.push(payload)
    expect(payloads).toEqual(['partial'])
  })
})
