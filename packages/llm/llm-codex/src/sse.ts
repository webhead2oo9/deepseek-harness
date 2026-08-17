/** Decode native Codex Responses SSE frames. */

import { EventSourceParserStream } from 'eventsource-parser/stream'

/** Optional SSE sentinel that may follow a terminal Responses event. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads.
 * @param stream - raw response bytes.
 * @param onComment - optional callback for comment-frame transport activity.
 * @returns data payloads in arrival order through the sentinel or transport end.
 */
export async function* parseCodexSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
}
