/**
 * Wraps the configuration-scoped AI IPC bridge for renderer use.
 */
import type {
  AiConfiguration,
  UpdateAiConfigurationRequest
} from '@/types/aiConfiguration';
import { nativeApi } from './native';

export const aiConfigurationApi = {
  listConfigurations(): Promise<AiConfiguration[]> {
    return nativeApi.aiConfigurations.list();
  },

  createConfiguration(): Promise<AiConfiguration> {
    return nativeApi.aiConfigurations.create();
  },

  deleteConfiguration(configurationId: string): Promise<void> {
    return nativeApi.aiConfigurations.delete(configurationId);
  },

  updateConfiguration(
    configurationId: string,
    request: UpdateAiConfigurationRequest
  ): Promise<AiConfiguration> {
    return nativeApi.aiConfigurations.update(configurationId, request);
  },

  onChanged(listener: (configurations: readonly AiConfiguration[]) => void): () => void {
    return nativeApi.aiConfigurations.onChanged(listener);
  }
};
