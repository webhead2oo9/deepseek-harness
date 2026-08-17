/** Translate Harness messages and tools into native Codex Responses requests. */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ReplayEnvelope } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  CodexFunctionTool,
  CodexInputContent,
  CodexInputItem,
  CodexRequest,
  CodexTextContent,
} from './types.ts'

/** Replay-state version for lossless provider output items. */
export const CODEX_REPLAY_VERSION = 0

/** Response-level Codex metadata retained on a successful finish. */
export interface CodexReplayResponse {
  kind: 'codex'
  version: typeof CODEX_REPLAY_VERSION
  items: Record<string, unknown>[]
}

/** Provider output items wrapped in the Harness replay envelope. */
export interface CodexReplayState extends ReplayEnvelope {
  response: CodexReplayResponse
}

/** Whether a value is a non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate adapter-private replay state before returning it to the provider.
 * @param value - replay state carried by a prior assistant message.
 * @returns detached native output items.
 */
export function parseCodexReplayState(value: unknown): CodexReplayState {
  if (!isObject(value)
    || value.blocks !== undefined
    || !isObject(value.response)
    || value.response.kind !== 'codex'
    || value.response.version !== CODEX_REPLAY_VERSION
    || !Array.isArray(value.response.items)
    || value.response.items.some(item => !isObject(item))) {
    throw new LlmError('stored Codex replay state is invalid', 'INVALID_REPLAY_STATE')
  }
  return {
    response: {
      kind: 'codex',
      version: CODEX_REPLAY_VERSION,
      items: structuredClone(value.response.items as Record<string, unknown>[]),
    },
  }
}

/** Join text blocks while rejecting images in provider-output-only positions. */
function flattenText(blocks: readonly ContentBlock[]): string {
  if (contentHasImage(blocks)) {
    throw new LlmError('Codex cannot replay an image from assistant output.', 'UNSUPPORTED_CONTENT')
  }
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function inputContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<CodexInputContent[]> {
  const content: CodexInputContent[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'input_text', text: block.text })
        break
      case 'image': {
        if (attachments === undefined) {
          throw new LlmError('Codex image input requires the durable attachment service.', 'UNSUPPORTED_CONTENT')
        }
        const stored = await attachments.readImage(block.attachment, signal)
        content.push({
          type: 'input_image',
          image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
          detail: 'auto',
        })
        break
      }
      case 'tool-result':
        content.push(...await inputContent(block.content, attachments, signal))
        break
      default:
        // Other merge-extensible blocks are not Responses user-input content.
        break
    }
  }
  return content
}

function outputOf(content: CodexInputContent[]): string | CodexInputContent[] {
  if (content.some(block => block.type === 'input_image')) return content
  return (content as CodexTextContent[]).map(block => block.text).join('') || '(no output)'
}

/** Serialize one assistant message without provider replay state. */
function assistantItems(message: Message): CodexInputItem[] {
  const items: CodexInputItem[] = []
  const text = flattenText(message.content)
  if (text.length > 0) {
    items.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    })
  }
  for (const block of message.content) {
    if (block.type !== 'tool-call') continue
    items.push({
      type: 'function_call',
      call_id: block.id,
      name: block.name,
      arguments: block.arguments,
    })
  }
  if (items.length === 0 && message.content.some(block => block.type === 'reasoning')) {
    throw new LlmError(
      'Codex reasoning can only be replayed from provider-native response state',
      'INVALID_REPLAY_STATE',
    )
  }
  return items
}

/**
 * Serialize ordered Harness conversation messages into Responses input items.
 * @param messages - immutable provider-neutral conversation history.
 * @param attachments - optional durable image reader for image content.
 * @param signal - optional cancellation for attachment reads.
 * @returns native items in the same conversation order.
 */
export async function serializeCodexMessages(
  messages: readonly Message[],
  attachments?: AttachmentStore,
  signal?: AbortSignal,
): Promise<CodexInputItem[]> {
  const input: CodexInputItem[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.source.kind === 'model' && message.source.replayState !== undefined) {
        input.push(...parseCodexReplayState(message.source.replayState).response.items)
      } else {
        input.push(...assistantItems(message))
      }
      continue
    }

    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = await inputContent(regular, attachments, signal)
    if (content.length > 0 || toolResults.length === 0) {
      input.push({
        type: 'message',
        role: message.role === 'system' ? 'developer' : 'user',
        content: content.length === 0 ? [{ type: 'input_text', text: '' }] : content,
      })
    }
    for (const result of toolResults) {
      input.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: outputOf(await inputContent(result.content, attachments, signal)),
      })
    }
  }
  return input
}

/**
 * Build a direct Codex Responses request and reject unsupported request controls.
 * @param options - fully assembled Harness model call.
 * @param attachments - optional durable image reader for image content.
 * @param signal - optional cancellation for attachment reads.
 * @returns native streaming Responses request body.
 */
export async function serializeCodexRequest(
  options: GenerateOptions,
  attachments?: AttachmentStore,
  signal?: AbortSignal,
): Promise<CodexRequest> {
  if (options.temperature !== undefined) {
    throw new LlmError('The native Codex route does not support temperature.', 'UNSUPPORTED')
  }
  if (options.maxTokens !== undefined) {
    throw new LlmError('The native Codex route does not support maxTokens.', 'UNSUPPORTED')
  }
  if (options.stop !== undefined) {
    throw new LlmError('The native Codex route does not support stop sequences.', 'UNSUPPORTED')
  }
  const tools: CodexFunctionTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }))
  return {
    model: options.model,
    instructions: options.system ?? '',
    input: await serializeCodexMessages(options.messages, attachments, signal),
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    tool_choice: 'auto',
    parallel_tool_calls: tools !== undefined && tools.length > 0,
    ...options.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: String(options.reasoningEffort), summary: 'auto' as const } },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...options.sessionId === undefined ? {} : { prompt_cache_key: String(options.sessionId) },
  }
}
