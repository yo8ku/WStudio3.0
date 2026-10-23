<!-- 文件说明：渲染宿主统一上下文菜单，供所有标签页菜单浮层共用。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import WorkbenchContextMenuEntryView from '@/components/workbench/WorkbenchContextMenuEntry.vue';
import type { WorkbenchContextMenuEntry } from '@/types/ipc';

const props = defineProps<{
  items: readonly WorkbenchContextMenuEntry[];
  x: number;
  y: number;
}>();

const emit = defineEmits<{
  select: [actionId: string];
  dismiss: [];
}>();

const rootElement = ref<HTMLElement>();
const menuSurface = ref<HTMLElement>();
const menuLeft = ref(props.x);
const menuTop = ref(props.y);
const menuListProps = {
  density: 'compact',
  nav: false
} as const;
const menuPositionStyle = computed(() => ({
  left: `${menuLeft.value}px`,
  top: `${menuTop.value}px`
}));

/** 在菜单即将越过窗口边缘时改为向左或向上展开。 */
async function placeMenu(): Promise<void> {
  menuLeft.value = props.x;
  menuTop.value = props.y;
  await nextTick();
  const element = menuSurface.value;
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  menuLeft.value = props.x + bounds.width <= window.innerWidth
    ? props.x
    : Math.max(0, props.x - bounds.width);
  menuTop.value = props.y + bounds.height <= window.innerHeight
    ? props.y
    : Math.max(0, props.y - bounds.height);
}

/** 关闭菜单且不提交动作。 */
function dismissMenu(): void {
  emit('dismiss');
}

watch(() => [props.x, props.y, props.items], () => {
  void placeMenu();
}, { deep: true });

onMounted(() => {
  rootElement.value?.focus();
  void placeMenu();
});
</script>

<template>
  <main
    ref="rootElement"
    class="workbench-context-menu"
    tabindex="-1"
    @contextmenu.prevent
    @keydown.esc="dismissMenu"
    @pointerdown.self="dismissMenu"
  >
    <section
      ref="menuSurface"
      class="ws-menu workbench-context-menu__surface"
      :style="menuPositionStyle"
    >
      <v-list v-bind="menuListProps">
        <template v-for="item in items" :key="item.id">
          <!-- S = 统一菜单条目 -->
          <WorkbenchContextMenuEntryView :item="item" @select="emit('select', $event)" />
          <!-- E = 统一菜单条目 -->
        </template>
      </v-list>
    </section>
  </main>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.workbench-context-menu {
  position: fixed;
  inset: 0;
  z-index: $workbench-context-menu-z-index;
  outline: none;
  background: transparent;
}

.workbench-context-menu__surface {
  position: fixed;
  min-width: $editor-context-menu-min-width;
  max-width: calc(100vw - $spacing-sm);
  max-height: calc(100vh - $spacing-sm);
  overflow-y: auto;
}

.workbench-context-menu__surface,
.workbench-context-menu__surface *,
:global(.workbench-context-menu__submenu),
:global(.workbench-context-menu__submenu *) {
  transition: none !important;
  animation: none !important;
}

.workbench-context-menu__surface :deep(.v-list-item) {
  margin-inline: $spacing-2xs;
  border-radius: $radius-2px !important;
}
</style>
