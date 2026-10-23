<script setup lang="ts">
/** 文件说明：提供可复用的空白窗口基础外壳，承载极简标题栏和调用方页面内容。 */
import WorkbenchTitleBar from '@/components/workbench/WorkbenchTitleBar.vue';

withDefaults(defineProps<{
  title?: string;
  titleClass?: string;
  showWindowControls?: boolean;
  disableMaximize?: boolean;
}>(), {
  title: 'WStudio',
  showWindowControls: false,
  disableMaximize: false
});
</script>

<template>
  <section class="window-shell">
    <!-- S = 空白窗口标题栏 -->
    <WorkbenchTitleBar
      minimal
      :show-window-controls="showWindowControls"
      :disable-maximize="disableMaximize"
      :title-class="titleClass"
      :title="title"
    />
    <!-- E = 空白窗口标题栏 -->
    <main class="window-shell__content">
      <slot />
    </main>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;

.window-shell {
  @include flex-column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ws-background);
  color: var(--ws-foreground);
}

.window-shell__content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
