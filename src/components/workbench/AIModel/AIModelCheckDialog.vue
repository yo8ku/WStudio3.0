<script setup lang="ts">
/**
 * 文件说明：提供 AI API 密钥检测前的模型选择弹窗。
 */
import { computed, ref, watch } from 'vue';

import WsSelect from '@/components/WsSelect/WsSelect.vue';
import WsDialog from '@/components/WsDialog/WsDialog.vue';
import WsProgressCircular from '@/components/WsProgressCircular/WsProgressCircular.vue';
import type { AiModel } from '@/types/aiModel';

interface AIModelCheckDialogProps {
  modelValue: boolean;
  models: readonly AiModel[];
  detecting?: boolean;
}

interface AIModelCheckOption {
  value: string;
  name: string;
  groupName: string;
}

const props = defineProps<AIModelCheckDialogProps>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  close: [];
  detect: [modelId: string];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});
const selectedModelId = ref<string | null>(null);
const modelOptions = computed<AIModelCheckOption[]>(() => props.models.map(model => {
  const name = model.name || model.id;
  const groupName = model.groupName || '未分组';

  return {
    value: model.id,
    name,
    groupName
  };
}));

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      selectFirstModel();
    }
  }
);

watch(modelOptions, () => {
  if (!modelOptions.value.some(option => option.value === selectedModelId.value)) {
    selectFirstModel();
  }
});

function selectFirstModel(): void {
  selectedModelId.value = modelOptions.value[0]?.value ?? null;
}

function getOptionText(raw: unknown, key: 'name' | 'groupName'): string {
  if (typeof raw !== 'object' || raw === null) return '';
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function handleDetect(): void {
  if (selectedModelId.value === null) {
    return;
  }

  emit('detect', selectedModelId.value);
}

</script>

<template>
  <WsDialog
    :model-value="isOpen"
    close-label="关闭检测 API 密钥弹窗"
    title="检测 API 密钥"
    width="26rem"
    @update:model-value="isOpen = $event"
    @close="emit('close')"
  >
    <div class="ai-model-check-dialog__form">
      <label
        class="ai-model-check-dialog__label"
        for="ai-model-check-dialog-model"
      >模型</label>
      <WsSelect
        id="ai-model-check-dialog-model"
        v-model="selectedModelId"
        aria-label="选择检测模型"
        class="ai-model-check-dialog__control"
        :disabled="props.detecting || modelOptions.length === 0"
        item-title="name"
        item-value="value"
        :items="modelOptions"
        :placeholder="modelOptions.length > 0 ? '选择模型' : '暂无可检测模型'"
      >
        <template #item="{ props: itemProps, item }">
          <button
            v-bind="itemProps"
            class="ws-select__option ai-model-check-dialog__option"
            type="button"
          >
            <span class="ai-model-check-dialog__option-name">
              {{ getOptionText(item.raw, 'name') }}
            </span>
            <span class="ai-model-check-dialog__option-group">
              {{ getOptionText(item.raw, 'groupName') }}
            </span>
          </button>
        </template>
        <template #selection="{ item }">
          <span class="ai-model-check-dialog__selection">
            <span class="ai-model-check-dialog__selection-name">
              {{ getOptionText(item.raw, 'name') }}
            </span>
            <span class="ai-model-check-dialog__selection-group">
              {{ getOptionText(item.raw, 'groupName') }}
            </span>
          </span>
        </template>
      </WsSelect>
    </div>
    <template #actions>
      <v-spacer />
      <v-btn
        :disabled="props.detecting || selectedModelId === null"
        :ripple="false"
        variant="text"
        @click="handleDetect"
      >
        <WsProgressCircular
          v-if="props.detecting"
          aria-label="正在检测 API 密钥"
          :size="14"
          :width="2"
        />
        <span v-else>确定</span>
      </v-btn>
    </template>
  </WsDialog>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ai-model-check-dialog__form {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  column-gap: $spacing-md;
  row-gap: $spacing-sm;
}

.ai-model-check-dialog__label {
  color: var(--ws-foreground);
  font-size: $font-size-sm;
  line-height: $editor-line-height;
  white-space: nowrap;
}

.ai-model-check-dialog__control {
  width: 100%;
  min-width: 0;
}

.ai-model-check-dialog__option {
  align-items: center;
  gap: $spacing-xs;
}

.ai-model-check-dialog__option-name,
.ai-model-check-dialog__selection-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-check-dialog__option-name {
  flex: 1 1 auto;
  color: var(--ws-foreground);
}

.ai-model-check-dialog__option-group {
  flex: 0 0 auto;
  min-width: 0;
  margin-inline-start: auto;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
}

.ai-model-check-dialog__selection {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: $spacing-xs;
  overflow: hidden;
}

.ai-model-check-dialog__selection-name {
  flex: 1 1 auto;
  color: var(--ws-foreground);
}

.ai-model-check-dialog__selection-group {
  flex: 0 0 auto;
  min-width: 0;
  margin-inline-start: auto;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
}

</style>
