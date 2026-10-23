/**
 * 文件说明：定义 AI 模型配置在渲染进程、IPC 与 SQLite 仓库间共享的契约。
 */

/** 支持的模型请求端点协议。 */
export const AI_MODEL_ENDPOINT_TYPES = [
  'openai',
  'openai-response',
  'anthropic',
  'gemini'
] as const;

export type AiModelEndpointType = typeof AI_MODEL_ENDPOINT_TYPES[number];

/** 设置页中端点协议的可读名称。 */
export const AI_MODEL_ENDPOINT_TYPE_LABELS: Record<AiModelEndpointType, string> = {
  openai: 'OpenAI',
  'openai-response': 'OpenAI-Response',
  anthropic: 'Anthropic',
  gemini: 'Gemini'
};

/** 已持久化的 AI 模型配置。 */
export interface AiModel {
  id: string;
  name: string;
  groupName: string;
  endpointType: AiModelEndpointType;
  connectionSucceeded: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A tested model exposed to editor features together with its owning configuration. */
export interface AiConnectedModel {
  configurationId: string;
  configurationName: string;
  id: string;
  name: string;
  groupName: string;
  endpointType: AiModelEndpointType;
}

/** 新建 AI 模型配置时允许提交的字段。 */
export interface CreateAiModelRequest {
  id: string;
  name: string;
  groupName: string;
  endpointType: AiModelEndpointType;
}

/** 更新已存在的 AI 模型配置时提交的字段。 */
export interface UpdateAiModelRequest extends CreateAiModelRequest {
  originalId: string;
}

/** 判断值是否为当前支持的端点协议。 */
export function isAiModelEndpointType(value: unknown): value is AiModelEndpointType {
  return typeof value === 'string'
    && AI_MODEL_ENDPOINT_TYPES.some(endpointType => endpointType === value);
}
