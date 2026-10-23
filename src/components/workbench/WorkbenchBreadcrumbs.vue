<script setup lang="ts">
/**
 * 文件说明：为编辑器标签页提供路径导航面包屑的纯展示组件。
 */
import { computed, nextTick, ref, watch } from 'vue';

const arrowForwardIcon = 'icon icon-arrow-forward';
const documentIcon = 'icon icon-document';
import { useThemeStore } from '@/store/theme';
const folderIcon = 'icon icon-folder';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsDropdownMenu from '@/components/WsDropdownMenu/WsDropdownMenu.vue';
import type { WorkspaceFileEntry } from '@/types/ipc';

interface WorkbenchBreadcrumbDisplayItem {
  title: string;
  disabled: boolean;
  menuItems: readonly WorkbenchBreadcrumbMenuItem[];
}

interface WorkbenchBreadcrumbMenuItem {
  id: string;
  label: string;
  kind: 'directory' | 'file';
  path: string;
}

interface WorkbenchBreadcrumbsProps {
  items: readonly string[];
  workspaceFiles?: readonly WorkspaceFileEntry[];
  trailingDivider?: boolean;
}

const props = withDefaults(defineProps<WorkbenchBreadcrumbsProps>(), {
  workspaceFiles: () => [],
  trailingDivider: false
});
const themeStore = useThemeStore();

const emit = defineEmits<{
  'select-file': [file: WorkspaceFileEntry];
}>();

const navigatedItems = ref<string[]>([]);
const openMenuIndex = ref<number | null>(null);

function splitPath(value: string): string[] {
  return value
    .split(/[\\/]+/u)
    .filter((segment) => segment.trim().length > 0);
}

/**
 * 构建当前路径节点的直接子目录和文件，避免菜单混入祖先或后续层级。
 */
