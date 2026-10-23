<!-- 文件说明：提供日期选择器右侧可复用的紧凑时间选项列与工作台滚动条。 -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

/** 时间选项列公开参数。 */
interface WsTimeColumnProps {
  label: string;
  modelValue: string;
  options: readonly string[];
}

const props = defineProps<WsTimeColumnProps>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const listRef = ref<{ $el?: HTMLElement } | null>(null);
const listProps = {
  density: 'compact',
  nav: false
} as const;
const itemProps = {
  ripple: false
} as const;

watch(() => props.modelValue, () => {
  void scrollSelectedOptionIntoView();
}, { immediate: true });

/** 选择时间值并通知日期组件更新草稿。 */
function selectOption(value: string): void {
  emit('update:modelValue', value);
}

/** 将当前时间选项定位到列的可视区域。 */
async function scrollSelectedOptionIntoView(): Promise<void> {
  await nextTick();
  const listElement = listRef.value?.$el;
  const selectedElement = listElement?.querySelector<HTMLElement>(
    `[data-time-value="${props.modelValue}"]`
  );
  selectedElement?.scrollIntoView({ block: 'nearest' });
}
</script>

<template>
  <section class="ws-time-column">
    <header class="ws-time-column__header">{{ label }}</header>
    <v-list
      ref="listRef"
      v-bind="listProps"
      class="ws-time-column__list"
      :aria-label="`${label}选项`"
    >
      <v-list-item
        v-for="option in options"
        :key="option"
        v-bind="itemProps"
        :active="option === modelValue"
        :data-time-value="option"
        @click="selectOption(option)"
      >
        <span class="ws-time-column__value">{{ option }}</span>
      </v-list-item>
    </v-list>

  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.ws-time-column {
  position: relative;
  display: grid;
  grid-template-rows: $ws-date-picker-time-header-height minmax(0, 1fr);
  width: $ws-date-picker-time-column-width;
  min-width: $ws-date-picker-time-column-width;
  min-height: 0;
}

.ws-time-column__header {
  @include flex-center;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
}

.ws-time-column__list {
  min-height: 0;
  padding: 0;
  overflow-y: auto;
  scrollbar-width: none;
  background: transparent;
}

.ws-time-column__list::-webkit-scrollbar {
  display: none;
}

.ws-time-column__list :deep(.v-list-item) {
  @include flex-center;
  width: $ws-date-picker-time-option-width;
  min-width: $ws-date-picker-time-option-width;
  min-height: $ws-date-picker-time-item-height;
  height: $ws-date-picker-time-item-height;
  margin-inline: auto;
  padding-inline: $spacing-2xs;
  border-radius: $radius-2px;
}

.ws-time-column__list :deep(.v-list-item__content) {
  @include flex-center;
  font-size: $font-size-xs;
}

.ws-time-column__list :deep(.v-list-item--active) {
  background: var(--ws-datePiker-selectedBackground);
  color: var(--ws-button-foreground);
}

.ws-time-column__list :deep(.v-list-item--active .v-list-item__overlay) {
  display: none;
}

.ws-time-column__value {
  line-height: $ws-date-picker-time-item-height;
}

</style>
