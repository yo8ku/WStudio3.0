<!--
  文件说明：提供工作台统一对话框外壳，通过插槽承载输入、列表、确认等业务内容。
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { CSSProperties } from 'vue';

interface WorkbenchDialogProps {
  modelValue: boolean;
  title?: string;
  subtitle?: string;
  persistent?: boolean;
  contentClass?: string;
  height?: string | number;
  maxHeight?: string | number;
  maxWidth?: string | number;
  noClickAnimation?: boolean;
  width?: string | number;
  transition?: false | string;
  scrim?: boolean | string;
}

const props = withDefaults(defineProps<WorkbenchDialogProps>(), {
  subtitle: undefined,
  persistent: false,
  contentClass: undefined,
  height: undefined,
  maxHeight: undefined,
  maxWidth: 'var(--ws-workbench-dialog-width)',
  noClickAnimation: false,
  width: undefined,
  transition: undefined,
  scrim: true
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  keydown: [event: KeyboardEvent];
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});
const dialogProps = computed(() => ({
  attach: 'body' as const,
  contentClass: ['ws-dialog', 'workbench-dialog', props.contentClass].filter(Boolean).join(' '),
  height: props.height,
  location: 'center' as const,
  maxHeight: props.maxHeight,
  maxWidth: props.maxWidth,
  noClickAnimation: props.noClickAnimation,
  persistent: props.persistent,
  scrim: props.scrim,
  transition: props.transition,
  width: props.width
}));
const cardStyle = computed<CSSProperties | undefined>(() => {
  if (
    props.width === undefined
    && props.height === undefined
    && props.maxHeight === undefined
    && props.maxWidth === undefined
  ) {
    return undefined;
  }

  return {
    ...(props.width !== undefined
      ? { width: typeof props.width === 'number' ? `${props.width}px` : props.width }
      : {}),
    ...(props.height !== undefined
      ? { height: typeof props.height === 'number' ? `${props.height}px` : props.height }
      : {}),
    ...(props.maxHeight !== undefined
      ? { maxHeight: typeof props.maxHeight === 'number' ? `${props.maxHeight}px` : props.maxHeight }
      : {}),
    ...(props.maxWidth !== undefined
      ? { maxWidth: typeof props.maxWidth === 'number' ? `${props.maxWidth}px` : props.maxWidth }
      : {})
  };
});

/** 将对话框内部键盘事件交给具体业务窗口处理。 */
function handleKeydown(event: KeyboardEvent): void {
  emit('keydown', event);
}
</script>

<template>
  <v-dialog v-model="isOpen" v-bind="dialogProps">
    <v-card
      class="workbench-dialog__card"
      :style="cardStyle"
      tabindex="-1"
      @keydown.capture="handleKeydown"
    >
      <v-card-title v-if="title" class="workbench-dialog__title">
        <span>{{ title }}</span>
        <div v-if="$slots['title-actions']" class="workbench-dialog__title-actions">
          <slot name="title-actions" />
        </div>
      </v-card-title>
      <v-card-subtitle v-if="subtitle" class="workbench-dialog__subtitle">
        {{ subtitle }}
      </v-card-subtitle>
      <v-card-text class="workbench-dialog__content">
        <slot />
      </v-card-text>
      <v-card-actions v-if="$slots.actions" class="workbench-dialog__actions">
        <slot name="actions" />
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.workbench-dialog__card {
  width: $workbench-dialog-imgSize-width;
  max-width: calc(100vw - #{$spacing-lg});
  max-height: calc(100vh - #{$spacing-lg});
  overflow: hidden;
  border: $input-border-width solid var(--ws-border);
  border-radius: $input-border-radius;
  color: var(--ws-foreground);
  background: var(--ws-dialog-background);

}

.workbench-dialog__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-sm;
  font-size: $font-size-md;
  height: 30px;
  background: var(--ws-dialog-titleBackground);
    border-bottom:1px solid var(--ws-border);
}

.workbench-dialog__actions :deep(button){
  height: 1.8rem;
}



.workbench-dialog__title-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.workbench-dialog__subtitle {
  padding-inline: $spacing-lg;
  color: var(--ws-descriptionForeground);
}

.workbench-dialog__content {
  padding: $spacing-sm !important;
  gap: 8px;
  display: grid;
}

.workbench-dialog__actions {
  padding:0  $spacing-md;
  min-height: 40px;
}
</style>
