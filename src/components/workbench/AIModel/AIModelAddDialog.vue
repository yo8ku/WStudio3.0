<script setup lang="ts">
/**
 * 文件说明：复用 AI 模型新增/编辑弹窗，收集模型标识、名称、分组与端点协议。
 */
import { computed, ref, watch } from 'vue';

import WsInput from '@/components/WsInput/WsInput.vue';
import WsSelect from '@/components/WsSelect/WsSelect.vue';
import WsDialog from '@/components/WsDialog/WsDialog.vue';
import {
  AI_MODEL_ENDPOINT_TYPE_LABELS,
  AI_MODEL_ENDPOINT_TYPES,
  type AiModel,
  type AiModelEndpointType,
  type CreateAiModelRequest
} from '@/types/aiModel';

interface AIModelAddDialogProps {
  modelValue: boolean;
  editingModel?: AiModel | null;
  groupNames?: readonly string[];
  saving?: boolean;
  error?: string;
}

const props = withDefaults(defineProps<AIModelAddDialogProps>(), {
  editingModel: null,
  groupNames: () => [],
  saving: false,
  error: undefined
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  save: [model: CreateAiModelRequest, originalId?: string];
}>();

const endpointTypes = AI_MODEL_ENDPOINT_TYPES.map(value => ({
  label: AI_MODEL_ENDPOINT_TYPE_LABELS[value],
  value
}));

const modelId = ref('');
const modelName = ref('');
let synchronizedModelName = '';
const groupName = ref('');
const selectedGroupName = ref<string | null>(null);
const endpointType = ref<AiModelEndpointType>(endpointTypes[0].value);
const isEditMode = computed(() => props.editingModel !== null);
const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});
const hasExistingGroups = computed(() => props.groupNames.length > 0);
const canSave = computed(() => !props.saving && modelId.value.trim().length > 0);
const saveButtonProps = computed(() => ({
  color: 'primary',
  loading: props.saving,
  ripple: false,
  variant: 'text'
} as const));

watch(
  [() => props.modelValue, () => props.editingModel],
  ([visible]) => {
    if (visible) {
      resetDraft();
    }
  }
);

/** 模型名称尚未被单独编辑时，持续跟随模型 ID 自动填充。 */
watch(modelId, (id) => {
  const name = id.trim();
  if (modelName.value === '' || modelName.value === synchronizedModelName) {
    modelName.value = name;
    synchronizedModelName = name;
  }
});

/** 将下拉选择的已有分组同步到可编辑的分组名称输入框。 */
watch(selectedGroupName, (selectedGroup) => {
  if (selectedGroup !== null) {
    groupName.value = selectedGroup;
  }
});

/** 手动修改分组名称后，不再保留先前下拉选择的状态。 */
watch(groupName, (name) => {
  if (selectedGroupName.value !== null && name !== selectedGroupName.value) {
    selectedGroupName.value = null;
  }
});

function resetDraft(): void {
  const model = props.editingModel;
  const initialModelName = model?.name ?? '';
  const initialGroupName = model?.groupName ?? '';

  modelId.value = model?.id ?? '';
  modelName.value = initialModelName;
  synchronizedModelName = model && initialModelName === model.id ? initialModelName : '';
  groupName.value = initialGroupName;
  selectedGroupName.value = initialGroupName && props.groupNames.includes(initialGroupName)
    ? initialGroupName
    : null;
  endpointType.value = model?.endpointType ?? endpointTypes[0].value;
}

function handleSave(): void {
  const id = modelId.value.trim();

  if (!id) {
    return;
  }

  emit('save', {
    id,
    name: modelName.value.trim(),
    groupName: groupName.value.trim(),
    endpointType: endpointType.value
  }, props.editingModel?.id);
}
</script>

<template>
  <WsDialog
    v-model="isOpen"
    class="ai-model-add-dialog"
    :close-label="isEditMode ? '关闭编辑模型弹窗' : '关闭添加模型弹窗'"
    :title="isEditMode ? '编辑模型' : '添加模型'"
  >
    <p v-if="props.error" class="ai-model-add-dialog__error" role="alert">
      {{ props.error }}
    </p>
    <div class="ai-model-add-dialog__form">
      <label class="ai-model-add-dialog__label" for="ai-model-add-dialog-model-id">模型ID</label>
      <WsInput
        id="ai-model-add-dialog-model-id"
        v-model="modelId"
        aria-label="模型ID"
        autofocus
        class="ai-model-add-dialog__control"
        :disabled="props.saving"
        placeholder="必填，例如：gpt-5.1"
        required
      />
      <label class="ai-model-add-dialog__label" for="ai-model-add-dialog-model-name">模型名称</label>
      <WsInput
        id="ai-model-add-dialog-model-name"
        v-model="modelName"
        aria-label="模型名称"
        class="ai-model-add-dialog__control"
        :disabled="props.saving"
        placeholder="例如 GPT-5"
      />
      <label class="ai-model-add-dialog__label" for="ai-model-add-dialog-group-name">分组名称</label>
      <div class="ai-model-add-dialog__group-control">
        <WsInput
          id="ai-model-add-dialog-group-name"
          v-model="groupName"
          aria-label="分组名称"
          class="ai-model-add-dialog__control"
          :disabled="props.saving"
          placeholder="输入分组名称"
        />
        <WsSelect
          id="ai-model-add-dialog-group-picker"
          v-model="selectedGroupName"
          aria-label="选择分组"
          class="ai-model-add-dialog__control"
          :disabled="props.saving || !hasExistingGroups"
          :items="props.groupNames"
          :placeholder="hasExistingGroups ? '选择分组' : '暂无分组'"
        />
      </div>
      <label class="ai-model-add-dialog__label" for="ai-model-add-dialog-endpoint-type">端点类型</label>
      <WsSelect
        id="ai-model-add-dialog-endpoint-type"
        v-model="endpointType"
        aria-label="端点类型"
        class="ai-model-add-dialog__control"
        :disabled="props.saving"
        item-title="label"
        item-value="value"
        :items="endpointTypes"
      />
    </div>

    <template #actions>
      <v-spacer />
      <v-btn
        v-bind="saveButtonProps"
        :disabled="!canSave"
        @click="handleSave"
      >
        {{ isEditMode ? '保存' : '添加' }}
      </v-btn>
    </template>
  </WsDialog>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ai-model-add-dialog__form {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  column-gap: $spacing-md;
  row-gap: $spacing-sm;
  line-height: $editor-line-height;
}

.ai-model-add-dialog__error {
  margin: 0 0 $spacing-sm;
  color: var(--ws-errorForeground);
  font-size: $font-size-sm;
  line-height: $editor-line-height;
}

.ai-model-add-dialog__control {
  width: 100%;
  min-width: 0;
}

.ai-model-add-dialog__control.ws-select {
  height: $input-control-min-height;
}

.ai-model-add-dialog__control.ws-select :deep(.ws-select__trigger) {
  height: 100%;
}

.ai-model-add-dialog__group-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax($ai-model-group-selector-min-width, 40%);
  gap: $spacing-xs;
  min-width: 0;
}

.ai-model-add-dialog__label {
  white-space: nowrap;
  color: var(--ws-foreground);
  font-size: $font-size-sm;
  line-height: $editor-line-height;
}

// 保证弹窗垂直居中后控件落在整数像素，避免边框抗锯齿到上下两行。
:global(.ws-dialog.ai-model-add-dialog > .ws-dialog__actions) {
  padding-bottom: 4px;
}
</style>
