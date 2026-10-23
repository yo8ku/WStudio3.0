<script setup lang="ts">
/**
 * 文件说明：渲染设置窗口中的 AI 连接配置与模型管理入口。
 */
import { computed, ref, watch } from 'vue';

const addIcon = 'icon icon-add';
const deleteIcon = 'icon icon-delete';
const dotIcon = 'icon icon-dot';
const editorIcon = 'icon icon-editor';
const eyeIcon = 'icon icon-eye';
const eyeOffIcon = 'icon icon-eye-off';
const editModelIcon = 'icon icon-settings';
const removeModelIcon = 'icon icon-min';
const searchIcon = 'icon icon-search';
import Message from '@/components/Message/Message.vue';
import AIModelAddDialog from '@/components/workbench/AIModel/AIModelAddDialog.vue';
import AIModelCheckDialog from '@/components/workbench/AIModel/AIModelCheckDialog.vue';
import WsAccordion from '@/components/WsAccordion/WsAccordion.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsInput from '@/components/WsInput/WsInput.vue';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import WsSwitch from '@/components/WsSwitch/WsSwitch.vue';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import WsProgressCircular from '@/components/WsProgressCircular/WsProgressCircular.vue';
import { useAiModelStore } from '@/store/aiModel';
import { getAiEndpointPreview } from '@/api/aiConnection';
import { getAiModelProviderIcon } from '@/utils/aiModelProviderIcon';
import { AI_CONFIGURATION_NAME_MAX_LENGTH } from '@/types/aiConfiguration';
import {
  AI_MODEL_ENDPOINT_TYPE_LABELS,
  type AiModel,
  type CreateAiModelRequest
} from '@/types/aiModel';
import type { UpdateAiConnectionSettingsRequest } from '@/types/aiConnection';
import type { MessageType } from '@/components/Message/types';

/** AI 配置页头部可由设置导航同步的配置属性。 */
interface AIModelSettingsPanelProps {
  configurationId: string;
  configurationName: string;
  configurationEnabled: boolean;
  canDeleteConfiguration: boolean;
}

const props = defineProps<AIModelSettingsPanelProps>();

const emit = defineEmits<{
  'update:configurationName': [value: string];
  'update:configurationEnabled': [value: boolean];
  'delete:configuration': [];
}>();

const apiKey = ref('');
const apiEndpoint = ref('');
const configurationNameDraft = ref(props.configurationName);
const isConfigurationNameEditing = ref(false);
const showApiKey = ref(false);
const isAddModelDialogOpen = ref(false);
const editingModel = ref<AiModel | null>(null);
const isApiKeyCheckDialogOpen = ref(false);
const isConnectionMessageVisible = ref(false);
const connectionMessage = ref('');
const connectionMessageType = ref<MessageType>('info');
let connectionDialogClosedByUser = false;
const isModelSearchVisible = ref(false);
const modelSearchQuery = ref('');
const aiModelStore = useAiModelStore();
const modelCount = computed(() => aiModelStore.models.length);
const connectionBusy = computed(() => (
  aiModelStore.connectionChecking || aiModelStore.connectionSettingsSaving
));
const apiEndpointPreview = computed(() => {
  const protocols = [...new Set(aiModelStore.models.map(model => model.endpointType))];
  return getAiEndpointPreview(apiEndpoint.value, protocols.length === 1 ? protocols[0] : undefined);
});
const groupNames = computed(() => [...new Set(
  aiModelStore.models
    .map(model => model.groupName)
    .filter((name): name is string => name.length > 0)
)].sort((first, second) => first.localeCompare(second)));
const expandedModelGroups = ref<Record<string, boolean>>({});
const filteredModels = computed(() => {
  const query = modelSearchQuery.value.trim().toLocaleLowerCase();
  if (!query) {
    return aiModelStore.models;
  }

  return aiModelStore.models.filter(model => [
    model.id,
    model.name,
    model.groupName,
    AI_MODEL_ENDPOINT_TYPE_LABELS[model.endpointType]
  ].some(value => value.toLocaleLowerCase().includes(query)));
});
const groupedModels = computed(() => {
  const groups = new Map<string, { name: string; models: AiModel[] }>();

  filteredModels.value.forEach(model => {
    const name = model.groupName || '未分组';
    const group = groups.get(name);
    if (group) {
      group.models.push(model);
      return;
    }

    groups.set(name, { name, models: [model] });
  });

  return [...groups.values()];
});
const inputVisibilityButtonProps = {
  density: 'compact',
  icon: true,
  ripple: false,
  size: 'x-small',
  variant: 'text'
} as const;
const modelSearchButtonProps = {
  density: 'compact',
  icon: true,
  ripple: false,
  size: 'x-small',
  variant: 'text'
} as const;
const modelActionButtonProps = {
  density: 'compact',
  ripple: false,
  size: 'x-small',
  variant: 'text'
} as const;
const modelActionTooltipProps = {
  location: 'top'
} as const;
const configurationActionButtonProps = {
  density: 'compact',
  ripple: false,
  size: 'x-small',
  variant: 'text'
} as const;

