/**
 * 文件说明：管理 AI 配置、其连接设置和归属模型的设置页共享状态。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { aiConfigurationApi } from '@/api/aiConfiguration';
import { aiConnectionApi } from '@/api/aiConnection';
import { aiModelApi } from '@/api/aiModel';
import type {
  AiConfiguration,
  UpdateAiConfigurationRequest
} from '@/types/aiConfiguration';
import type {
  AiConnectionSettings,
  AiConnectionTestResult,
  UpdateAiConnectionSettingsRequest
} from '@/types/aiConnection';
import type {
  AiModel,
  CreateAiModelRequest,
  UpdateAiModelRequest
} from '@/types/aiModel';

const CONNECTION_FAILED: AiConnectionTestResult = {
  success: false,
  message: '连接失败'
};

function createEmptyConnectionSettings(): AiConnectionSettings {
  return {
    apiEndpoint: '',
    apiKey: '',
    hasApiKey: false
  };
}

/** AI 配置页的 Store，每次仅在共享列表中保留当前配置的连接与模型数据。 */
export const useAiModelStore = defineStore('aiModel', () => {
  const configurations = ref<AiConfiguration[]>([]);
  const configurationsLoading = ref(false);
  const configurationDeleting = ref(false);
  const currentConfigurationId = ref<string>();
  const models = ref<AiModel[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<string>();
  const connectionSettings = ref<AiConnectionSettings>(createEmptyConnectionSettings());
  const connectionSettingsLoading = ref(false);
  const connectionSettingsSaving = ref(false);
  const connectionChecking = ref(false);
  const connectionTestResult = ref<AiConnectionTestResult>();
  let disposeConfigurationsListener: (() => void) | undefined;
  let latestModelsRequest = 0;
  let latestSettingsRequest = 0;
  let latestModelSaveRequest = 0;
  let latestConnectionSaveRequest = 0;
  let latestConnectionTestRequest = 0;

  function handleConfigurationsChanged(nextConfigurations: readonly AiConfiguration[]): void {
    configurations.value = [...nextConfigurations];
    const currentId = currentConfigurationId.value;
    if (!currentId) return;

    const activeConfiguration = configurations.value.find(configuration => configuration.id === currentId);
    if (activeConfiguration) {
      // Configuration update events are also emitted by our own connection-save
      // and connection-test IPC calls. Reloading while either operation is in
      // flight would invalidate its request and clear the busy indicator before
      // the network probe starts. The active form already owns the just-saved
      // values; the next explicit load after completion refreshes model data.
      if (connectionSettingsSaving.value || connectionChecking.value) return;
      void loadConfiguration(activeConfiguration.id);
    } else {
      currentConfigurationId.value = configurations.value[0]?.id;
    }
  }

  function ensureConfigurationsListener(): void {
    if (!disposeConfigurationsListener) {
      disposeConfigurationsListener = aiConfigurationApi.onChanged(handleConfigurationsChanged);
    }
  }

  // 立即注册监听器，避免错过首次事件
  ensureConfigurationsListener();

  /** Reads all persisted configuration pages for the AI navigation. */
  async function loadConfigurations(): Promise<void> {
    configurationsLoading.value = true;
    try {
      configurations.value = await aiConfigurationApi.listConfigurations();
    } catch (reason: unknown) {
      error.value = readConfigurationError(reason);
    } finally {
      configurationsLoading.value = false;
    }
  }

  /** Creates a persisted configuration without duplicating an earlier host broadcast. */
  async function createConfiguration(): Promise<AiConfiguration | undefined> {
    configurationsLoading.value = true;
    error.value = undefined;
    try {
      const configuration = await aiConfigurationApi.createConfiguration();
      if (!configurations.value.some(item => item.id === configuration.id)) {
        configurations.value = [...configurations.value, configuration];
      }
      return configuration;
    } catch (reason: unknown) {
      error.value = readConfigurationError(reason);
      return undefined;
    } finally {
      configurationsLoading.value = false;
    }
  }

  /** Deletes one persisted configuration after the main process verifies the minimum-count rule. */
  async function deleteConfiguration(configurationId: string): Promise<boolean> {
    configurationDeleting.value = true;
    error.value = undefined;
    try {
      await aiConfigurationApi.deleteConfiguration(configurationId);
      configurations.value = configurations.value.filter(
        configuration => configuration.id !== configurationId
      );
      return true;
    } catch (reason: unknown) {
      error.value = readConfigurationError(reason);
      return false;
    } finally {
      configurationDeleting.value = false;
    }
  }

  /** Optimistically updates configuration metadata and restores it if persistence fails. */
  async function updateConfiguration(
    configurationId: string,
    request: UpdateAiConfigurationRequest
  ): Promise<AiConfiguration | undefined> {
    const previousConfigurations = configurations.value;
    const current = previousConfigurations.find(configuration => configuration.id === configurationId);
    if (!current) return undefined;

    configurations.value = previousConfigurations.map(configuration => (
      configuration.id === configurationId
        ? { ...configuration, ...request }
        : configuration
    ));
    error.value = undefined;

    try {
      const updated = await aiConfigurationApi.updateConfiguration(configurationId, request);
      configurations.value = configurations.value.map(configuration => (
        configuration.id === configurationId ? updated : configuration
      ));
      return updated;
    } catch (reason: unknown) {
      configurations.value = previousConfigurations;
      error.value = readConfigurationError(reason);
      return undefined;
    }
  }

  /** Activates a configuration and commits its models and settings together to avoid intermediate empty UI. */
  async function loadConfiguration(configurationId: string): Promise<void> {
    currentConfigurationId.value = configurationId;
    connectionTestResult.value = undefined;
    latestModelSaveRequest += 1;
    latestConnectionSaveRequest += 1;
    latestConnectionTestRequest += 1;
    saving.value = false;
    connectionSettingsSaving.value = false;
    connectionChecking.value = false;
    error.value = undefined;
    const modelsRequestId = ++latestModelsRequest;
    const settingsRequestId = ++latestSettingsRequest;
    loading.value = true;
    connectionSettingsLoading.value = true;

    try {
      const [loadedModels, settings] = await Promise.all([
        aiModelApi.listModels(configurationId),
        aiConnectionApi.getSettings(configurationId)
      ]);
      if (
        modelsRequestId === latestModelsRequest
        && settingsRequestId === latestSettingsRequest
        && currentConfigurationId.value === configurationId
      ) {
        models.value = loadedModels;
        connectionSettings.value = settings;
      }
    } catch (reason: unknown) {
      if (
        modelsRequestId === latestModelsRequest
        && settingsRequestId === latestSettingsRequest
        && currentConfigurationId.value === configurationId
      ) {
        error.value = readErrorMessage(reason, '无法加载配置。');
      }
    } finally {
      if (
        modelsRequestId === latestModelsRequest
        && settingsRequestId === latestSettingsRequest
        && currentConfigurationId.value === configurationId
      ) {
        loading.value = false;
        connectionSettingsLoading.value = false;
      }
    }
  }

  /** Loads only the models that belong to the currently active configuration. */
  async function loadModels(configurationId: string): Promise<void> {
    const requestId = ++latestModelsRequest;
    loading.value = true;
    error.value = undefined;

    try {
      const loadedModels = await aiModelApi.listModels(configurationId);
      if (requestId === latestModelsRequest && currentConfigurationId.value === configurationId) {
        models.value = loadedModels;
      }
    } catch (reason: unknown) {
      if (requestId === latestModelsRequest && currentConfigurationId.value === configurationId) {
        error.value = readErrorMessage(reason, '无法加载模型。');
      }
    } finally {
      if (requestId === latestModelsRequest && currentConfigurationId.value === configurationId) {
        loading.value = false;
      }
    }
  }

  /** Creates a model in one configuration and synchronizes the visible list when it is active. */
  async function addModel(
    configurationId: string,
    request: CreateAiModelRequest
  ): Promise<AiModel | undefined> {
    const saveRequestId = ++latestModelSaveRequest;
    latestModelsRequest += 1;
    loading.value = false;
    saving.value = true;
    error.value = undefined;

    try {
      const created = await aiModelApi.createModel(configurationId, request);
      if (currentConfigurationId.value === configurationId) {
        models.value = [...models.value, created].sort(compareModels);
      }
      return created;
    } catch (reason: unknown) {
      if (currentConfigurationId.value === configurationId) {
        error.value = readErrorMessage(reason, '无法添加模型。');
      }
      return undefined;
    } finally {
      if (saveRequestId === latestModelSaveRequest) {
        saving.value = false;
      }
    }
  }

  /** Updates a model within one configuration without exposing models from other configurations. */
  async function updateModel(
    configurationId: string,
    request: UpdateAiModelRequest
  ): Promise<AiModel | undefined> {
    const saveRequestId = ++latestModelSaveRequest;
    latestModelsRequest += 1;
    loading.value = false;
    saving.value = true;
    error.value = undefined;

    try {
      const updated = await aiModelApi.updateModel(configurationId, request);
      if (currentConfigurationId.value === configurationId) {
        models.value = models.value
          .filter(model => model.id !== request.originalId && model.id !== updated.id)
          .concat(updated)
          .sort(compareModels);
      }
      return updated;
    } catch (reason: unknown) {
      if (currentConfigurationId.value === configurationId) {
        error.value = readErrorMessage(reason, '无法更新模型。');
      }
      return undefined;
    } finally {
      if (saveRequestId === latestModelSaveRequest) {
        saving.value = false;
      }
    }
  }

  /** Loads the connection settings stored by one configuration. */
  async function loadConnectionSettings(configurationId: string): Promise<void> {
    const requestId = ++latestSettingsRequest;
    connectionSettingsLoading.value = true;

    try {
      const settings = await aiConnectionApi.getSettings(configurationId);
      if (requestId === latestSettingsRequest && currentConfigurationId.value === configurationId) {
        connectionSettings.value = settings;
      }
    } finally {
      if (requestId === latestSettingsRequest && currentConfigurationId.value === configurationId) {
        connectionSettingsLoading.value = false;
      }
    }
  }

  /** Saves API settings to one configuration and updates the current visible form. */
  async function saveConnectionSettings(
    configurationId: string,
    request: UpdateAiConnectionSettingsRequest
  ): Promise<AiConnectionSettings | undefined> {
    const saveRequestId = ++latestConnectionSaveRequest;
    latestSettingsRequest += 1;
    connectionSettingsLoading.value = false;
    connectionSettingsSaving.value = true;

    try {
      const saved = await aiConnectionApi.updateSettings(configurationId, request);
      if (currentConfigurationId.value === configurationId) {
        connectionSettings.value = saved;
      }
      return saved;
    } catch (reason: unknown) {
      console.error('[ai-connection] 保存连接配置失败。', {
        configurationId,
        error: readConnectionError(reason)
      });
      return undefined;
    } finally {
      if (saveRequestId === latestConnectionSaveRequest) {
        connectionSettingsSaving.value = false;
      }
    }
  }

  /** Reloads connection settings from main process to sync renderer state. */
  async function reloadConnectionSettings(configurationId: string): Promise<void> {
    const requestId = ++latestSettingsRequest;

    try {
      const settings = await aiConnectionApi.getSettings(configurationId);
      if (requestId === latestSettingsRequest && currentConfigurationId.value === configurationId) {
        connectionSettings.value = settings;
      }
    } catch (reason: unknown) {
      console.error('[ai-connection] 重新加载连接设置失败。', {
        configurationId,
        error: readConnectionError(reason)
      });
    }
  }

  /** Persists one configuration's form values before running its selected model test. */
  async function testConnection(
    configurationId: string,
    modelId: string,
    settings: UpdateAiConnectionSettingsRequest
  ): Promise<AiConnectionTestResult> {
    const testRequestId = ++latestConnectionTestRequest;
    connectionTestResult.value = undefined;
    connectionChecking.value = true;
    console.info('[ai-connection] 渲染进程开始请求连接测试。', { configurationId, modelId });
    try {
      const saved = await saveConnectionSettings(configurationId, settings);
      if (!saved) {
        if (testRequestId === latestConnectionTestRequest && currentConfigurationId.value === configurationId) {
          connectionTestResult.value = CONNECTION_FAILED;
        }
        return CONNECTION_FAILED;
      }
      if (testRequestId !== latestConnectionTestRequest || currentConfigurationId.value !== configurationId) {
        return CONNECTION_FAILED;
      }

      const result = await aiConnectionApi.testModel(configurationId, modelId);
      if (testRequestId === latestConnectionTestRequest && currentConfigurationId.value === configurationId) {
        console.info('[ai-connection] 渲染进程收到连接测试结果。', {
          configurationId,
          modelId,
          success: result.success,
          message: result.message
        });
        connectionTestResult.value = result;
      }
      await loadConfigurations();
      return result;
    } catch (reason: unknown) {
      if (testRequestId !== latestConnectionTestRequest) {
        return CONNECTION_FAILED;
      }
      console.error('[ai-connection] 调用主进程连接测试失败。', {
        configurationId,
        modelId,
        error: readConnectionError(reason)
      });
      if (testRequestId === latestConnectionTestRequest && currentConfigurationId.value === configurationId) {
        connectionTestResult.value = CONNECTION_FAILED;
      }
      return CONNECTION_FAILED;
    } finally {
      if (testRequestId === latestConnectionTestRequest && currentConfigurationId.value === configurationId) {
        connectionChecking.value = false;
      }
    }
  }

  async function deleteModel(configurationId: string, modelId: string): Promise<boolean> {
    try {
      await aiModelApi.deleteModel(configurationId, modelId);
      if (currentConfigurationId.value === configurationId) {
        models.value = models.value.filter(model => model.id !== modelId);
      }
      return true;
    } catch (reason: unknown) {
      if (currentConfigurationId.value === configurationId) error.value = readErrorMessage(reason, '无法移除模型。');
      return false;
    }
  }

  async function cancelConnectionTest(configurationId: string): Promise<void> {
    latestConnectionTestRequest += 1;
    connectionChecking.value = false;
    connectionSettingsSaving.value = false;
    connectionTestResult.value = undefined;
    await aiConnectionApi.cancelTest(configurationId);
  }

  /** Clears the visible result before opening the test dialog again. */
  function clearConnectionTestResult(): void {
    connectionTestResult.value = undefined;
  }

  /** Clears the model operation error when a dialog starts a new request. */
  function clearError(): void {
    error.value = undefined;
  }

  return {
    configurations,
    configurationsLoading,
    configurationDeleting,
    currentConfigurationId,
    models,
    loading,
    saving,
    error,
    connectionSettings,
    connectionSettingsLoading,
    connectionSettingsSaving,
    connectionChecking,
    connectionTestResult,
    loadConfigurations,
    createConfiguration,
    deleteConfiguration,
    updateConfiguration,
    loadConfiguration,
    loadModels,
    addModel,
    updateModel,
    deleteModel,
    loadConnectionSettings,
    saveConnectionSettings,
    reloadConnectionSettings,
    testConnection,
    cancelConnectionTest,
    clearConnectionTestResult,
    clearError
  };
});

/** Keeps local updates in the same order as the SQLite model query. */
function compareModels(first: AiModel, second: AiModel): number {
  return first.groupName.localeCompare(second.groupName)
    || first.name.localeCompare(second.name)
    || first.id.localeCompare(second.id);
}

/** Translates stable model errors into text suitable for the settings page. */
function readErrorMessage(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback;

  switch (reason.message) {
    case 'AI_MODEL_ID_EXISTS':
      return '模型 ID 已存在。';
    case 'AI_MODEL_NOT_FOUND':
      return '模型不存在或已被移除。';
    case 'AI_MODEL_ID_REQUIRED':
      return '请填写模型 ID。';
    case 'AI_MODEL_ENDPOINT_TYPE_INVALID':
      return '端点类型无效。';
    default:
      return fallback;
  }
}

/** Translates stable configuration errors into text suitable for the settings page. */
function readConfigurationError(reason: unknown): string {
  if (!(reason instanceof Error)) return '无法处理配置。';

  switch (reason.message) {
    case 'AI_CONFIGURATION_NAME_EXISTS':
      return '配置名称已存在。';
    case 'AI_CONFIGURATION_NAME_REQUIRED':
      return '请填写配置名称。';
    case 'AI_CONFIGURATION_NAME_TOO_LONG':
      return '配置名称不能超过11个字符。';
    case 'AI_CONFIGURATION_NOT_FOUND':
      return '配置不存在或已被移除。';
    case 'AI_CONFIGURATION_DELETE_LAST_FORBIDDEN':
      return '至少需要保留一个配置。';
    default:
      return '无法处理配置。';
  }
}

/** Limits cross-process error logging to a safe diagnostic string. */
function readConnectionError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
