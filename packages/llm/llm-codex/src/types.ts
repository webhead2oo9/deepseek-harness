/** OpenAI Codex Responses request, stream, catalog, and OAuth wire fields. */

/** Input or output text content inside a Responses message item. */
export interface CodexTextContent {
  type: 'input_text' | 'output_text'
  text: string
}

/** One base64 data-URL image inside Responses input. */
export interface CodexImageContent {
  type: 'input_image'
  image_url: string
  detail: 'auto'
}

/** Content accepted in a user message or function-call result. */
export type CodexInputContent = CodexTextContent | CodexImageContent

/** One Responses API input item used by the Harness adapter. */
export type CodexInputItem =
  | { type: 'message'; role: 'developer' | 'user' | 'assistant'; content: CodexInputContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
  | { type: 'function_call_output'; call_id: string; output: string | CodexInputContent[] }
  | Record<string, unknown>

/** Function tool accepted by the Responses API. */
export interface CodexFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: boolean
}

/** Native Codex Responses request body. */
export interface CodexRequest {
  model: string
  instructions: string
  input: CodexInputItem[]
  tools?: CodexFunctionTool[]
  tool_choice: 'auto'
  parallel_tool_calls: boolean
  reasoning?: { effort: string; summary: 'auto' }
  store: false
  stream: true
  include: ['reasoning.encrypted_content']
  prompt_cache_key?: string
}

/** One decoded Responses stream event. */
export interface CodexStreamEvent {
  type: string
  delta?: string
  item?: unknown
  item_id?: string
  output_index?: number
  content_index?: number
  summary_index?: number
  response?: unknown
  error?: unknown
}

/** Minimal model catalog fields used by the adapter. */
export interface CodexCatalogModel {
  slug: string
  display_name: string
  description?: string
  default_reasoning_level?: string
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>
  context_window?: number
  supported_in_api?: boolean
  visibility?: string
}

/** `/models` response envelope. */
export interface CodexModelsResponse {
  models: CodexCatalogModel[]
}