watch(
  groupedModels,
  (groups) => {
    const nextExpandedGroups = { ...expandedModelGroups.value };
    const shouldExpandGroups = modelSearchQuery.value.trim().length > 0;

    groups.forEach(group => {
      if (shouldExpandGroups || nextExpandedGroups[group.name] === undefined) {
        nextExpandedGroups[group.name] = true;
      }
    });

    expandedModelGroups.value = nextExpandedGroups;
  },
  { immediate: true }
);

/** 关闭模型搜索并清除当前查询。 */
function closeModelSearch(): void {
  modelSearchQuery.value = '';
  isModelSearchVisible.value = false;
}

/** 打开配置名称编辑框并保留当前名称作为草稿。 */
function startConfigurationNameEditing(): void {
  configurationNameDraft.value = props.configurationName;
  isConfigurationNameEditing.value = true;
}

/** 提交非空配置名称，并使左侧导航同步显示。 */
function commitConfigurationName(): void {
  const name = configurationNameDraft.value.trim();
  if (!name) return;
  emit('update:configurationName', name);
  isConfigurationNameEditing.value = false;
}

/** 放弃配置名称编辑并恢复当前已应用的名称。 */
function cancelConfigurationNameEditing(): void {
  configurationNameDraft.value = props.configurationName;
  isConfigurationNameEditing.value = false;
}

/** 将开关值收窄为配置页使用的布尔状态。 */
function updateConfigurationEnabled(value: boolean): void {
  if (value !== props.configurationEnabled) {
    emit('update:configurationEnabled', value);
  }
}

/** Opens the parent-owned confirmation flow for the active configuration. */
function requestConfigurationDeletion(): void {
  if (props.canDeleteConfiguration) {
    emit('delete:configuration');
  }
}

/** 打开新增模型弹窗前清理上一轮保存失败提示。 */
function openAddModelDialog(): void {
  aiModelStore.clearError();
  isApiKeyCheckDialogOpen.value = false;
  editingModel.value = null;
  isAddModelDialogOpen.value = true;
}

/** 打开复用新增表单的模型编辑弹窗并回填当前模型。 */
function openEditModelDialog(model: AiModel): void {
  aiModelStore.clearError();
  isApiKeyCheckDialogOpen.value = false;
  editingModel.value = model;
  isAddModelDialogOpen.value = true;
}

/** 打开 API 密钥检测弹窗。 */
function openApiKeyCheckDialog(): void {
  aiModelStore.clearConnectionTestResult();
  connectionDialogClosedByUser = false;
  isAddModelDialogOpen.value = false;
  editingModel.value = null;
  isApiKeyCheckDialogOpen.value = true;
}

/** 将当前输入作为设置值提交，空字符串仅表示用户手动清除密钥。 */
function getConnectionSettingsRequest(apiKeyValue = apiKey.value): UpdateAiConnectionSettingsRequest {
  return {
    apiEndpoint: apiEndpoint.value,
    apiKey: apiKeyValue.trim()
  };
}

