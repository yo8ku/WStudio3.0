<!-- 文件说明：渲染宿主统一上下文菜单的单个动作、分隔线或一级子菜单。 -->
<script setup lang="ts">
import { ref } from 'vue';

const arrowForwardIcon = 'icon icon-arrow-forward';
import type { WorkbenchContextMenuAction, WorkbenchContextMenuEntry } from '@/types/ipc';

defineProps<{
  item: WorkbenchContextMenuEntry;
}>();

const emit = defineEmits<{
  select: [actionId: string];
}>();

const submenuVisible = ref(false);
const menuListProps = {
  density: 'compact',
  nav: false
} as const;
const menuItemProps = {
  ripple: false
} as const;
const submenuProps = {
  // 子菜单与宿主菜单共享层叠上下文，避免全局 Vuetify 浮层被宿主菜单覆盖。
  attach: '.workbench-context-menu',
  closeDelay: 120,
  contentClass: 'ws-menu workbench-context-menu__submenu',
  openDelay: 0,
  openOnHover: true,
  submenu: true,
  transition: false
} as const;

/** 提交当前可用的叶子菜单动作。 */
function selectAction(action: WorkbenchContextMenuAction): void {
  if (action.enabled !== false && !action.children?.length) emit('select', action.id);
}
</script>

<template>
  <v-divider v-if="item.type === 'separator'" />
  <v-menu v-else-if="item.children?.length" v-model="submenuVisible" v-bind="submenuProps">
    <template #activator="{ props: activatorProps }">
      <v-list-item
        v-bind="{ ...activatorProps, ...menuItemProps }"
        :active="submenuVisible"
        :disabled="item.enabled === false"
        :title="item.label"
      >
        <template #append>
          <span
            aria-hidden="true"
            class="workbench-context-menu-entry__arrow"
            :class="arrowForwardIcon"
          />
        </template>
      </v-list-item>
    </template>

    <v-list v-bind="menuListProps">
      <v-list-item
        v-for="child in item.children"
        :key="child.id"
        v-bind="menuItemProps"
        :disabled="child.enabled === false"
        :title="child.label"
        @click="selectAction(child)"
      />
    </v-list>
  </v-menu>
  <v-list-item
    v-else
    v-bind="menuItemProps"
    :disabled="item.enabled === false"
    :title="item.label"
    @click="selectAction(item)"
  />
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;
@use '@/assets/styles/mixins' as *;

:global(.workbench-context-menu__submenu .v-list-item) {
  margin-inline: $spacing-2xs;
  border-radius: $radius-2px !important;
}

.workbench-context-menu-entry__arrow {
  @include flex-center;
  width: $editor-context-menu-arrow-size;
  height: $editor-context-menu-arrow-size;
  color: inherit;
}

.workbench-context-menu-entry__arrow {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
