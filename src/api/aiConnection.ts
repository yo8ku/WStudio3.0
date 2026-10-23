/**
 * 文件说明：通过 Tauri 调用 Rust AI 连接配置与检测服务。
 */
import type {
  AiConnectionSettings,
  AiConnectionTestResult,
  UpdateAiConnectionSettingsRequest
} from '@/types/aiConnection';
import { nativeApi } from './native';
import type { AiModelEndpointType } from '@/types/aiModel';

/** Preview the provider API resource while preserving explicit versions and proxy prefixes. */
export function getAiEndpointPreview(value: string, protocol?: AiModelEndpointType): string | undefined {
  if (!value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const provider = protocol ?? (url.hostname === 'generativelanguage.googleapis.com' ? 'gemini' : 'openai');
    const path = url.pathname.replace(/\/+$/, '');
    if (provider === 'gemini') {
      url.pathname = !path ? '/v1beta/models' : path.endsWith('/models') ? path : `${path}/models`;
    } else {
      const suffix = provider === 'anthropic' ? '/messages' : provider === 'openai-response' ? '/responses' : '/chat/completions';
      url.pathname = path.endsWith(suffix) ? path : `${path || '/v1'}${suffix}`;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export const aiConnectionApi = {
  /** 读取设置窗口回填所需的全局连接配置。 */
  getSettings(configurationId: string): Promise<AiConnectionSettings> {
    return nativeApi.aiConnection.getSettings(configurationId);
  },

  /** 保存连接地址，并由 Rust 宿主将 API 密钥写入系统凭据库。 */
  updateSettings(
    configurationId: string,
    request: UpdateAiConnectionSettingsRequest
  ): Promise<AiConnectionSettings> {
    return nativeApi.aiConnection.updateSettings(configurationId, request);
  },

  /** 测试指定模型，主进程始终将失败收敛为固定结果。 */
  testModel(configurationId: string, modelId: string): Promise<AiConnectionTestResult> {
    return nativeApi.aiConnection.testModel(configurationId, modelId);
  },

  cancelTest(configurationId: string): Promise<void> {
    return nativeApi.aiConnection.cancelTest(configurationId);
  }
};