/** 保存当前配置后执行模型测试，测试过程不修改当前输入的密钥。 */
async function handleConnectionTest(modelId: string): Promise<void> {
  const configurationId = props.configurationId;
  connectionDialogClosedByUser = false;
  isApiKeyCheckDialogOpen.value = false;
  const result = await aiModelStore.testConnection(
    configurationId,
    modelId,
    getConnectionSettingsRequest()
  );
  if (props.configurationId !== configurationId) return;
  if (connectionDialogClosedByUser) return;

  await aiModelStore.loadModels(configurationId);
  if (props.configurationId !== configurationId) return;

  apiEndpoint.value = aiModelStore.connectionSettings.apiEndpoint;
  connectionMessage.value = result.message;
  connectionMessageType.value = result.success ? 'success' : 'error';
  isConnectionMessageVisible.value = true;
  isApiKeyCheckDialogOpen.value = false;
}

function handleConnectionDialogVisibility(visible: boolean): void {
  isApiKeyCheckDialogOpen.value = visible;
  if (visible) return;
  connectionDialogClosedByUser = true;
  if (connectionBusy.value) {
    void aiModelStore.cancelConnectionTest(props.configurationId);
  }
}

/** 由 Store 写入 SQLite，成功后才关闭新增模型弹窗。 */
async function handleModelSave(model: CreateAiModelRequest, originalId?: string): Promise<void> {
  const configurationId = props.configurationId;
  const saved = originalId
    ? await aiModelStore.updateModel(configurationId, { ...model, originalId })
    : await aiModelStore.addModel(configurationId, model);

  if (saved && props.configurationId === configurationId) {
    isAddModelDialogOpen.value = false;
  }
}

/** 关闭新增模型弹窗时不保留已经处理过的错误提示。 */
function handleAddModelDialogVisibility(visible: boolean): void {
  isAddModelDialogOpen.value = visible;
  if (visible) {
    isApiKeyCheckDialogOpen.value = false;
  }
  if (!visible) {
    editingModel.value = null;
    aiModelStore.clearError();
  }
}

/** 更新单个模型分组的展开状态。 */
function setModelGroupExpanded(groupName: string, expanded: boolean): void {
  expandedModelGroups.value = {
    ...expandedModelGroups.value,
    [groupName]: expanded
  };
}

/** Moves every model in a group to the ungrouped bucket. */
async function removeModelGroup(group: { name: string; models: AiModel[] }): Promise<void> {
  const configurationId = props.configurationId;
  if (group.name === '未分组') return;
  for (const model of group.models) {
    await aiModelStore.updateModel(configurationId, {
      originalId: model.id,
      id: model.id,
      name: model.name,
      groupName: '',
      endpointType: model.endpointType
    });
  }
  if (props.configurationId === configurationId) {
    await aiModelStore.loadModels(configurationId);
  }
}

async function removeModel(model: AiModel): Promise<void> {
  await aiModelStore.deleteModel(props.configurationId, model.id);
}

watch(
  () => aiModelStore.connectionSettings,
  connectionSettings => {
    apiEndpoint.value = connectionSettings.apiEndpoint;
    apiKey.value = connectionSettings.apiKey;
  },
  { immediate: true }
);

watch(() => props.configurationName, name => {
  if (!isConfigurationNameEditing.value) {
    configurationNameDraft.value = name;
  }
});

watch(() => props.configurationId, async configurationId => {
  isAddModelDialogOpen.value = false;
  editingModel.value = null;
  showApiKey.value = false;
  closeModelSearch();
  await aiModelStore.loadConfiguration(configurationId);
  // 主动重新加载一次连接设置，确保捕获在监听器注册前发生的变更
  await aiModelStore.reloadConnectionSettings(configurationId);
}, { immediate: true });

