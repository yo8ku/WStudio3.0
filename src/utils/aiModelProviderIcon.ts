/**
 * 文件说明：根据 AI 模型显示名称识别服务商，并返回设置页可渲染的品牌图标。
 */
const claudeIcon = 'icon icon-claude';
const deepSeekIcon = 'icon icon-deep-seek';
const geminiIcon = 'icon icon-gemini';
const gptIcon = 'icon icon-gpt';
const miniMaxIcon = 'icon icon-mini-max';
const qwenIcon = 'icon icon-qwen';

/** 已识别模型服务商的图标数据。 */
export interface AiModelProviderIcon {
  id: 'openai' | 'gemini' | 'anthropic' | 'deepseek' | 'minimax' | 'qwen';
  label: string;
  markup: string;
}

interface AiModelProviderIconRule extends AiModelProviderIcon {
  pattern: string;
}

const AI_MODEL_PROVIDER_ICON_RULES: readonly AiModelProviderIconRule[] = [
  { id: 'openai', label: 'OpenAI', markup: gptIcon, pattern: 'gpt' },
  { id: 'gemini', label: 'Gemini', markup: geminiIcon, pattern: 'gemini' },
  { id: 'anthropic', label: 'Anthropic', markup: claudeIcon, pattern: 'claude' },
  { id: 'deepseek', label: 'DeepSeek', markup: deepSeekIcon, pattern: 'deepseek' },
  { id: 'minimax', label: 'MiniMax', markup: miniMaxIcon, pattern: 'minimax' },
  { id: 'qwen', label: 'Qwen', markup: qwenIcon, pattern: 'qwen' }
];

/**
 * 按模型名称进行大小写不敏感的服务商识别；未匹配的自定义模型不显示品牌图标。
 */
export function getAiModelProviderIcon(
  modelName: string
): AiModelProviderIcon | undefined {
  const normalizedName = modelName.trim().toLocaleLowerCase();
  if (!normalizedName) {
    return undefined;
  }

  return AI_MODEL_PROVIDER_ICON_RULES.find(rule => normalizedName.includes(rule.pattern));
}
