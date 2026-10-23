<script setup lang="ts">
/**
 * 文件说明：提供笔记属性行图标的通用操作菜单，并管理属性类型二级菜单。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

const arrowForwardIcon = '<span class="icon icon-arrow-forward"></span>';
const calendarIcon = '<span class="icon icon-calendar"></span>';
const checkboxIcon = '<span class="icon icon-check"></span>';
const checkIcon = '<span class="icon icon-check-gou-xuan"></span>';
const copyIcon = '<span class="icon icon-copy1"></span>';
const cutIcon = '<span class="icon icon-cut"></span>';
const deleteIcon = '<span class="icon icon-delete"></span>';
const infoIcon = '<span class="icon icon-info"></span>';
const listIcon = '<span class="icon icon-list"></span>';
const numberIcon = '<span class="icon icon-number1"></span>';
const pastedIcon = '<span class="icon icon-pasted"></span>';
const textIcon = '<span class="icon icon-text"></span>';
const timeIcon = '<span class="icon icon-time"></span>';
import { announceOverlayOpen, registerOverlay } from '@/utils/contextMenuCoordinator';
import {
  NOTE_PROPERTY_TYPE_DEFINITIONS,
  type NotePropertyType
} from '@editor/NoteProperties/notePropertyTypes';

/** 属性操作菜单需要的只读展示状态。 */
interface NotePropertyActionMenuProps {
  icon: string;
  label: string;
  pasteEnabled: boolean;
  propertyType: NotePropertyType;
}

const props = defineProps<NotePropertyActionMenuProps>();
const emit = defineEmits<{
  copy: [];
  cut: [];
  'menu-open': [];
  paste: [];
  remove: [];
  'select-type': [type: NotePropertyType];
}>();

const menuVisible = ref(false);
const typeMenuVisible = ref(false);
const menuOwner = {};
let disposeMenuRegistration: (() => void) | undefined;

const menuProps = {
  closeOnContentClick: false,
  contentClass: 'ws-menu note-property-action-menu',
  location: 'bottom start',
  transition: false
} as const;
const submenuProps = {
  closeDelay: 120,
  contentClass: 'ws-menu note-property-action-submenu',
  openDelay: 0,
  openOnHover: true,
  submenu: true,
  transition: false
} as const;
const listProps = {
  density: 'compact',
  nav: false
} as const;
const itemProps = {
  ripple: false
} as const;
const activatorButtonProps = {
  density: 'compact',
  icon: true,
  ripple: false,
  variant: 'text'
} as const;
const propertyTypeIcons: Readonly<Partial<Record<NotePropertyType, string>>> = {
  checkbox: checkboxIcon,
  date: calendarIcon,
  datetime: timeIcon,
  list: listIcon,
  number: numberIcon,
  text: textIcon
};
const actionIcons = {
  copy: copyIcon,
  cut: cutIcon,
  paste: pastedIcon,
  remove: deleteIcon
} as const;

/** 返回属性类型菜单使用的图标；未配置的类型保留空图标列。 */
function getPropertyTypeIcon(type: NotePropertyType): string {
  return propertyTypeIcons[type] ?? '';
}

/** 返回一级属性操作菜单对应的图标。 */
function getActionIcon(action: keyof typeof actionIcons): string {
  return actionIcons[action];
}

/** 合并 Vuetify 菜单激活器行为与图标按钮视觉配置。 */
function resolveActivatorBindings(activatorProps: Record<string, unknown>): Record<string, unknown> {
  return { ...activatorButtonProps, ...activatorProps };
}

/** 打开一级菜单时关闭其他浮层并请求刷新剪贴板状态。 */
function handleMenuVisibilityUpdate(visible: boolean): void {
  if (!visible) {
    typeMenuVisible.value = false;
    return;
  }

  announceOverlayOpen(menuOwner);
  emit('menu-open');
}

/** 关闭当前属性的一级菜单和类型二级菜单。 */
function closeMenu(): void {
  typeMenuVisible.value = false;
  menuVisible.value = false;
}

/** 选择属性类型并关闭整个菜单。 */
function selectPropertyType(type: NotePropertyType): void {
  emit('select-type', type);
  closeMenu();
}

/** 触发无参数属性操作并关闭整个菜单。 */
function invokeAction(action: 'copy' | 'cut' | 'paste' | 'remove'): void {
  if (action === 'copy') {
    emit('copy');
  } else if (action === 'cut') {
    emit('cut');
  } else if (action === 'paste') {
    emit('paste');
  } else {
    emit('remove');
  }

  closeMenu();
}

onMounted(() => {
  disposeMenuRegistration = registerOverlay(menuOwner, closeMenu);
});

onBeforeUnmount(() => {
  disposeMenuRegistration?.();
});
</script>

