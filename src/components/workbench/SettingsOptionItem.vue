<script setup lang="ts">
/**
 * 文件说明：渲染设置页统一的标题、描述与右侧控制组件行。
 */
/** 单个设置行的展示与交互属性。 */
interface SettingsOptionItemProps {
  title: string;
  description?: string;
  disabled?: boolean;
  inset?: boolean;
  clickable?: boolean;
  controlFullWidth?: boolean;
  verticalAlign?: 'center' | 'start';
}

const props = withDefaults(defineProps<SettingsOptionItemProps>(), {
  clickable: false,
  controlFullWidth: false,
  verticalAlign: 'center'
});

const emit = defineEmits<{
  click: [];
}>();
</script>

<template>
  <component
    :is="props.clickable ? 'button' : 'div'"
    class="settings-option-item"
    :class="{
      'settings-option-item--inset': inset,
      'settings-option-item--clickable': props.clickable,
      'settings-option-item--control-full-width': props.controlFullWidth,
      'settings-option-item--vertical-align-start': props.verticalAlign === 'start',
      'settings-option-item--disabled': disabled
    }"
    :type="props.clickable ? 'button' : undefined"
    :disabled="props.clickable ? disabled : undefined"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="props.clickable && !disabled && emit('click')"
  >
    <span class="settings-option-item__content">
      <span class="settings-option-item__title">
        <slot name="title">{{ title }}</slot>
      </span>
      <span
        v-if="description"
        class="settings-option-item__description"
      >
        {{ description }}
      </span>
    </span>
    <span
      v-if="$slots.default"
      class="settings-option-item__control"
    >
      <slot />
    </span>
  </component>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.settings-option-item {
  display: flex;
  align-items: center;
  gap: $settings-option-control-gap;
  width: 100%;
  min-height: 2.5rem;
  border: 0;
  color: var(--ws-foreground);
  background: transparent;
  font: inherit;
  line-height: $editor-line-height;
  text-align: left;
}




.settings-option-item__control :deep(.ws-select) {
  width: 180px;
}

.settings-option-item__content {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.settings-option-item__title {
  overflow: hidden;
  color: inherit;
  font-size: $font-size-sm;
  font-weight: 500;
  letter-spacing: 0;
  line-height: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-option-item__description {
  overflow: hidden;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  line-height: $editor-line-height;
  opacity: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-option-item__control {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}

.settings-option-item--inset {
  padding-inline-start: $settings-option-detail-padding-inline-start;
}

.settings-option-item--clickable {
  cursor: pointer;
}

.settings-option-item--clickable:hover {
  background: var(--ws-menu-hoverBackground);
}

.settings-option-item--control-full-width .settings-option-item__control {
  width: 100%;
}

.settings-option-item--control-full-width {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
}


.settings-option-item--vertical-align-start {
  align-items: flex-start;
}

.settings-option-item--disabled {
  cursor: default;
  opacity: 0.6;
  pointer-events: none;
  user-select: none;
}

@media (max-width: $settings-option-mobile-breakpoint) {
  .settings-option-item {
    align-items: flex-start;
  }

  .settings-option-item__control {
    flex-basis: $settings-option-compact-control-width;
  }

  .settings-option-item--control-full-width .settings-option-item__control {
    flex-basis: auto;
  }
}
</style>
