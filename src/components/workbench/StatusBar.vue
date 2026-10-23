<!-- 文件说明：渲染工作台底部状态栏，并承载全局状态展示区域。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';

import { useDockingThreeStore } from '@/store/dockingThree';
import { usePluginStore } from '@/store/plugin';
import { useNotificationStore } from '@/store/notification';
const notificationsIcon = 'icon icon-notifications';
import WorkbenchBreadcrumbs from '@/components/workbench/WorkbenchBreadcrumbs.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsMenu from '@/components/WsMenu/WsMenu.vue';
import type { WsMenuItem } from '@/components/WsMenu/types';
import type { WorkspaceFileEntry } from '@/types/ipc';
import { announceContextMenuOpen, registerContextMenu } from '@/utils/contextMenuCoordinator';
import { useThemeStore } from '@/store/theme';

type StatusBarNavigationPosition = 'top' | 'status-bar' | 'hidden';

interface StatusBarProps {
  navigationItems?: readonly string[];
  navigationWorkspaceFiles?: readonly WorkspaceFileEntry[];
  navigationTrailingDivider?: boolean;
  navigationVisible?: boolean;
  navigationPosition?: StatusBarNavigationPosition;
  activeLineColumn?: string;
}

const props = withDefaults(defineProps<StatusBarProps>(), {
  navigationItems: () => [],
  navigationWorkspaceFiles: () => [],
  navigationTrailingDivider: false,
  navigationVisible: true,
  navigationPosition: 'top',
  activeLineColumn: ''
});

const emit = defineEmits<{
  'update:navigation-position': [position: StatusBarNavigationPosition];
  'select-navigation-file': [file: WorkspaceFileEntry];
}>();

const dockingThreeStore = useDockingThreeStore();
const themeStore = useThemeStore();
const pluginStore = usePluginStore();
const notificationStore = useNotificationStore();
const { activeDocumentTypeLabel } = storeToRefs(dockingThreeStore);
const { contributions: pluginContributions } = storeToRefs(pluginStore);
const { notifications } = storeToRefs(notificationStore);
const statusBarMenuVisible = ref(false);
const statusBarMenuTarget = ref<[number, number]>([0, 0]);
const statusBarMenuOwner = {};
let disposeStatusBarMenuRegistration: (() => void) | undefined;
const showLineColumn = ref(true);
const showLanguageService = ref(true);
const showFileEncoding = ref(true);
const showIndentation = ref(true);
const pluginStatusItems = computed(() => pluginContributions.value.flatMap((contribution) => (
  contribution.statusBar.map((item) => ({
    ...item,
    pluginName: contribution.pluginName
  }))
)));
const notificationCount = computed(() => notifications.value.length);
const statusBarMenuItems = computed<WsMenuItem[]>(() => [
  {
    type: 'action',
    id: 'navigation',
    label: '导航栏',
    children: [
      { type: 'action', id: 'navigation-top', label: '顶部', checked: props.navigationPosition === 'top' },
      { type: 'action', id: 'navigation-status-bar', label: '在状态栏中', checked: props.navigationPosition === 'status-bar' },
      { type: 'action', id: 'navigation-hidden', label: '不显示', checked: props.navigationPosition === 'hidden' }
    ]
  },
  { type: 'separator', id: 'separator-status-items' },
  { type: 'action', id: 'line-column', label: '行：列号', checked: showLineColumn.value },
  { type: 'action', id: 'language-service', label: '语言服务', checked: showLanguageService.value },
  { type: 'action', id: 'file-encoding', label: '文件编码', checked: showFileEncoding.value },
  { type: 'action', id: 'indentation', label: '缩进', checked: showIndentation.value }
]);

/** 清空当前通知队列并视为已读。 */
function clearNotifications(): void {
  notificationStore.clear();
}

function openStatusBarContextMenu(event: MouseEvent): void {
  event.preventDefault();
  announceContextMenuOpen(statusBarMenuOwner);
  statusBarMenuTarget.value = [event.clientX, event.clientY];
  statusBarMenuVisible.value = true;
}

function handleStatusBarMenuSelect(itemId: string): void {
  statusBarMenuVisible.value = false;
  if (itemId === 'navigation-top') emit('update:navigation-position', 'top');
  if (itemId === 'navigation-status-bar') emit('update:navigation-position', 'status-bar');
  if (itemId === 'navigation-hidden') emit('update:navigation-position', 'hidden');
  if (itemId === 'line-column') showLineColumn.value = !showLineColumn.value;
  if (itemId === 'language-service') showLanguageService.value = !showLanguageService.value;
  if (itemId === 'file-encoding') showFileEncoding.value = !showFileEncoding.value;
  if (itemId === 'indentation') showIndentation.value = !showIndentation.value;
}