<template>
  <v-menu
    v-model="menuVisible"
    v-bind="menuProps"
    @update:model-value="handleMenuVisibilityUpdate"
  >
    <template #activator="{ props: activatorProps }">
      <v-btn
        v-bind="resolveActivatorBindings(activatorProps)"
        class="note-property-action-menu__activator"
        :aria-label="`打开 ${props.label} 属性菜单`"
      >
        <span
          class="note-property-action-menu__property-icon"
          aria-hidden="true"
          v-html="props.icon"
        />
      </v-btn>
    </template>

    <v-list v-bind="listProps">
      <v-menu v-model="typeMenuVisible" v-bind="submenuProps">
        <template #activator="{ props: typeActivatorProps }">
          <v-list-item
            v-bind="{ ...typeActivatorProps, ...itemProps }"
            :active="typeMenuVisible"
            title="属性类型"
          >
            <template #prepend>
              <span
                class="note-property-action-menu__type-icon"
                aria-hidden="true"
                v-html="infoIcon"
              />
            </template>
            <template #append>
              <span
                class="note-property-action-menu__arrow"
                aria-hidden="true"
                v-html="arrowForwardIcon"
              />
            </template>
          </v-list-item>
        </template>

        <v-list v-bind="listProps">
          <v-list-item
            v-for="definition in NOTE_PROPERTY_TYPE_DEFINITIONS"
            :key="definition.value"
            v-bind="itemProps"
            :title="definition.label"
            @click="selectPropertyType(definition.value)"
          >
            <template #prepend>
              <span
                class="note-property-action-menu__type-icon"
                aria-hidden="true"
                v-html="getPropertyTypeIcon(definition.value)"
              />
            </template>
            <template #append>
              <span
                v-if="props.propertyType === definition.value"
                class="note-property-action-menu__check"
                aria-hidden="true"
                v-html="checkIcon"
              />
            </template>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-list-item
        v-bind="itemProps"
        title="剪切"
        @click="invokeAction('cut')"
      >
        <template #prepend>
          <span
            class="note-property-action-menu__action-icon"
            aria-hidden="true"
            v-html="getActionIcon('cut')"
          />
        </template>
      </v-list-item>
      <v-list-item
        v-bind="itemProps"
        title="复制"
        @click="invokeAction('copy')"
      >
        <template #prepend>
          <span
            class="note-property-action-menu__action-icon"
            aria-hidden="true"
            v-html="getActionIcon('copy')"
          />
        </template>
      </v-list-item>
      <v-list-item
        v-bind="itemProps"
        :disabled="!props.pasteEnabled"
        title="粘贴"
        @click="invokeAction('paste')"
      >
        <template #prepend>
          <span
            class="note-property-action-menu__action-icon"
            aria-hidden="true"
            v-html="getActionIcon('paste')"
          />
        </template>
      </v-list-item>
      <v-divider />
      <v-list-item
        v-bind="itemProps"
        class="note-property-action-menu__remove-item"
        title="移除"
        @click="invokeAction('remove')"
      >
        <template #prepend>
          <span
            class="note-property-action-menu__action-icon"
            aria-hidden="true"
            v-html="getActionIcon('remove')"
          />
        </template>
      </v-list-item>
    </v-list>
  </v-menu>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.note-property-action-menu__activator {
  width: $note-properties-icon-size;
  min-width: $note-properties-icon-size;
  height: $note-properties-value-height;
  color: var(--ws-icon-foreground);
  background: transparent;
  border-radius: $input-border-radius;
}

.note-property-action-menu__activator:hover,
.note-property-action-menu__activator:focus-visible,
.note-property-action-menu__activator[aria-expanded='true'] {
  color: var(--ws-focusBorder);
}

.note-property-action-menu__activator :deep(.v-btn__overlay),
.note-property-action-menu__activator :deep(.v-btn__underlay) {
  display: none;
}

.note-property-action-menu__property-icon,
.note-property-action-menu__arrow,
.note-property-action-menu__type-icon,
.note-property-action-menu__action-icon,
.note-property-action-menu__check {
  @include flex-center;
  width: $icon-size-width;
  height: $icon-size-height;
}

:global(.ws-menu .note-property-action-menu__remove-item),
:global(.ws-menu .note-property-action-menu__remove-item .v-list-item-title),
:global(.ws-menu .note-property-action-menu__remove-item .note-property-action-menu__action-icon),
:global(.ws-menu .note-property-action-menu__remove-item .note-property-action-menu__action-icon svg) {
  color: var(--ws-danger-foreground) !important;
}

:global(.note-property-action-menu),
:global(.note-property-action-submenu) {
  min-width: $note-properties-menu-min-width;
}

:global(.note-property-action-menu .v-list-item__prepend) {
  margin-inline-end: $spacing-xs;
}

:global(.note-property-action-submenu .v-list-item__prepend) {
  margin-inline-end: $spacing-xs;
  width: $note-properties-menu-icon-column-width;
}
</style>
