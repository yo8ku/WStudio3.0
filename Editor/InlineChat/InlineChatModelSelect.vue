<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
const addIcon = 'icon icon-add';
import WsDropdownMenu from '@/components/WsDropdownMenu/WsDropdownMenu.vue';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import { aiModelApi } from '@/api/aiModel';
import { appSettingsApi } from '@/api/appSettings';
import { windowApi } from '@/api/window';
import { APP_SETTING_KEYS } from '@/types/appSettings';
import type { AiConnectedModel } from '@/types/aiModel';

const selectedModel = ref<string | null>(null);
const menuOpen = ref(false);
const arrowIcon = computed(() => menuOpen.value ? 'icon-arrow-up' : 'icon-arrow-down');
const search = ref('');
const models = ref<AiConnectedModel[]>([]);
const emit = defineEmits<{
  'model-change': [model: AiConnectedModel | undefined];
}>();
let disposeConnectedModelsListener: (() => void) | undefined;
let disposeSettingsListener: (() => void) | undefined;
let latestModelsRequest = 0;
let persistenceReady = false;

const filteredModels = computed(() => models.value.filter((model) => {
  const query = search.value.trim().toLocaleLowerCase();
  return !query || [model.id, model.name, model.groupName, model.configurationName]
    .some(value => value.toLocaleLowerCase().includes(query));
}));

type ModelOption = AiConnectedModel & {
  title: string;
  value: string;
};

const modelOptions = computed<ModelOption[]>(() => filteredModels.value.map(model => ({
  ...model,
  title: model.name || model.id,
  value: modelValue(model)
})));

const selectedModelOption = computed(() => models.value.find(model => modelValue(model) === selectedModel.value));

watch(selectedModelOption, model => emit('model-change', model), { immediate: true });

const groupedModelOptions = computed<Array<ModelOption & { isGroupStart: boolean }>>(() => {
  const groups = new Map<string, ModelOption[]>();

  modelOptions.value.forEach((model) => {
    const groupName = model.groupName || model.configurationName || '未分组';
    const group = groups.get(groupName);
    if (group) {
      group.push(model);
      return;
    }

    groups.set(groupName, [model]);
  });

  return [...groups.entries()].flatMap(([groupName, groupModels]) => (
    groupModels.map((model, index) => ({
      ...model,
      groupName,
      isGroupStart: index === 0
    }))
  ));
});

function modelValue(model: AiConnectedModel): string {
  return `${model.configurationId}:${model.id}`;
}

function getModelField(raw: unknown, field: 'title' | 'groupName' | 'configurationName'): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

function setModels(nextModels: readonly AiConnectedModel[]): void {
  models.value = [...nextModels];
  if (selectedModel.value && !models.value.some(model => modelValue(model) === selectedModel.value)) {
    selectedModel.value = null;
  }
}

async function readPersistedModel(): Promise<string | null> {
  const value = await appSettingsApi.get(APP_SETTING_KEYS.inlineChatSelectedModel);
  return value || null;
}

async function persistSelectedModel(value: string | null): Promise<void> {
  if (value) {
    await appSettingsApi.set(APP_SETTING_KEYS.inlineChatSelectedModel, value);
  } else {
    await appSettingsApi.remove(APP_SETTING_KEYS.inlineChatSelectedModel);
  }
}

watch(selectedModel, value => {
  if (persistenceReady) void persistSelectedModel(value);
});

onMounted(() => {
  void readPersistedModel().then((value) => {
    selectedModel.value = value;
    persistenceReady = true;
  });
  const requestId = ++latestModelsRequest;
  void aiModelApi.listConnectedModels().then((nextModels) => {
    if (requestId === latestModelsRequest) {
      setModels(nextModels);
    }
  });
  disposeConnectedModelsListener = aiModelApi.onConnectedModelsChanged((nextModels) => {
    latestModelsRequest += 1;
    setModels(nextModels);
  });
  disposeSettingsListener = appSettingsApi.onChanged((event) => {
    if (event.key === APP_SETTING_KEYS.inlineChatSelectedModel) {
      selectedModel.value = event.value;
    }
  });
});

onBeforeUnmount(() => {
  disposeConnectedModelsListener?.();
  disposeSettingsListener?.();
});

async function handleAddModel(): Promise<void> {
  menuOpen.value = false;
  await windowApi.openSettings('ai-model');
}
</script>

