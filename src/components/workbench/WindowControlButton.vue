<script setup lang="ts">
/**
 * 文件说明：封装标题栏窗口控制按钮的尺寸、颜色和危险态样式。
 */
import { computed } from 'vue';

import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';

const props = withDefaults(
  defineProps<{
    label: string;
    icon?: string;
    danger?: boolean;
    disabled?: boolean;
  }>(),
  {
    icon: '',
    danger: false,
    disabled: false
  }
);

defineEmits<{
  click: [];
}>();

const buttonClassName = computed(() => ({
  'window-control-button--danger': props.danger
}));

const windowControlButtonVisualProps = {
  density: 'compact',
  size: 'small',
  variant: 'text'
} as const;
</script>

<template>
  <WsIconButton
    class="window-control-button"
    :class="buttonClassName"
    icon-class="window-control-button__icon"
    :icon="icon"
    :label="label"
    :disabled="props.disabled"
    v-bind="windowControlButtonVisualProps"
    @click.stop="$emit('click')"
  >
    <template v-if="$slots.icon" #icon>
      <slot name="icon" />
    </template>
  </WsIconButton>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.window-control-button {
  @include flex-center;
  @include no-drag;
  width: $window-control-size;
  min-width: $window-control-size;
  height: 100%;
  min-height: 100%;
  padding: 0;
  border-radius: $radius-none;
  color: var(--ws-foreground);
  cursor: default;
}

.window-control-button--danger:hover {
  color: #FFF;
  background: var(--ws-button-hoverBackground);
}

.window-control-button--danger:hover :deep(.v-btn__overlay) {
  background-color: var(--ws-danger-background) !important;
  opacity: 1 !important;
}

.window-control-button--danger:active :deep(.v-btn__overlay) {
  background-color: var(--ws-danger-hoverBackground) !important;
  opacity: 1 !important;
}

:deep(.window-control-button__icon) {
  @include flex-center;
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  font-size: $font-size-lg;
  line-height: 1;
  color: inherit;
}

.window-control-button :deep(.v-btn__content) {
  position: relative;
  z-index: 1;
}
</style>
