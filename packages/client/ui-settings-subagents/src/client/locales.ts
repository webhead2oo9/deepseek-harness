/** Localized copy for the Subagents settings section. */
export type SubagentsKey =
  | 'nav' | 'title' | 'intro' | 'loading' | 'error' | 'retry' | 'readOnly'
  | 'directLabel' | 'directHint' | 'profiles' | 'empty' | 'add' | 'edit' | 'delete'
  | 'name' | 'description' | 'provider' | 'model' | 'save' | 'cancel' | 'close'
  | 'addTitle' | 'editTitle' | 'deleteTitle' | 'deleteDescription' | 'required' | 'duplicate' | 'deploymentDefault'
  | 'instruction' | 'instructionHint' | 'instructionConfigured'
  | 'reasoningEffort' | 'reasoningEffortHint' | 'reasoningEffortDefault' | 'customizedDefault' | 'reset'

/** English copy. */
export const en: Record<SubagentsKey, string> = {
  nav: 'Subagents', title: 'Subagents',
  intro: 'Create reusable model and instruction profiles for delegated work. Model suggestions come from connected adapters; manual values are always accepted.',
  loading: 'Loading subagent settings…', error: 'Could not load subagent settings.', retry: 'Retry',
  readOnly: 'This settings provider is read-only.', directLabel: 'Allow direct model selection',
  directHint: 'Let callers choose an arbitrary provider and model instead of a named profile.',
  profiles: 'Profiles', empty: 'No profiles yet.', add: 'Add profile', edit: 'Edit', delete: 'Delete',
  name: 'Name', description: 'Description', provider: 'Provider', model: 'Model', save: 'Save',
  cancel: 'Cancel', close: 'Close', addTitle: 'Add subagent profile', editTitle: 'Edit subagent profile',
  deleteTitle: 'Delete this profile?', deleteDescription: 'The profile is removed from subagent model selection.',
  required: 'Complete every field.', duplicate: 'A profile with this name already exists.',
  deploymentDefault: 'Deployment default', instruction: 'Child system instruction (optional)',
  instructionHint: 'Applied as a child-only system instruction every time this profile is used.',
  instructionConfigured: 'Instruction:', reasoningEffort: 'Reasoning effort (optional)',
  reasoningEffortHint: 'Leave blank to use the provider default. Suggested IDs come from the selected model; the exact child route validates the saved value when used.',
  reasoningEffortDefault: 'Catalog default:', customizedDefault: 'Customized default', reset: 'Reset',
}

/** Simplified Chinese copy. */
export const zh: Record<SubagentsKey, string> = {
  nav: '子代理', title: '子代理',
  intro: '为委派任务创建可复用的模型与指令配置。模型建议来自已连接的适配器，也始终可以手动填写任意值。',
  loading: '正在加载子代理设置…', error: '无法加载子代理设置。', retry: '重试',
  readOnly: '当前设置提供方为只读。', directLabel: '允许直接选择模型',
  directHint: '允许调用方不使用具名配置，直接选择任意提供商与模型。',
  profiles: '配置', empty: '暂无配置。', add: '添加配置', edit: '编辑', delete: '删除',
  name: '名称', description: '描述', provider: '提供商', model: '模型', save: '保存',
  cancel: '取消', close: '关闭', addTitle: '添加子代理配置', editTitle: '编辑子代理配置',
  deleteTitle: '删除此配置？', deleteDescription: '该配置将从子代理模型选择中移除。',
  required: '请填写全部字段。', duplicate: '已存在同名配置。', deploymentDefault: '部署默认配置',
  instruction: '子代理系统指令（可选）', instructionHint: '每次使用此配置时，都会作为仅对子代理生效的系统指令。',
  instructionConfigured: '指令：', reasoningEffort: '推理强度（可选）',
  reasoningEffortHint: '留空则使用提供商默认值。建议 ID 来自所选模型；实际使用时由确切子代理路由校验已保存的值。',
  reasoningEffortDefault: '目录默认值：', customizedDefault: '已自定义默认配置', reset: '重置',
}
