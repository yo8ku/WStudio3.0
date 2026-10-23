<script setup lang="ts">
/**
 * 文件说明：提供设置页面统一的列表区域与页面标题行。
 */
/** 设置列表的标题与无障碍名称。 */
interface SettingsOptionListProps {
  listLabel: string;
  title?: string;
}

defineProps<SettingsOptionListProps>();
</script>

<template>
  <section class="settings-option-list">
    <header
      v-if="title || $slots['title-actions'] || $slots.actions"
      class="settings-option-list__header"
    >
      <div
        v-if="title || $slots['title-actions']"
        class="settings-option-list__heading"
      >
        <h2 v-if="title">{{ title }}</h2>
        <slot
          v-if="$slots['title-actions']"
          name="title-actions"
        />
      </div>
      <slot
        v-if="$slots.actions"
        name="actions"
      />
    </header>
    <div
      class="settings-option-list__items"
      role="list"
      :aria-label="listLabel"
    >
      <slot />
    </div>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.settings-option-list {
  @include flex-column;

  min-height: 0;
  min-width: 0;
  color: var(--ws-foreground);
}

.settings-option-list__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: $spacing-md;
  line-height: $editor-heading-line-height;
}

.settings-option-list__heading {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  min-width: 0;
  gap: $spacing-2xs;
}

.settings-option-list__heading h2 {
  min-width: 0;
  margin: 0;
  font-size: $font-size-lg;
  font-weight: $editor-heading-font-weight;
  letter-spacing: 0;
  line-height: inherit;
}

.settings-option-list__items {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: visible;
  border-radius: $settings-option-list-radius;
  gap: 15px;
}
</style>
