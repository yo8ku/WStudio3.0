/**
 * 文件说明：通过 Tauri 调用 Rust AI 模型配置服务。
 */
import type {
  AiConnectedModel,
  AiModel,
  CreateAiModelRequest,
  UpdateAiModelRequest
} from '@/types/aiModel';
import { nativeApi } from './native';

export const aiModelApi = {
  /** 从主进程读取已持久化的模型配置。 */
  listModels(configurationId: string): Promise<AiModel[]> {
    return nativeApi.aiModels.list(configurationId);
  },

  /** Lists models that passed a connection test in enabled configurations. */
  listConnectedModels(): Promise<AiConnectedModel[]> {
    return nativeApi.aiModels.listConnected();
  },

  /** Subscribes to connection-test model updates published by the main process. */
  onConnectedModelsChanged(
    listener: (models: readonly AiConnectedModel[]) => void
  ): () => void {
    return nativeApi.aiModels.onConnectedChanged(listener);
  },

  /** 将一个已校验的模型配置写入主进程数据库。 */
  createModel(configurationId: string, request: CreateAiModelRequest): Promise<AiModel> {
    return nativeApi.aiModels.create(configurationId, request);
  },

  /** 将已存在的模型配置更新到主进程 SQLite。 */
  updateModel(configurationId: string, request: UpdateAiModelRequest): Promise<AiModel> {
    return nativeApi.aiModels.update(configurationId, request);
  },

  deleteModel(configurationId: string, modelId: string): Promise<void> {
    return nativeApi.aiModels.delete(configurationId, modelId);
  }
};