/** 用户修改 API 密钥后自动保存。 */
let apiKeySaveTimeout: ReturnType<typeof setTimeout> | undefined;
watch(apiKey, (value) => {
  if (!props.configurationEnabled) return;

  clearTimeout(apiKeySaveTimeout);
  apiKeySaveTimeout = setTimeout(() => {
    void aiModelStore.saveConnectionSettings(props.configurationId, {
      apiEndpoint: apiEndpoint.value,
      apiKey: value.trim()
    });
  }, 500);
});

/** 用户修改 API 地址后自动保存。 */
let apiEndpointSaveTimeout: ReturnType<typeof setTimeout> | undefined;
watch(apiEndpoint, (value) => {
  if (!props.configurationEnabled) return;

  clearTimeout(apiEndpointSaveTimeout);
  apiEndpointSaveTimeout = setTimeout(() => {
    void aiModelStore.saveConnectionSettings(props.configurationId, {
      apiEndpoint: value,
      apiKey: apiKey.value.trim()
    });
  }, 500);
});
</script>

<template>
  <section
    class="ai-model-settings"
    aria-label="AI模型配置"
  >
    <header class="ai-model-settings__configuration-header">
      <div class="ai-model-settings__configuration-title">
        <WsInput
          v-if="isConfigurationNameEditing"
          v-model="configurationNameDraft"
          autofocus
          :maxlength="AI_CONFIGURATION_NAME_MAX_LENGTH"
          required
          aria-label="配置页名称"
          class="ai-model-settings__configuration-name-input"
          @blur="commitConfigurationName"
          @keydown.esc="cancelConfigurationNameEditing"
          @keyup.enter="commitConfigurationName"
        />
        <h2
          v-else
          class="ai-model-settings__configuration-name"
        >
          {{ props.configurationName }}
        </h2>
        <WsTooltip
          v-bind="modelActionTooltipProps"
          text="编辑配置名称"
        >
          <template #activator="{ props: tooltipProps }">
            <WsIconButton
              v-bind="{ ...configurationActionButtonProps, ...tooltipProps }"
              class="ai-model-settings__configuration-action"
              :icon="editorIcon"
              label="编辑配置名称"
              @click="startConfigurationNameEditing"
            />
          </template>
        </WsTooltip>
      </div>
      <div class="ai-model-settings__configuration-actions">
        <WsSwitch
          :key="props.configurationId"
          :model-value="props.configurationEnabled"
          aria-label="启用配置"
          class="ai-model-settings__configuration-switch"
          @update:model-value="updateConfigurationEnabled"
        />
        <WsTooltip
          v-bind="modelActionTooltipProps"
          text="删除配置"
        >
          <template #activator="{ props: tooltipProps }">
            <WsIconButton
              v-bind="{ ...configurationActionButtonProps, ...tooltipProps }"
              class="ai-model-settings__configuration-action"
              :disabled="!props.canDeleteConfiguration"
              :icon="deleteIcon"
              label="删除配置"
              @click="requestConfigurationDeletion"
            />
          </template>
        </WsTooltip>
      </div>
    </header>

    <!-- S = AI 连接配置 -->
    <SettingsOptionList
      class="ai-model-settings__connection-options"
      list-label="连接"
    >
      <SettingsOptionItem
        title="API密钥"
        control-full-width
      >
        <WsInput
          v-model="apiKey"
          :aria-label="'API密钥'"
          class="ai-model-settings__field"
          :disabled="connectionBusy || !props.configurationEnabled"
          :type="showApiKey ? 'text' : 'password'"
        >
          <template #append-inner>
            <v-btn
              v-bind="inputVisibilityButtonProps"
              class="ai-model-settings__visibility-button"
              :aria-label="showApiKey ? '隐藏 API 密钥' : '显示 API 密钥'"
              @click="showApiKey = !showApiKey"
            >
              <span
                aria-hidden="true"
                class="ai-model-settings__visibility-icon"
                :class="showApiKey ? eyeIcon : eyeOffIcon"
              />
            </v-btn>
            <v-btn
              aria-label="检测 API 密钥"
              class="ai-model-settings__check-button"
              density="compact"
              :disabled="connectionBusy || !props.configurationEnabled"
              variant="text"
              @click="openApiKeyCheckDialog"
            >
              <WsProgressCircular
                v-if="connectionBusy"
                aria-label="正在检测 API 密钥"
                class="ai-model-settings__check-progress"
                :size="14"
                :width="2"
              />
              <span v-else>检测</span>
            </v-btn>
          </template>
        </WsInput>
      </SettingsOptionItem>
      <SettingsOptionItem
        title="API地址"
        class="ai-model-settings__endpoint-option"
        control-full-width
        vertical-align="start"
      >
        <div class="ai-model-settings__endpoint-control">
          <WsInput
            v-model="apiEndpoint"
            aria-label="API地址"
            class="ai-model-settings__field"
            :disabled="connectionBusy || !props.configurationEnabled"
            type="url"
          />
          <p
            :aria-hidden="!apiEndpointPreview"
            class="ai-model-settings__endpoint-preview"
          >
            <template v-if="apiEndpointPreview">
              <span>预览：</span>
              <span class="ai-model-settings__endpoint-preview-url">{{ apiEndpointPreview }}</span>
            </template>
          </p>
        </div>
      </SettingsOptionItem>
    </SettingsOptionList>
    <!-- E = AI 连接配置 -->

    <!-- S = 模型管理 -->
    <SettingsOptionList
      list-label="模型"
      title="模型"
    >
      <template #title-actions>
        <span
          class="ai-model-settings__model-count"
          :aria-label="`模型数量：${modelCount}`"
        >
          {{ modelCount }}
        </span>
      </template>

      <template #actions>
        <div class="ai-model-settings__model-header-actions">
          <div class="ai-model-settings__model-search-control">
            <WsSearchInput
              v-if="isModelSearchVisible"
              v-model="modelSearchQuery"
              aria-label="搜索模型"
              autofocus
              class="ai-model-settings__search"
              placeholder="搜索模型"
              @blur="closeModelSearch"
              @keydown.esc="closeModelSearch"
            >
              <template #append-inner>
                <span
                  aria-hidden="true"
                  class="ai-model-settings__model-search-icon"
                  :class="searchIcon"
                />
              </template>
            </WsSearchInput>
            <v-btn
              v-else
              v-bind="modelSearchButtonProps"
              aria-label="搜索模型"
              class="ai-model-settings__model-search-button"
              @click="isModelSearchVisible = true"
            >
              <span
                aria-hidden="true"
                class="ai-model-settings__model-search-icon"
                :class="searchIcon"
              />
            </v-btn>
          </div>
          <v-btn
            aria-label="添加"
            class="ai-model-settings__add-model"
            density="comfortable"
            :disabled="!props.configurationEnabled"
            :ripple="false"
            variant="outlined"
            @click="openAddModelDialog"
          >
            <span
              aria-hidden="true"
              class="ai-model-settings__add-model-icon"
              :class="addIcon"
            />
            <span>添加</span>
          </v-btn>
        </div>
      </template>

      <template v-if="groupedModels.length > 0">
            <WsAccordion
              v-for="group in groupedModels"
              :key="group.name"
              :model-value="expandedModelGroups[group.name] ?? true"
              role="listitem"
              :title="group.name"
              @update:model-value="setModelGroupExpanded(group.name, $event)"
            >
              <template #header-actions>
                <WsTooltip
                  v-bind="modelActionTooltipProps"
                  text="移除分组"
                >
                  <template #activator="{ props: tooltipProps }">
                    <WsIconButton
                      v-bind="{ ...modelActionButtonProps, ...tooltipProps }"
                      class="ai-model-settings__group-remove"
                      :icon="removeModelIcon"
                      label="移除分组"
                      @click="removeModelGroup(group)"
                    />
                  </template>
                </WsTooltip>
              </template>
              <div
                v-for="model in group.models"
                :key="model.id"
                class="ai-model-settings__model-option"
                role="listitem"
              >
                <span class="ai-model-settings__model-identity">
                  <span
                    v-if="getAiModelProviderIcon(model.name || model.id)"
                    :aria-label="`${getAiModelProviderIcon(model.name || model.id)?.label} 模型`"
                    class="ai-model-settings__model-provider-icon"
                    role="img"
                    :class="getAiModelProviderIcon(model.name || model.id)?.markup"
                  />
                  <span class="ai-model-settings__model-name">{{ model.name || model.id }}</span>
                  <span
                    v-if="model.connectionSucceeded"
                    aria-label="检测成功"
                    class="ai-model-settings__model-status"
                    role="img"
                    :class="dotIcon"
                  />
                </span>
                <span class="ai-model-settings__model-actions">
                  <WsTooltip
                    v-bind="modelActionTooltipProps"
                    text="编辑模型"
                  >
                    <template #activator="{ props: tooltipProps }">
                      <WsIconButton
                        v-bind="{ ...modelActionButtonProps, ...tooltipProps }"
                        class="ai-model-settings__model-action"
                        :icon="editModelIcon"
                        label="编辑模型"
                        @click="openEditModelDialog(model)"
                      />
                    </template>
                  </WsTooltip>
                  <WsTooltip
                    v-bind="modelActionTooltipProps"
                    text="移除模型"
                  >
                    <template #activator="{ props: tooltipProps }">
                      <WsIconButton
                        v-bind="{ ...modelActionButtonProps, ...tooltipProps }"
                        class="ai-model-settings__model-action"
                        :icon="removeModelIcon"
                        label="移除模型"
                        @click="removeModel(model)"
                      />
                    </template>
                  </WsTooltip>
                </span>
              </div>
            </WsAccordion>
      </template>
      <div
        v-if="modelSearchQuery.trim() && groupedModels.length === 0"
        class="ai-model-settings__model-state"
        role="listitem"
      >
        未找到匹配的模型
      </div>
      <div
        v-if="aiModelStore.error && !isAddModelDialogOpen"
        class="ai-model-settings__model-state ai-model-settings__model-state--error"
        role="alert"
      >
        {{ aiModelStore.error }}
      </div>
    </SettingsOptionList>
    <!-- E = 模型管理 -->

    <AIModelAddDialog
      :error="aiModelStore.error"
      :editing-model="editingModel"
      :group-names="groupNames"
      :model-value="isAddModelDialogOpen"
      :saving="aiModelStore.saving"
      @save="handleModelSave"
      @update:model-value="handleAddModelDialogVisibility"
    />
    <AIModelCheckDialog
      :detecting="connectionBusy"
      :model-value="isApiKeyCheckDialogOpen"
      :models="aiModelStore.models"
      @update:model-value="isApiKeyCheckDialogOpen = $event"
      @close="handleConnectionDialogVisibility(false)"
      @detect="handleConnectionTest"
    />
    <Message
      v-model="isConnectionMessageVisible"
      :message="connectionMessage"
      :type="connectionMessageType"
    />
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.ai-model-settings {
  display: flex;
  flex-direction: column;
  gap: $spacing-md;
  min-height: 100%;
  min-width: 0;
}


