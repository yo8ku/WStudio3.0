<script setup lang="ts">
/**
 * 文件说明：封装工作台通用紧凑输入框，统一主题样式并转发内部图标插槽。
 */
import { computed, ref, useAttrs } from 'vue';

/** 通用输入框的基础交互属性，其他 Vuetify 属性通过 attrs 透传。 */
interface WsInputProps {
  autofocus?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  loading?: boolean | string;
  placeholder?: string;
  required?: boolean;
  readonly?: boolean;
  spellcheck?: boolean;
  type?: string;
  prependInnerIcon?: string;
  appendInnerIcon?: string;
}

const props = withDefaults(defineProps<WsInputProps>(), {
  autofocus: false,
  clearable: false,
  disabled: false,
  loading: false,
  placeholder: undefined,
  required: false,
  readonly: false,
  spellcheck: false,
  type: 'text',
  prependInnerIcon: undefined,
  appendInnerIcon: undefined
});

const modelValue = defineModel<string | number>({ default: '' });

defineOptions({ inheritAttrs: false });

const attrs = useAttrs();
const hasBeenFocused = ref(false);
const isFocused = ref(false);
const isRequiredEmpty = computed(() => (
  props.required && String(modelValue.value).trim().length === 0
));
const showRequiredError = computed(() => hasBeenFocused.value && !isFocused.value && isRequiredEmpty.value);
const defaultInputProps = {
  density: 'compact',
  hideDetails: true,
  variant: 'outlined'
} as const;

/** 合并基础输入配置、Vuetify 透传属性和通用交互属性。 */
const resolvedInputProps = computed(() => ({
  ...defaultInputProps,
  ...attrs,
  // 工作台输入框不参与浏览器自动填充，避免弹出历史保存信息建议。
  autocomplete: 'off',
  autofocus: props.autofocus,
  clearable: props.clearable,
  disabled: props.disabled,
  loading: props.loading,
  placeholder: props.placeholder,
  required: props.required,
  readonly: props.readonly,
  spellcheck: props.spellcheck,
  type: props.type,
  ...(props.prependInnerIcon
    ? { 'prepend-inner-icon': props.prependInnerIcon }
    : {}),
  ...(props.appendInnerIcon
    ? { 'append-inner-icon': props.appendInnerIcon }
    : {})
}));
</script>

<template>
  <v-text-field
    v-bind="resolvedInputProps"
    v-model="modelValue"
    class="ws-input"
    :class="{ 'ws-input--invalid': showRequiredError }"
    @focus="hasBeenFocused = true; isFocused = true"
    @blur="isFocused = false"
  >
    <template v-if="$slots['prepend-inner']" #prepend-inner="slotProps">
      <slot name="prepend-inner" v-bind="slotProps" />
    </template>

    <template v-if="$slots['append-inner']" #append-inner="slotProps">
      <slot name="append-inner" v-bind="slotProps" />
    </template>
  </v-text-field>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ws-input {
  width: 100%;
}

.ws-input :deep(.v-field--variant-outlined) {
  box-sizing: border-box;
  border: $input-border-width solid var(--ws-input-border);
  border-radius: $input-border-radius;
}

.ws-input :deep(.v-field--variant-outlined .v-field__outline) {
  display: none;
}

.ws-input :deep(.v-field--variant-outlined.v-field--focused) {
  border-color: var(--ws-input-focusBorder);
}

.ws-input--invalid :deep(.v-field--variant-outlined),
.ws-input--invalid :deep(.v-field--variant-outlined.v-field--focused) {
  border-color: #a73535;
}

.ws-input :deep(.v-field__input) {
  min-height: $input-control-min-height;
  font-size: small;
}

.ws-input :deep(.v-field__prepend-inner),
.ws-input :deep(.v-field__append-inner) {
  gap: $spacing-2xs;
}
</style>
