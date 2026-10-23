<script setup lang="ts">
/**
 * 文件说明：渲染单个插件声明式设置字段，并使用 Vuetify rules 展示宿主校验结果。
 */
import { computed, ref, watch } from 'vue';

import WsInput from '@/components/WsInput/WsInput.vue';
import WsSelect from '@/components/WsSelect/WsSelect.vue';
import WsSwitch from '@/components/WsSwitch/WsSwitch.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import { workspaceApi } from '@/api/workspace';
import type {
  PluginSettingField,
  PluginSettingValue
} from '../../../plugin/sdk';
import {
  coercePluginSettingInput,
  validatePluginSettingValue
} from '../../../plugin/settings/model';

/** 单个插件设置字段的受控值和展示状态。 */
interface PluginSettingFieldItemProps {
  field: PluginSettingField;
  modelValue: PluginSettingValue;
  disabled?: boolean;
  inset?: boolean;
  loading?: boolean;
}

/** Vuetify 输入规则返回成功或可展示错误消息。 */
type PluginSettingInputRule = (value: unknown) => true | string;

const props = withDefaults(defineProps<PluginSettingFieldItemProps>(), {
  disabled: false,
  inset: false,
  loading: false
});

const emit = defineEmits<{
  change: [field: PluginSettingField, value: PluginSettingValue];
}>();

const localValue = ref<unknown>(props.modelValue);
const textFieldProps = {
  density: 'compact',
  hideDetails: 'auto',
  variant: 'outlined'
} as const;
const numberFieldProps = {
  ...textFieldProps,
  type: 'number'
} as const;
const pathButtonProps = {
  density: 'compact',
  size: 'small',
  variant: 'outlined'
} as const;
const pickerLoading = ref(false);

/** 将外部持久化快照同步到字段局部输入状态。 */
watch(() => props.modelValue, (value) => {
  localValue.value = value;
});

/** 返回当前字段供 Vuetify 输入组件执行的声明式校验规则。 */
const validationRules = computed<readonly PluginSettingInputRule[]>(() => [
  (rawValue: unknown): true | string => {
    const value = coercePluginSettingInput(props.field, rawValue);
    if (value === undefined) return getInvalidInputMessage();
    return validatePluginSettingValue(props.field, value)?.message ?? true;
  }
]);

/** 返回字段类型对应的基础输入错误文案。 */
function getInvalidInputMessage(): string {
  switch (props.field.type) {
    case 'number':
      return '请输入有效数字。';
    case 'boolean':
      return '请输入有效开关值。';
    case 'select':
      return '请选择有效选项。';
    case 'text':
      return '请输入有效文本。';
    case 'file':
      return '请选择有效文件。';
    case 'folder':
      return '请选择有效目录。';
  }
}

/** 更新局部输入并仅提交通过宿主规则的字段值。 */
function handleControlUpdate(rawValue: unknown): void {
  localValue.value = rawValue;
  const value = coercePluginSettingInput(props.field, rawValue);
  if (value === undefined || validatePluginSettingValue(props.field, value)) return;
  emit('change', props.field, value);
}

/** 将声明式字段值收窄为文本输入框可接受的字符串或数字。 */
function getInputValue(value: unknown): string | number {
  return typeof value === 'string' || typeof value === 'number' ? value : '';
}

/** 打开宿主工作区选择器并提交用户选择的相对路径。 */
async function handlePickEntry(): Promise<void> {
  if (props.field.type !== 'file' && props.field.type !== 'folder') return;
  pickerLoading.value = true;
  try {
    const options = props.field.type === 'file'
      ? { kind: 'file' as const, extensions: props.field.extensions }
      : { kind: 'folder' as const };
    const selectedPath = await workspaceApi.pickEntry(options);
    if (selectedPath !== undefined) handleControlUpdate(selectedPath);
  } finally {
    pickerLoading.value = false;
  }
}

/** 返回文件或目录字段当前的相对路径按钮文案。 */
const pathButtonLabel = computed(() => {
  if (typeof localValue.value === 'string' && localValue.value.length > 0) {
    return localValue.value;
  }
  return props.field.type === 'file' ? '选择文件' : '选择目录';
});
</script>

<template>
  <SettingsOptionItem
    :title="field.label"
    :description="field.description"
    :disabled="disabled"
    :inset="inset"
  >
    <WsInput
      v-if="field.type === 'text'"
      v-bind="textFieldProps"
      :model-value="getInputValue(localValue)"
      :aria-label="field.label"
      class="plugin-setting-field__control"
      :disabled="disabled"
      :loading="loading"
      :placeholder="field.placeholder"
      :rules="validationRules"
      @update:model-value="handleControlUpdate"
    />

    <WsInput
      v-else-if="field.type === 'number'"
      v-bind="numberFieldProps"
      :model-value="getInputValue(localValue)"
      :aria-label="field.label"
      class="plugin-setting-field__control"
      :disabled="disabled"
      :loading="loading"
      :max="field.max"
      :min="field.min"
      :rules="validationRules"
      :step="field.step"
      @update:model-value="handleControlUpdate"
    />

    <WsSwitch
      v-else-if="field.type === 'boolean'"
      :model-value="typeof localValue === 'boolean' ? localValue : false"
      :aria-label="field.label"
      :disabled="disabled"
      :loading="loading"
      @update:model-value="handleControlUpdate"
    />

    <v-btn
      v-else-if="field.type === 'file' || field.type === 'folder'"
      v-bind="pathButtonProps"
      class="plugin-setting-field__path-button"
      :disabled="disabled"
      :loading="loading || pickerLoading"
      @click="handlePickEntry"
    >
      {{ pathButtonLabel }}
    </v-btn>

    <WsSelect
      v-else
      :model-value="typeof localValue === 'string' ? localValue : null"
      :aria-label="field.label"
      class="plugin-setting-field__control"
      :disabled="disabled"
      item-title="label"
      item-value="value"
      :items="field.options"
      :loading="loading"
      :rules="validationRules"
      @update:model-value="handleControlUpdate"
    />
  </SettingsOptionItem>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.plugin-setting-field__control {
  width: $settings-option-control-width;
}

.plugin-setting-field__path-button {
  max-width: $settings-option-control-width;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: $settings-option-mobile-breakpoint) {
  .plugin-setting-field__control {
    width: $settings-option-compact-control-width;
  }

  .plugin-setting-field__path-button {
    max-width: $settings-option-compact-control-width;
  }
}
</style>
