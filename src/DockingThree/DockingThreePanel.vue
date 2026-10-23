<script setup lang="ts">
/** Renders the shared content container and custom scrollbar for every docked panel. */
import { ref } from 'vue';

import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';

interface DockingThreePanelProps {
  scrollbarTopInset?: number;
}

const props = withDefaults(defineProps<DockingThreePanelProps>(), {
  scrollbarTopInset: 0
});

const scrollerElement = ref<HTMLElement | null>(null);
</script>

<template>
  <div class="docking-three-panel">
    <div ref="scrollerElement" class="docking-three-panel__scroller">
      <slot />
    </div>
    <WorkbenchVerticalScrollbar
      :always-visible="true"
      :scroller-element="scrollerElement"
      :top-inset="props.scrollbarTopInset"
    />
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.docking-three-panel {
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: inherit;
}

.docking-three-panel__scroller {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.docking-three-panel__scroller::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
</style>