function buildMenuItems(
  itemIndex: number,
  breadcrumbItems: readonly string[]
): WorkbenchBreadcrumbMenuItem[] {
  const targetSegments = itemIndex === 0
    ? []
    : breadcrumbItems.slice(1, itemIndex + 1);
  const directoryItems = new Map<string, WorkbenchBreadcrumbMenuItem>();
  const fileItems = new Map<string, WorkbenchBreadcrumbMenuItem>();

  for (const file of props.workspaceFiles) {
    const fileSegments = splitPath(file.relativePath);
    if (
      fileSegments.length <= targetSegments.length
      || !targetSegments.every((segment, index) => fileSegments[index] === segment)
    ) continue;

    const remainder = fileSegments.slice(targetSegments.length);
    if (remainder.length === 1) {
      fileItems.set(file.relativePath, {
        id: `file:${file.relativePath}`,
        label: remainder[0],
        kind: 'file',
        path: file.relativePath
      });
      continue;
    }

    const directoryPath = [...targetSegments, remainder[0]].join('/');
    directoryItems.set(directoryPath, {
      id: `directory:${directoryPath}`,
      label: remainder[0],
      kind: 'directory',
      path: directoryPath
    });
  }

  return [
    ...[...directoryItems.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN', { numeric: true })),
    ...[...fileItems.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN', { numeric: true }))
  ];
}

function handleMenuSelect(item: unknown): void {
  if (typeof item !== 'object' || item === null) return;
  const menuItem = item as Partial<WorkbenchBreadcrumbMenuItem>;
  if (menuItem.kind === 'directory' && typeof menuItem.path === 'string') {
    const rootItem = navigatedItems.value[0];
    if (!rootItem) return;
    navigatedItems.value = [rootItem, ...splitPath(menuItem.path)];
    void nextTick(() => {
      openMenuIndex.value = navigatedItems.value.length - 1;
    });
    return;
  }
  if (menuItem.kind !== 'file' || typeof menuItem.id !== 'string') return;

  const relativePath = menuItem.id.startsWith('file:')
    ? menuItem.id.slice('file:'.length)
    : '';
  const file = props.workspaceFiles.find(entry => entry.relativePath === relativePath);
  if (file) emit('select-file', file);
}

function getMenuItemIcon(item: unknown): string {
  return typeof item === 'object'
    && item !== null
    && (item as { kind?: unknown }).kind === 'directory'
    ? folderIcon
    : documentIcon;
}

function isWorkspaceFilePath(pathSegments: readonly string[]): boolean {
  const path = pathSegments.join('/');
  return props.workspaceFiles.some((file) => splitPath(file.relativePath).join('/') === path);
}

function handleMenuOpenUpdate(index: number, isOpen: boolean): void {
  openMenuIndex.value = isOpen ? index : openMenuIndex.value === index ? null : openMenuIndex.value;
}

/**
 * 过滤空白路径片段，并将最后一个节点显式标记为当前项。
 */
const normalizedItems = computed<WorkbenchBreadcrumbDisplayItem[]>(() => {
  const breadcrumbItems = navigatedItems.value;
  return breadcrumbItems.map((item, index) => ({
    title: item,
    disabled: index === breadcrumbItems.length - 1 && isWorkspaceFilePath(breadcrumbItems.slice(1)),
    menuItems: buildMenuItems(index, breadcrumbItems)
  }));
});

/** 跟随当前主编辑器重置路径导航，目录浏览不会污染其他编辑器的路径。 */
watch(
  () => props.items,
  (items) => {
    navigatedItems.value = items.filter((item) => item.trim().length > 0);
    openMenuIndex.value = null;
  },
  { deep: true, immediate: true }
);
</script>

<template>
  <div
    class="workbench-breadcrumbs"
    :class="{ 'workbench-breadcrumbs--modern': themeStore.modernUiEnabled }"
  >
    <template
      v-for="(item, index) in normalizedItems"
      :key="`${item.title}-${index}`"
    >
      <div
        v-if="index > 0"
        aria-hidden="true"
        class="workbench-breadcrumbs__divider"
        :class="arrowForwardIcon"
      />
      <WsDropdownMenu
        v-if="!item.disabled"
        :open="openMenuIndex === index"
        class="workbench-breadcrumbs__menu"
        :items="item.menuItems"
        @update:open="handleMenuOpenUpdate(index, $event)"
        @select="handleMenuSelect"
      >
        <template #trigger="{ open }">
          <WsIconButton
            class="workbench-breadcrumbs__button"
            aria-haspopup="menu"
            :active="open"
            :label="item.title"
            :text="item.title"
          />
        </template>
        <template #item="{ props: itemProps, item: menuItem }">
          <button
            v-bind="itemProps"
            type="button"
          >
            <span
              aria-hidden="true"
              class="workbench-breadcrumbs__menu-icon"
              :class="getMenuItemIcon(menuItem.raw)"
            />
            <span class="workbench-breadcrumbs__menu-label">{{ menuItem.title }}</span>
          </button>
        </template>
      </WsDropdownMenu>
      <div
        v-else
        class="workbench-breadcrumbs__item"
        :class="{ 'workbench-breadcrumbs__item--current': item.disabled }"
      >
        <WsIconButton
          class="workbench-breadcrumbs__button"
          :aria-current="item.disabled ? 'page' : undefined"
          :disabled="item.disabled"
          :icon="item.disabled && normalizedItems.length > 1 ? documentIcon : ''"
          icon-position="start"
          :label="item.title"
          :text="item.title"
        />
      </div>
    </template>

    <div
      v-if="props.trailingDivider"
      aria-hidden="true"
      class="workbench-breadcrumbs__trailing-divider"
    >
      <span
        class="workbench-breadcrumbs__divider"
        :class="arrowForwardIcon"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;
@use '@/UIStyles/Default/breadcrumbs' as default-breadcrumbs;

@include default-breadcrumbs.apply;

.workbench-breadcrumbs {
  display: flex;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
  flex-wrap: nowrap;
  min-width: 0;
  min-height: $breadcrumbs-height;
  padding-inline: $breadcrumbs-padding-x;
  overflow: hidden;
  background: none;
  color: var(--ws-breadcrumbs-foreground);
  font-size: $breadcrumbs-font-size;
}

.workbench-breadcrumbs__item {
  min-width: 0;
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  padding: 0;
}

.workbench-breadcrumbs__menu {
  display: inline-flex;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  align-items: center;
}

.workbench-breadcrumbs__menu-icon {
  display: inline-flex;
  flex: 0 0 auto;
  width: $icon-size-width;
  height: $icon-size-height;
  margin-inline-end: $spacing-2xs;
  color: inherit;
  align-items: center;
  justify-content: center;
  font-size: $icon-size-width;
  line-height: 1;
}

.workbench-breadcrumbs__menu-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-breadcrumbs__menu :deep(.ws-dropdown-menu__panel) {
  width: $breadcrumbs-menu-width;
  min-width: $breadcrumbs-menu-width;
  max-height: $breadcrumbs-menu-max-height;
}

.workbench-breadcrumbs__menu :deep(.ws-dropdown-menu__item) {
  display: flex;
  align-items: center;
  min-width: 0;
  color: var(--ws-menu-foreground, var(--ws-foreground));
  font: inherit;
  line-height: normal;
}

.workbench-breadcrumbs__menu :deep(.ws-dropdown-menu__item > *) {
  flex-shrink: 0;
}

.workbench-breadcrumbs__menu :deep(.workbench-breadcrumbs__menu-label) {
  flex: 1 1 auto;
  min-width: 0;
}

.workbench-breadcrumbs__item--current {
  color: var(--ws-breadcrumbs-activeForeground) ;
}

.workbench-breadcrumbs__divider,
.workbench-breadcrumbs__trailing-divider {
  display: inline-flex;
  align-items: center;
  padding-inline: $spacing-2xs;
  color: inherit;

}

.workbench-breadcrumbs__button {
  max-width: 100%;
  min-width: 0;
  color: inherit;
}

.workbench-breadcrumbs__item--current :deep(.workbench-breadcrumbs__button:disabled) {
  color: var(--ws-breadcrumbs-activeForeground);
  opacity: 1;
}

.workbench-breadcrumbs__divider {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: $breadcrumbs-divider-size;
  color: inherit;
  height: $breadcrumbs-divider-size;
  padding: 0;
  font-size: $breadcrumbs-divider-size;
  line-height: 1;
}
</style>
