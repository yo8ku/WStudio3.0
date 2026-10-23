<script setup lang="ts">
/**
 * 文件说明：提供带遮罩、关闭按钮和可配置隐式关闭行为的基础对话框。
 */
import { computed, onMounted, onBeforeUnmount, watch, useAttrs, useSlots } from 'vue';

const closeIcon = 'icon icon-close';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';

defineOptions({
  inheritAttrs: false
});

interface WsDialogProps {
  modelValue: boolean;
  title: string;
  width?: string | number;
  persistent?: boolean;
  /** 是否允许点击遮罩或按 Escape 关闭，关闭按钮仍遵循 persistent。 */
  dismissible?: boolean;
  closeLabel: string;
}

const props = withDefaults(defineProps<WsDialogProps>(), {
  persistent: false,
  dismissible: true
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  close: [];
}>();

const slots = useSlots();
const attrs = useAttrs();

const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});



/** 按 Escape 键关闭非持久化对话框 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.dismissible && !props.persistent && isOpen.value) {
    emit('close');
    isOpen.value = false;
  }
}

/** 关闭对话框 */
function closeDialog(): void {
  if (!props.persistent) {
    emit('close');
    isOpen.value = false;
  }
}

/** 仅在允许隐式关闭时响应遮罩点击。 */
function handleBackdropPointerdown(): void {
  if (props.dismissible) closeDialog();
}

/** 打开时锁定 body 滚动 */
function lockBodyScroll(): void {
  document.body.style.overflow = 'hidden';
}

/** 关闭时恢复 body 滚动 */
function unlockBodyScroll(): void {
  document.body.style.overflow = '';
}

watch(() => props.modelValue, (open) => {
  if (open) {
    lockBodyScroll();
  } else {
    unlockBodyScroll();
  }
}, { immediate: true });

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
  unlockBodyScroll();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ws-dialog">
      <div v-if="isOpen" class="ws-dialog-layer">
        <div class="ws-dialog__backdrop" aria-hidden="true" @pointerdown="handleBackdropPointerdown" />
        <div
          v-bind="attrs"
          class="ws-dialog"
          role="dialog"
          :aria-label="props.title || (typeof attrs['aria-label'] === 'string' ? attrs['aria-label'] : undefined)"
        >
        <header class="ws-dialog__header">
          <h2 class="ws-dialog__title">{{ props.title }}</h2>
          <div class="ws-dialog__header-actions">
            <slot name="title-actions" />
            <WsIconButton
              class="ws-dialog__close"
              density="comfortable"
              :icon="closeIcon"
              :label="props.closeLabel"
              :ripple="false"
              variant="text"
              @click="closeDialog"
            />
          </div>
        </header>
        <div class="ws-dialog__body">
          <slot />
        </div>
        <footer v-if="slots.actions" class="ws-dialog__actions">
          <slot name="actions" />
        </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ws-dialog {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 1;
  display: flex;
  flex-direction: column;
  min-width: 25rem;
  max-width: 90vw;
  max-height: 90vh;
  border: $editor-table-border-width solid var(--ws-dialog-border, var(--ws-border));
  border-radius: $radius-xs;
  background: var(--ws-dialog-background);
  box-shadow: 0 0.5rem 2rem rgba(0, 0, 0, 0.3);
  color: var(--ws-foreground);
  transform: translate(-50%, -50%);
}

.ws-dialog-layer {
  position: fixed;
  z-index: 2000;
  inset: 0;
}

.ws-dialog__backdrop {
  position: absolute;
  inset: 0;
  background: var(--ws-dialog-backdrop, rgb(0 0 0 / 0.35));
}

.ws-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-md;
  min-height: 2.5rem;
  padding: 0.3rem;
  border-top-left-radius: 0.25rem;
  border-top-right-radius: 0.25rem;
  border-bottom: 1px solid var(--ws-border);
  background: var(--ws-titleBar-activeBackground);
}

.ws-dialog__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ws-foreground);
  font-size: $font-size-sm;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 5px;
}

.ws-dialog__header-actions {
  display: flex;
  align-items: center;
  gap: $spacing-2xs;
}

.ws-dialog__header-actions :deep(.ws-icon-button){
   height: 1.5rem;
}

.ws-dialog__close:hover,
.ws-dialog__close:focus-visible {
  color: var(--ws-foreground);
  background: var(--ws-button-hoverBackground);
}

.ws-dialog__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: $spacing-xs;
}

.ws-dialog__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: $spacing-xs;
  padding: 3px;
  border-top: $editor-table-border-width solid var(--ws-border);
}


</style>