.ai-model-settings__field {
  width: 100%;
}

.ai-model-settings__configuration-header,
.ai-model-settings__configuration-title,
.ai-model-settings__configuration-actions {
  display: flex;
  align-items: center;
}

.ai-model-settings__configuration-header {
  justify-content: space-between;
  gap: $spacing-md;
  min-height: $input-control-min-height;
}

.ai-model-settings__configuration-title,
.ai-model-settings__configuration-actions {
  gap: $spacing-xs;
  min-width: 0;
}

.ai-model-settings__configuration-title {
  flex: 1 1 auto;
}

.ai-model-settings__configuration-name {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ws-foreground);
  font-size: $font-size-md;
  font-weight: $editor-table-header-font-weight;
  line-height: $input-control-min-height;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-settings__configuration-name-input {
  flex: 0 0 $settings-option-compact-control-width;
  max-width: 100%;
}

.ai-model-settings__configuration-action {
  width: $settings-plugin-action-size;
  min-width: $settings-plugin-action-size;
  height: $settings-plugin-action-size;
  padding: 0;
  border-radius: $radius-xs;
  color: var(--ws-descriptionForeground);
}

.ai-model-settings__configuration-action:hover,
.ai-model-settings__configuration-action:focus-visible {
  color: var(--ws-foreground);
  background: var(--ws-menu-hoverBackground);
}