<template>
  <WsDropdownMenu
    v-model="selectedModel"
    v-model:open="menuOpen"
    :items="groupedModelOptions"
    item-title="title"
    item-value="value"
    panel-align="end"
    close-on-scroll
  >
    <template #trigger>
      <button
        aria-haspopup="menu"
        class="ws-inline-chat-model__trigger ws-no-text-selection"
        :class="{ 'ws-inline-chat-model__trigger--open': menuOpen }"
        type="button"
      >
        <span class="ws-inline-chat-model__selection">
          <span v-if="selectedModelOption" class="ws-inline-chat-model__selection-title">
            {{ selectedModelOption.name || selectedModelOption.id }}
          </span>
          <span v-else class="ws-inline-chat-model__selection-placeholder">选择模型</span>
        </span>
        <span aria-hidden="true" class="ws-inline-chat-model__arrow icon" :class="arrowIcon" />
      </button>
    </template>
    <template #item="{ props: itemProps, item }">
      <div class="ws-inline-chat-model__item" role="presentation">
        <div
          v-if="Boolean((item.raw as { isGroupStart?: boolean }).isGroupStart)"
          class="ws-inline-chat-model__group-title"
          role="presentation"
        >
          {{ getModelField(item.raw, 'groupName') }}
        </div>
        <button
          v-bind="itemProps"
          class="ws-inline-chat-model__option"
          type="button"
        >
          <span class="ws-inline-chat-model__option-title">{{ getModelField(item.raw, 'title') }}</span>

        </button>
      </div>
    </template>
    <template #prepend>
      <div class="ws-inline-chat-model__search">
        <WsSearchInput
          v-model="search"
          aria-label="搜索模型"
          placeholder="搜索模型"
        />
      </div>
    </template>
    <template #append>
      <a class="ws-inline-chat-model__add" href="#add-model" @click.prevent="handleAddModel">
        <span :class="addIcon" aria-hidden="true" />
        <span>添加模型</span>
      </a>
    </template>
  </WsDropdownMenu>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as variables;
@use '@/assets/styles/mixins' as mixins;

.ws-inline-chat-model__search {
  width: 100%;

}

.ws-inline-chat-model__search :deep(.v-input),
.ws-inline-chat-model__search :deep(.v-input__control),
.ws-inline-chat-model__search :deep(.v-field) {
  height: variables.$select-trigger-height;
  min-height: variables.$select-trigger-height;
  margin-bottom: variables.$menu-compact-spacing;
    border: none;
}

.ws-inline-chat-model__search :deep(.v-field__input) {
  min-height: variables.$select-trigger-height;
  padding-top: 0;
  padding-bottom: 0;
}

.ws-inline-chat-model__option,
.ws-inline-chat-model__selection {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: variables.$spacing-xs;

}

.ws-inline-chat-model__trigger {
  display: flex;
  width: 100%;
  min-width: 0;
  height: variables.$select-trigger-height;
  align-items: center;
  justify-content: space-between;
  gap: variables.$spacing-2xs;
  padding: 0 variables.$select-trigger-padding-inline;
  border: 1px solid transparent;
  border-radius: variables.$select-surface-radius;
  outline: none;
  color: var(--ws-select-foreground, var(--ws-foreground));
  font: inherit;
  font-size: variables.$select-trigger-font-size;
  line-height: normal;
  text-align: start;
  cursor: pointer;
}

.ws-inline-chat-model__trigger:hover,
.ws-inline-chat-model__trigger:focus-visible,
.ws-inline-chat-model__trigger--open {
  border-color: var(--ws-select-border, var(--ws-border));
}

.ws-inline-chat-model__arrow {
  @include mixins.flex-center;
  flex: 0 0 variables.$select-trigger-arrow-size;
  width: variables.$select-trigger-arrow-size;
  height: variables.$select-trigger-arrow-size;
  color: currentColor;
  font-size: variables.$select-trigger-arrow-size;
  line-height: 1;
}

.ws-inline-chat-model__item {
  display: block;
  width: 100%;
  min-width: 0;
}

.ws-inline-chat-model__group-title {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  padding: variables.$menu-compact-spacing;
  color: var(--ws-descriptionForeground);
  font-size: variables.$font-size-xs;
  line-height: normal;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-inline-chat-model__option {
  width: 100%;
  min-height: variables.$select-menu-item-height;
  padding: 0 variables.$spacing-sm;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.ws-inline-chat-model__option:hover,
.ws-inline-chat-model__option:focus-visible,
.ws-inline-chat-model__option.ws-dropdown-menu__item--active,
.ws-inline-chat-model__option.ws-dropdown-menu__item--selected {
  background: var(--ws-menu-hoverBackground, var(--ws-list-hoverBackground));
}

.ws-inline-chat-model__option-title,
.ws-inline-chat-model__option-group,
.ws-inline-chat-model__selection-title,
.ws-inline-chat-model__selection-group {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-inline-chat-model__option-title,
.ws-inline-chat-model__option-group,
.ws-inline-chat-model__selection-title,
.ws-inline-chat-model__selection-group {
  min-width: 0;
}

.ws-inline-chat-model__option-title,
.ws-inline-chat-model__selection-title {
  flex: 1 1 auto;
}

.ws-inline-chat-model__option-group,
.ws-inline-chat-model__selection-group {
  flex: 0 1 45%;
  margin-inline-start: auto;
  color: var(--ws-descriptionForeground);
}

.ws-inline-chat-model__add {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: variables.$spacing-2xs;
  width: 100%;
  padding: variables.$spacing-2xs variables.$spacing-xs;
  color: var(--ws-link-linkForeground);
  text-decoration: none;
  margin-top: variables.$menu-compact-spacing;
  &:hover{
    color: var(--ws-link-hoverFackground);
  }
}
.ws-inline-chat-model__add > span:first-child {
  @include mixins.flex-center;
  width: variables.$select-icon-size;
  height: variables.$select-icon-size;
  font-size: variables.$select-icon-size;
  line-height: 1;
}
</style>
