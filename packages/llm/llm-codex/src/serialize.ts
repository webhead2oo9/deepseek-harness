/** Translate Harness messages and tools into native Codex Responses requests. */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { CodexFunctionTool, CodexInputItem, CodexRequest } from './types.ts'

/** Replay-state version for lossless provider output items. */
export const CODEX_REPLAY_VERSION = 0

/** Provider output items retained on a successful finish. */
export interface CodexReplayState {
  version: typeof CODEX_REPLAY_VERSION
  items: Record<string, unknown>[]
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
    || value.version !== CODEX_REPLAY_VERSION
    || !Array.isArray(value.items)
    || value.items.some(item => !isObject(item))) {
    throw new LlmError('stored Codex replay state is invalid', 'INVALID_REPLAY_STATE')
  }
  return {
    version: CODEX_REPLAY_VERSION,
    items: structuredClone(value.items as Record<string, unknown>[]),
  }
}

/** Join text blocks while rejecting image input unsupported by this adapter. */
function flattenText(blocks: readonly ContentBlock[]): string {
  if (contentHasImage(blocks)) {
    throw new LlmError('The native Codex adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
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
 * @returns native items in the same conversation order.
 */
export function serializeCodexMessages(messages: readonly Message[]): CodexInputItem[] {
  const input: CodexInputItem[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (message.source.kind === 'model' && message.source.replayState !== undefined) {
        input.push(...parseCodexReplayState(message.source.replayState).items)
      } else {
        input.push(...assistantItems(message))
      }
      continue
    }

    const text = flattenText(message.content)
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || toolResults.length === 0) {
      input.push({
        type: 'message',
        role: message.role === 'system' ? 'developer' : 'user',
        content: [{ type: 'input_text', text }],
      })
    }
    for (const result of toolResults) {
      input.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: flattenText(result.content) || '(no output)',
      })
    }
  }
  return input
}

/**
 * Build a direct Codex Responses request and reject unsupported request controls.
 * @param options - fully assembled Harness model call.
 * @returns native streaming Responses request body.
 */
export function serializeCodexRequest(options: GenerateOptions): CodexRequest {
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
    input: serializeCodexMessages(options.messages),
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