.ai-model-settings__configuration-action :deep(.ws-icon-button__icon) {
  width: $settings-plugin-action-icon-size;
  height: $settings-plugin-action-icon-size;
}


.ai-model-settings__configuration-switch {
  flex: 0 0 auto;
  margin-right: 25px;
}

.ai-model-settings__configuration-switch :deep(.v-input__details) {
  display: none;
}

.ai-model-settings__endpoint-control {
  display: flex;
  flex-direction: column;
  gap: $spacing-3xs;
  width: 100%;
}

.ai-model-settings__connection-options :deep(.settings-option-list__items) {
  gap: $spacing-sm;
}

.ai-model-settings__endpoint-option :deep(.settings-option-item__content) {
  padding-block-start: calc(($input-control-min-height - $editor-line-height-size) / 2);
}

.ai-model-settings__endpoint-preview {
  display: flex;
  flex: 1 1 auto;
  gap: $spacing-3xs;
  min-height: $font-size-xs * $editor-line-height;
  min-width: 0;
  margin: 0;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  line-height: $editor-line-height;
  overflow-wrap: anywhere;
}

.ai-model-settings__endpoint-preview-url {
  min-width: 0;
  overflow-wrap: anywhere;
}

.ai-model-settings__field :deep(.v-field--appended) {
  padding-inline-end: 0;
}

