<script setup lang="ts">
/**
 * 文件说明：渲染非编辑器类停靠面板的占位内容，并按区域角色应用主题颜色。 */
import type { DockingThreeGroupRole } from '@/DockingThree/types';

defineProps<{
  label: string;
  role: DockingThreeGroupRole;
}>();
</script>

<template>
  <v-sheet
    class="docking-three-placeholder-panel d-flex align-center justify-center fill-height rounded-0"
    :class="`docking-three-placeholder-panel--${role}`"
    elevation="0"
  >
    <span class="docking-three-placeholder-panel__label">{{ label }}</span>
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.docking-three-placeholder-panel {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--ws-backgroundAccent);
}

.docking-three-placeholder-panel--left-sidebar,
.docking-three-placeholder-panel--right-sidebar {
  background: var(--ws-sideBar-background);
  color: var(--ws-sideBar-foreground);
}

.docking-three-placeholder-panel--editor {
  background: var(--ws-editor-background);
  color: var(--ws-editor-foreground);
}

.docking-three-placeholder-panel__label {
  font-size: $font-size-lg;
  font-weight: 700;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: inherit;
}
</style>