onMounted(() => {
  disposeStatusBarMenuRegistration = registerContextMenu(statusBarMenuOwner, () => {
    statusBarMenuVisible.value = false;
  });
});

onBeforeUnmount(() => {
  disposeStatusBarMenuRegistration?.();
  disposeStatusBarMenuRegistration = undefined;
});
</script>

<template>
  <v-sheet
    class="status-bar"
    :class="{ 'status-bar--modern': themeStore.modernUiEnabled }"
    @contextmenu="openStatusBarContextMenu"
  >
    <WorkbenchBreadcrumbs
      v-if="props.navigationVisible && props.navigationPosition === 'status-bar'"
      :items="props.navigationItems"
      :workspace-files="props.navigationWorkspaceFiles"
      :trailing-divider="props.navigationTrailingDivider"
      class="status-bar__navigation"
      @select-file="emit('select-navigation-file', $event)"
    />
    <WsIconButton
      v-for="item in pluginStatusItems"
      :key="`${item.pluginName}:${item.id}`"
      class="status-bar__plugin-button"
      :label="item.tooltip ?? item.text"
      :text="item.text"
      :tooltip="item.tooltip"
    />
    <v-spacer />
    <WsIconButton
      v-if="showLineColumn && props.activeLineColumn"
      class="status-bar__item"
      label="行列号"
      :text="props.activeLineColumn"
    />
    <WsIconButton
      v-if="showFileEncoding && props.activeLineColumn"
      class="status-bar__item"
      label="文件编码"
      text="UTF-8"
    />
    <WsIconButton
      v-if="showIndentation && props.activeLineColumn"
      class="status-bar__item"
      label="缩进"
      text="空格：4"
    />
    <WsIconButton
      v-if="showLanguageService && activeDocumentTypeLabel"
      class="status-bar__language-button"
      :label="`当前文件类型：${activeDocumentTypeLabel}`"
      :text="activeDocumentTypeLabel"
    />
    <!-- S = 消息通知 -->
    <WsIconButton
      class="status-bar__notification-button"
      :icon="notificationsIcon"
      label="消息通知"
      @click="clearNotifications"
    >
      <template #badge>
        <span
          v-if="notificationCount > 0"
          class="status-bar__notification-count"
          aria-live="polite"
        >
          {{ notificationCount > 99 ? '99+' : notificationCount }}
        </span>
      </template>
    </WsIconButton>
    <!-- E = 消息通知 -->
    <WsMenu
      v-model:open="statusBarMenuVisible"
      content-class="status-bar__context-menu"
      :items="statusBarMenuItems"
      :target="statusBarMenuTarget"
      @select="handleStatusBarMenuSelect"
    />
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;
@use '@/UIStyles/Default/statusBar' as default-status-bar;

@include default-status-bar.apply;

.status-bar {
  @include flex-align-center;
  width: 100%;
  gap:10px;
  min-height: $status-bar-height;
  max-height: $status-bar-height;
  padding-inline: $spacing-sm;
  color: var(--ws-button-foreground,--ws-foreground);
  background: var(--ws-statusBar-background);
  border-radius: $radius-none;
}

.status-bar__navigation {
  flex: 0 1 auto;
  min-width: 0;
  min-height: $status-bar-height;
  padding-inline: $spacing-2xs;
  border-bottom: 0;
  font-size: $font-size-xs;
}

.status-bar__item {
  min-width: 0;
  padding: $compact-control-padding;
  border-radius: $radius-2px !important;
  text-transform: none;
}

:global(.status-bar__context-menu) {
  min-width: $title-bar-context-menu-min-width;
}

.status-bar__plugin-button {
  min-width: 0;
  padding: $compact-control-padding;
  text-transform: none;
  border-radius: $radius-2px !important;
}

.status-bar__language-button {
  min-width: 0;
  height: auto !important;
  padding: $compact-control-padding;
  text-transform: none;
  border-radius: $radius-2px !important;
  cursor: default;
}

.status-bar__notification-button {
  position: relative;
  width: $button-width;
  min-width: $button-width;
  height: auto !important;
  padding: 0;
  text-transform: none;
  border-radius: $radius-2px !important;
}

.status-bar__notification-count {
  position: absolute;
  top: -$spacing-2xs;
  right: -$spacing-xs;
  min-width: $status-bar-notification-badge-size;
  height: $status-bar-notification-badge-size;
  padding: 0 $spacing-3xs;
  color: var(--ws-statusBar-background);
  background: var(--ws-statusBar-foreground);
  border-radius: $radius-2px;
  font-size: $font-size-xs;
  line-height: $status-bar-notification-badge-size;
  text-align: center;
}

</style>
