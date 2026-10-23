<!-- 文件说明：提供可复用的分组折叠面板，支持受控展开状态和自定义内容。 -->
<script setup lang="ts">
import { useSlots } from 'vue';

const arrowDownIcon = 'icon icon-arrow-down';

/** 手风琴分组标题与展开状态。 */
interface WsAccordionProps {
  title: string;
}

defineProps<WsAccordionProps>();

const isExpanded = defineModel<boolean>({ default: true });
const slots = useSlots();

/** 切换当前分组的展开状态。 */
function toggleExpanded(): void {
  isExpanded.value = !isExpanded.value;
}
</script>

<template>
  <section class="ws-accordion">
    <div class="ws-accordion__header">
      <button
        class="ws-accordion__toggle"
        type="button"
        :aria-expanded="isExpanded"
        @click="toggleExpanded"
      >
        <span
          aria-hidden="true"
          class="ws-accordion__indicator"
          :class="[arrowDownIcon, { 'ws-accordion__indicator--expanded': isExpanded }]"
        />
        <span class="ws-accordion__title">{{ title }}</span>
      </button>
      <div v-if="slots['header-actions']" class="ws-accordion__header-actions">
        <slot name="header-actions" />
      </div>
    </div>
    <div v-show="isExpanded" class="ws-accordion__content">
      <slot />
    </div>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ws-accordion {
  min-width: 0;
  overflow: hidden;
  border-radius: $settings-option-list-radius;
  margin-bottom: $spacing-md;
  border: $input-border-width solid var(--ws-accordion-border, var(--ws-border));
}

.ws-accordion__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-sm;
  width: 100%;
  height: 2.5rem;
  padding-inline: $spacing-sm;
  color: var(--ws-foreground);
  background: transparent;
}

.ws-accordion__toggle {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: $spacing-xs;
  min-width: 0;
  min-height: $input-control-min-height + $spacing-md;
  padding: $spacing-xs 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ws-accordion__toggle:focus-visible {
  outline: $input-border-width solid var(--ws-input-focusBorder);
  outline-offset: $spacing-3xs;
}

.ws-accordion__title {
  min-width: 0;
  overflow: hidden;
  font-size: $font-size-08;
  font-weight: 600;
  line-height: $editor-line-height;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-accordion__indicator {
  display: block;
  flex: 0 0 auto;
  box-sizing: border-box;
  padding: $spacing-2xs;
  border-radius: $radius-xs;
  color: var(--ws-descriptionForeground);
  line-height: 0;
  transform: rotate(-90deg);
  font-size: 18px;
}

.ws-accordion__indicator--expanded {
  transform: rotate(0);
}

.ws-accordion__content {
  display: flex;
  flex-direction: column;
  padding-inline: $spacing-sm;
  padding-inline-start: $spacing-md;
  border-top: $input-border-width solid var(--ws-accordion-border, var(--ws-border));
}


.ws-accordion__header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.ws-accordion:hover .ws-accordion__header-actions,
.ws-accordion:focus-within .ws-accordion__header-actions {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
</style>
