<!-- File purpose: renders merged sidebar tabs and their icon-button overflow menu. -->
<script setup lang="ts">
import { ref } from 'vue';

const moreVerticalIcon = 'icon icon-more-vertical';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsMenu from '@/components/WsMenu/WsMenu.vue';
import type { WsMenuItem } from '@/components/WsMenu/types';

export interface SidebarTabToolbarItem {
  readonly id: string;
  readonly label: string;
  readonly iconUrl?: string;
  readonly iconClass?: string;
  readonly active: boolean;
}

defineProps<{
  items: readonly SidebarTabToolbarItem[];
}>();

const emit = defineEmits<{
  select: [itemId: string];
  'tab-pointerdown': [itemId: string, event: PointerEvent];
  'tab-contextmenu': [itemId: string, event: MouseEvent];
}>();

const moreMenuOpen = ref(false);
const moreMenuTarget = ref<HTMLElement | null>(null);
const moreMenuItems: readonly WsMenuItem[] = [
  {
    type: 'action',
    id: 'view-mode',
    label: '视图模式',
    children: [
      { type: 'action', id: 'dock-pinned', label: '停靠固定' },
      { type: 'action', id: 'undock', label: '取消停靠' },
      { type: 'action', id: 'floating', label: '浮动' },
      { type: 'action', id: 'window', label: '窗口' }
    ]
  },
  {
    type: 'action',
    id: 'move-to',
    label: '移动至',
    children: [
      { type: 'action', id: 'left-top', label: '左侧顶部' },
      { type: 'action', id: 'left-bottom', label: '左侧底部' },
      { type: 'action', id: 'bottom-left', label: '底部左侧' },
      { type: 'action', id: 'bottom-right', label: '底部右侧' },
      { type: 'action', id: 'right-bottom', label: '右侧底部' },
      { type: 'action', id: 'right-top', label: '右侧顶部' }
    ]
  },
  {
    type: 'action',
    id: 'toolbar-mode',
    label: '工具栏',
    children: [
      { type: 'action', id: 'tab-mode', label: '标签模式' },
      { type: 'action', id: 'icon-mode', label: '图标模式', checked: true }
    ]
  },
  { type: 'action', id: 'remove-from-sidebar', label: '从侧边栏中移除' }
];

function toggleMoreMenu(event: MouseEvent): void {
  const trigger = event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : event.target instanceof Element
      ? event.target.closest<HTMLElement>('.ws-icon-button')
      : null;
  if (trigger instanceof HTMLElement) {
    moreMenuTarget.value = trigger;
  }
  moreMenuOpen.value = !moreMenuOpen.value;
}
</script>

<template>
  <div class="sidebar-tab-toolbar">
    <div class="sidebar-tab-toolbar__tabs" role="tablist">
      <WsIconButton
        v-for="item in items"
        :key="item.id"
        class="sidebar-tab-toolbar__button"
        :icon="item.iconClass"
        :icon-url="item.iconClass ? undefined : item.iconUrl"
        :label="item.label"
        :tooltip="item.label"
        :active="item.active"
        :aria-selected="item.active"
        role="tab"
        @pointerdown.stop="emit('tab-pointerdown', item.id, $event)"
        @click.stop="emit('select', item.id)"
        @contextmenu.prevent="emit('tab-contextmenu', item.id, $event)"
      />
    </div>
    <WsIconButton
      class="sidebar-tab-toolbar__more"
      :icon="moreVerticalIcon"
      label="更多选项"
      tooltip="更多选项"
      :active="moreMenuOpen"
      :aria-expanded="moreMenuOpen"
      aria-haspopup="menu"
      @click.stop="toggleMoreMenu"
    />
  </div>
  <WsMenu
    v-model:open="moreMenuOpen"
    content-class="sidebar-tab-toolbar__menu"
    :target="moreMenuTarget"
    :items="moreMenuItems"
  />
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.sidebar-tab-toolbar {
  @include flex-align-center;
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 100%;
  padding-inline: $spacing-2xs;
}

:deep(.sidebar-tab-toolbar__tabs) {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  gap: $spacing-2xs;
  overflow: hidden;
}

:deep(.sidebar-tab-toolbar__button),
:deep(.sidebar-tab-toolbar__more) {
  box-sizing: border-box;
  flex: 0 0 $button-width;
  width: $button-width;
  min-width: $button-width;
  max-width: $button-width;
  height: $button-height;
  min-height: $button-height;
  max-height: $button-height;
}

:deep(.sidebar-tab-toolbar__more) {
  margin-inline-start: $spacing-2xs;
}
</style>
