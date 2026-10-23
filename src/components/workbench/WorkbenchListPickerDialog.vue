<!--
  文件说明：基于工作台通用对话框提供搜索、层级列表选择和键盘确认能力。
-->
<script setup lang="ts">
import { computed, ref, watch, type CSSProperties } from 'vue';

import WsInput from '@/components/WsInput/WsInput.vue';
import WorkbenchDialog from '@/components/workbench/WorkbenchDialog.vue';
import type { WorkbenchListPickerItem } from '@/types/dialog';

interface WorkbenchListPickerDialogProps {
  modelValue: boolean;
  title: string;
  subtitle?: string;
  items: readonly WorkbenchListPickerItem[];
  currentItemId?: string;
  loading?: boolean;
  pending?: boolean;
  error?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  confirmLabel?: string;
  showKeyboardHints?: boolean;
}

const props = withDefaults(defineProps<WorkbenchListPickerDialogProps>(), {
  subtitle: undefined,
  currentItemId: undefined,
  loading: false,
  pending: false,
  error: undefined,
  searchable: false,
  searchPlaceholder: '搜索',
  confirmLabel: '确定',
  showKeyboardHints: false
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [itemId: string];
}>();

const selectedItemId = ref<string>();
const searchQuery = ref('');
const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});
const visibleItems = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  return query
    ? props.items.filter(item => item.label.toLocaleLowerCase().includes(query))
    : props.items;
});
const selectedItem = computed(() => props.items.find(item => item.id === selectedItemId.value));
const canConfirm = computed(() => (
  Boolean(selectedItem.value)
  && !selectedItem.value?.disabled
  && selectedItemId.value !== props.currentItemId
  && !props.loading
  && !props.pending
));
const listProps = { density: 'compact', nav: false } as const;
const searchProps = {
  density: 'compact',
  hideDetails: true,
  singleLine: true,
  variant: 'outlined'
} as const;
const alertProps = { density: 'compact', type: 'error', variant: 'tonal' } as const;
const cancelButtonProps = { variant: 'text' } as const;
const confirmButtonProps = { color: 'primary', variant: 'text' } as const;

/** 打开时清理上一次选择和搜索条件。 */
watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return;
    selectedItemId.value = undefined;
    searchQuery.value = '';
  }
);

/** 返回列表项的层级缩进变量。 */
function getItemStyle(depth = 0): CSSProperties {
  return { '--workbench-picker-depth': String(depth) } as CSSProperties;
}

/** 提交当前有效选择。 */
function confirmSelection(): void {
  if (canConfirm.value && selectedItemId.value) emit('confirm', selectedItemId.value);
}

/** 关闭选择窗口。 */
function cancelSelection(): void {
  emit('update:modelValue', false);
}

/** 支持上下方向键、回车和 Escape 的统一列表交互。 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelSelection();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    confirmSelection();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const selectableItems = visibleItems.value.filter(item => !item.disabled);
  if (selectableItems.length === 0) return;
  const currentIndex = selectableItems.findIndex(item => item.id === selectedItemId.value);
  const offset = event.key === 'ArrowDown' ? 1 : -1;
  const nextIndex = Math.max(0, Math.min(selectableItems.length - 1, currentIndex + offset));
  selectedItemId.value = selectableItems[nextIndex]?.id;
}
</script>

<template>
  <WorkbenchDialog
    v-model="isOpen"
    content-class="workbench-list-picker-dialog"
    :title="title"
    :subtitle="subtitle"
    persistent
    @keydown="handleKeydown"
  >
    <WsInput
      v-if="searchable"
      v-model="searchQuery"
      v-bind="searchProps"
      class="workbench-list-picker-dialog__search"
      :placeholder="searchPlaceholder"
      autofocus
    />
    <v-progress-linear v-if="loading" indeterminate />
    <v-list v-else v-bind="listProps" class="workbench-list-picker-dialog__list">
      <v-list-item
        v-for="item in visibleItems"
        :key="item.id"
        class="workbench-list-picker-dialog__item"
        :title="item.label"
        :subtitle="item.description"
        :active="selectedItemId === item.id"
        :disabled="item.disabled"
        :style="getItemStyle(item.depth)"
        active-class="workbench-list-picker-dialog__item--active"
        @click="selectedItemId = item.id"
      >
      </v-list-item>
    </v-list>
    <v-alert v-if="error" v-bind="alertProps" class="workbench-list-picker-dialog__error">
      {{ error }}
    </v-alert>

    <template #actions>
      <aside
        v-if="showKeyboardHints"
        class="workbench-list-picker-dialog__hints"
        aria-label="键盘操作说明"
      >
        <span class="workbench-list-picker-dialog__hint"><kbd>↑↓</kbd> 导航</span>
        <span class="workbench-list-picker-dialog__hint"><kbd>↵</kbd> {{ confirmLabel }}</span>
        <span class="workbench-list-picker-dialog__hint"><kbd>esc</kbd> 退出</span>
      </aside>
      <v-spacer />
      <v-btn v-bind="cancelButtonProps" :disabled="pending" @click="cancelSelection">取消</v-btn>
      <v-btn
        v-bind="confirmButtonProps"
        :disabled="!canConfirm"
        :loading="pending"
        @click="confirmSelection"
      >
        {{ confirmLabel }}
      </v-btn>
    </template>
  </WorkbenchDialog>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.workbench-list-picker-dialog__search {
  margin-bottom: $spacing-sm;
}

.workbench-list-picker-dialog__list {
  height: $workbench-dialog-list-height;
  overflow: auto;
  border: $input-border-width solid var(--ws-border);
  border-radius: $input-border-radius;
  background: var(--ws-menu-background);
}

.workbench-list-picker-dialog__item {
  min-height: $workbench-list-picker-item-min-height;
  padding-inline-start: calc(#{$spacing-lg} + var(--workbench-picker-depth) * #{$spacing-lg});
}

.workbench-list-picker-dialog__item--active {
  color: var(--ws-foreground);
  background: var(--ws-activityBar-activeBackground);
}

.workbench-list-picker-dialog__item--active :deep(.v-list-item__overlay) {
  display: none;
}

.workbench-list-picker-dialog__error {
  margin-top: $spacing-sm;
}

.workbench-list-picker-dialog__hints {
  @include flex-align-center;
  gap: $spacing-sm;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  letter-spacing: 0;
}

.workbench-list-picker-dialog__hint {
  white-space: nowrap;
}

.workbench-list-picker-dialog__hint kbd {
  padding: 0;
  border: 0;
  color: var(--ws-focusBorder);
  background: transparent;
  font: inherit;
}
</style>