.ai-model-settings__field :deep(.v-field__append-inner) {
  gap: 0;
}

.ai-model-settings__field :deep(.v-field__append-inner .v-btn) {
  height: $input-control-min-height;
  min-height: $input-control-min-height;
  padding: 0;
  margin-inline-end: 0;
  border-radius: 0;
}

.ai-model-settings__visibility-button {
  width: $input-control-min-height;
  min-width: $input-control-min-height;
  background: transparent;
}

.ai-model-settings__visibility-button:hover,
.ai-model-settings__visibility-button:active,
.ai-model-settings__visibility-button:focus,
.ai-model-settings__visibility-button:focus-visible,
.ai-model-settings__visibility-button.v-btn--active {
  background: transparent;
}

.ai-model-settings__visibility-button :deep(.v-btn__overlay),
.ai-model-settings__visibility-button :deep(.v-btn__underlay) {
  display: none;
}

.ai-model-settings__check-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.5rem;
  padding-inline: $spacing-sm;
  border-left: $input-border-width solid var(--ws-input-border);
  color: var(--ws-foreground);
  font-size: $font-size-sm;
  text-transform: none;
  letter-spacing: 0;
}

.ai-model-settings__check-progress {
  color: currentColor;
}

.ai-model-settings__visibility-icon {
  @include flex-center;
  width: $font-size-lg;
  height: $font-size-lg;
  font-size: $font-size-md;
  line-height: 1;
}

.ai-model-settings__model-search-control {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  width: $settings-option-control-width;
  max-width: 100%;
}

.ai-model-settings__model-header-actions {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: $spacing-xs;
  min-width: 0;
}

.ai-model-settings__search :deep(.v-input__control),
.ai-model-settings__search :deep(.v-field) {
  min-height: $settings-plugin-search-height;
  height: $settings-plugin-search-height;
}

.ai-model-settings__search :deep(.v-field__input) {
  min-height: $settings-plugin-search-height;
  padding-block: $spacing-none;
  font-size: $font-size-xs;
}

