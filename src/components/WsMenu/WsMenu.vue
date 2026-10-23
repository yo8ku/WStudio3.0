<!-- 文件说明：提供工作台统一的右键菜单容器、菜单项与悬停二级菜单。 -->
<script setup lang="ts">
const checkedIcon = 'icon icon-check-gou-xuan';
const arrowForwardIcon = 'icon icon-arrow-forward';
import type { WsMenuActionItem, WsMenuItem } from './types';

interface WsMenuProps {
  target?: HTMLElement | [number, number] | null;
  items?: readonly WsMenuItem[];
  contentClass?: string;
  minWidth?: string;
  zIndex?: number;
}

const props = withDefaults(defineProps<WsMenuProps>(), {
  target: null,
  items: () => [],
  contentClass: '',
  minWidth: ''
});

const emit = defineEmits<{
  select: [itemId: string];
}>();

const open = defineModel<boolean>('open', { default: false });
const menuProps = {
  closeOnContentClick: false,
  locationStrategy: 'connected',
  location: 'bottom start',
  openOnClick: false,
  origin: 'top left',
  scrim: false,
  transition: false
} as const;
const menuListProps = {
  density: 'compact',
  nav: false
} as const;
const menuItemProps = {
  ripple: false
} as const;
const submenuProps = {
  closeDelay: 120,
  contentClass: 'ws-menu ws-menu__submenu',
  openDelay: 0,
  openOnHover: true,
  submenu: true,
  transition: false
} as const;

function selectItem(item: WsMenuActionItem): void {
  if (item.enabled === false || item.children?.length) return;
  open.value = false;
  emit('select', item.id);
}
</script>

<template>
  <v-menu
    v-model="open"
    v-bind="menuProps"
    :content-class="['ws-menu', props.contentClass].filter(Boolean).join(' ')"
    :target="props.target ?? undefined"
    :z-index="props.zIndex"
  >
    <slot v-if="$slots.default" />
    <v-list v-else v-bind="menuListProps" :style="props.minWidth ? { minWidth: props.minWidth } : undefined">
      <template v-for="item in props.items" :key="item.id">
        <v-divider v-if="item.type === 'separator'" />
        <v-menu v-else-if="item.children?.length" v-bind="submenuProps">
          <template #activator="{ props: activatorProps }">
            <v-list-item
              v-bind="{ ...activatorProps, ...menuItemProps }"
              :disabled="item.enabled === false"
              :title="item.label"
            >
              <template #prepend>
                <span class="ws-menu__check" aria-hidden="true">
                  <span v-if="item.checked" :class="checkedIcon" />
                </span>
              </template>
              <template #append>
                <span class="ws-menu__arrow" aria-hidden="true" :class="arrowForwardIcon" />
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
              :active="child.checked === true"
              :aria-checked="child.checked === true ? 'true' : 'false'"
              :role="child.checked === undefined ? 'menuitem' : 'menuitemradio'"
              @click="selectItem(child)"
            >
              <template #prepend>
                <span class="ws-menu__check" aria-hidden="true">
                  <span v-if="child.checked" :class="checkedIcon" />
                </span>
              </template>
            </v-list-item>
          </v-list>
        </v-menu>
        <v-list-item
          v-else
          v-bind="menuItemProps"
          :disabled="item.enabled === false"
          :title="item.label"
          :active="item.checked === true"
          :aria-checked="item.checked === true ? 'true' : 'false'"
          :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          @click="selectItem(item)"
        >
          <template #prepend>
            <span class="ws-menu__check" aria-hidden="true">
              <span v-if="item.checked" :class="checkedIcon" />
            </span>
          </template>
        </v-list-item>
      </template>
    </v-list>
  </v-menu>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

:global(.ws-menu__submenu .v-list-item) {
  margin-inline: $spacing-2xs;
  border-radius: $radius-2px !important;
}

.ws-menu__check,
.ws-menu__arrow {
  @include flex-center;
  width: $font-size-md;
  height: $font-size-md;
  color: inherit;
}

.ws-menu__check {
  margin-inline-end: $spacing-xs;
}

.ws-menu__check > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.ws-menu__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: $editor-context-menu-arrow-size;
  height: $editor-context-menu-arrow-size;
  font-size: $editor-context-menu-arrow-size;
  line-height: 1;
}
</style>
