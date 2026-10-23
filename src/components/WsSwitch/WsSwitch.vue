<script setup lang="ts">
/**
 * 文件说明：封装应用统一的二态开关，并集中应用主题配色与 Vuetify 展示配置。
 */
import { computed, useAttrs } from 'vue';

/** 通用开关支持的受控状态属性。 */
interface WsSwitchProps {
  modelValue: boolean;
  disabled?: boolean;
  loading?: boolean | string;
}

const props = withDefaults(defineProps<WsSwitchProps>(), {
  disabled: false,
  loading: false
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

defineOptions({ inheritAttrs: false });

const attrs = useAttrs();
const switchDisplayProps = {
  density: 'compact',
  hideDetails: true,
  inset: true,
  ripple: false
} as const;
const resolvedSwitchProps = computed(() => ({
  ...attrs,
  ...switchDisplayProps
}));

/** 将 Vuetify 的宽类型模型值收窄为应用使用的布尔状态。 */
function handleModelValueUpdate(value: unknown): void {
  if (typeof value === 'boolean' && value !== props.modelValue) {
    emit('update:modelValue', value);
  }
}

</script>

<template>
  <v-switch
    v-bind="resolvedSwitchProps"
    class="ws-switch"
    :disabled="disabled"
    :loading="loading"
    :model-value="modelValue"
    @update:model-value="handleModelValueUpdate"
  />
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ws-switch {
  --v-focus-opacity: 0;
  --v-hover-opacity: 0;
  --v-selection-control-size: #{$switch-track-height};
}

.ws-switch :deep(.v-switch__track) {
  min-width: $switch-track-width;
  height: $switch-track-height;
  padding-inline: $switch-track-padding;
  opacity: 1;
  background-color: var(--ws-switch-background);
}

.ws-switch.v-switch--inset :deep(.v-switch__thumb) {
  width: $switch-thumb-size;
  height: $switch-thumb-size;
  transform: none;
}

.ws-switch.v-switch--inset :deep(.v-selection-control__input input) {
  width: 100%;
  height: 100%;
}

.ws-switch :deep(.v-switch__thumb) {
  background-color: var(--ws-switch-foreground);
  box-shadow: none;
  pointer-events: none;
}

.ws-switch :deep(.v-selection-control__input input) {
  z-index: 1;
  cursor: pointer;
}

.ws-switch :deep(.v-selection-control--dirty .v-switch__track) {
  background-color: var(--ws-switch-activeBackground);
}

.ws-switch :deep(.v-selection-control--dirty .v-switch__thumb) {
  background-color: var(--ws-switch-activeForeground);
}

</style>