.ai-model-settings__search :deep(.v-field__append-inner) {
  align-items: center;
  align-self: stretch;
  height: 100%;
  padding-block: $spacing-none;
}

.ai-model-settings__model-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: $font-size-lg;
  height: $font-size-lg;
  padding-inline: $spacing-2xs;
  border-radius: $radius-xs;
  color: var(--ws-descriptionForeground);
  background: var(--ws-input-background);
  font-size: $font-size-xs;
  line-height: 1;
}

.ai-model-settings__model-search-button {
  width: $settings-plugin-action-size;
  min-width: $settings-plugin-action-size;
  height: $settings-plugin-action-size;
  padding: 0;
  color: var(--ws-descriptionForeground);
  font-size: 1rem
}

.ai-model-settings__model-search-icon {
  @include flex-center;
  width: $icon-size-width;
  height: $icon-size-height;
  color: var(--ws-descriptionForeground);
  line-height: 1;
}

.ai-model-settings__model-actions {
  display: flex;
  align-items: center;
  gap: $spacing-2xs;
}

.ai-model-settings__model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $settings-option-control-gap;
  width: 100%;
  min-width: 0;
  padding: 0.6rem 0;
}


.ai-model-settings__model-identity {
  display: flex;
  align-items: center;
  gap: $spacing-xs;
  min-width: 0;
}

.ai-model-settings__model-provider-icon {
  @include flex-center;
  flex: 0 0 auto;
  width: $icon-size-width;
  height: $icon-size-height;
  line-height: 1;
}

.ai-model-settings__model-name {
  min-width: 0;
  overflow: hidden;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-settings__model-status {
  @include flex-center;
  flex: 0 0 auto;
  width: $icon-size-width;
  height: $icon-size-height;
  color: #3fb950;
  line-height: 1;
}

.ai-model-settings__model-action {
  width: $settings-plugin-action-size;
  min-width: $settings-plugin-action-size;
  height: $settings-plugin-action-size;
  padding: 0;
  border-radius: $radius-xs;
  color: var(--ws-descriptionForeground);
}

.ai-model-settings__group-remove {
  width: $settings-plugin-action-size;
  min-width: $settings-plugin-action-size;
  height: $settings-plugin-action-size;
  padding: 0;
  border-radius: $radius-xs;
  color: var(--ws-descriptionForeground);
}

.ai-model-settings__group-remove:hover,
.ai-model-settings__group-remove:focus-visible {
  color: var(--ws-foreground);
  background: var(--ws-menu-hoverBackground);
}

.ai-model-settings__group-remove :deep(.ws-icon-button__icon) {
  width: $settings-plugin-action-icon-size;
  height: $settings-plugin-action-icon-size;
}

.ai-model-settings__model-action:hover,
.ai-model-settings__model-action:focus-visible {
  color: var(--ws-foreground);
  background: var(--ws-menu-hoverBackground);
}

.ai-model-settings__model-action :deep(.ws-icon-button__icon) {
  width: $settings-plugin-action-icon-size;
  height: $settings-plugin-action-icon-size;
}

.ai-model-settings__model-state {
  padding: $spacing-md;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-sm;
  line-height: $editor-line-height;
}

.ai-model-settings__model-state--error {
  color: var(--ws-errorForeground);
}

.ai-model-settings__add-model {
  flex: 0 0 auto;
  color: var(--ws-foreground);
  border-color: var(--ws-border);
  text-transform: none;
  letter-spacing: 0;
}

.ai-model-settings__add-model:hover {
  background: var(--ws-menu-hoverBackground);
}

.ai-model-settings__add-model-icon {
  @include flex-center;
  width: $icon-size-width;
  height: $icon-size-height;
  margin-inline-end: $spacing-2xs;
  line-height: 1;
}

@media (max-width: $settings-option-mobile-breakpoint) {
  .ai-model-settings__model-search-control {
    width: $settings-option-compact-control-width;
  }
}

</style>
