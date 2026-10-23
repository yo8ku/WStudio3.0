<script setup lang="ts">
/**
 * 文件说明：渲染单个停靠标签组，负责标签切换、关闭、新建以及中心停靠插槽测量。 */
import { computed, defineAsyncComponent, inject, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';

const addIcon = 'icon icon-add';
const closeIcon = 'icon icon-close';
const dirtyIcon = 'icon icon-dot';
const moreVerticalIcon = 'icon icon-more-vertical';
import SidebarTabToolbar, {
  type SidebarTabToolbarItem
} from '@/components/SidebarTabToolbar/SidebarTabToolbar.vue';
import WorkbenchHorizontalScrollbar from '@/components/scrollbar/WorkbenchHorizontalScrollbar.vue';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import DockingThreePlaceholderPanel from '@/DockingThree/DockingThreePlaceholderPanel.vue';
import DockingThreePanel from '@/DockingThree/DockingThreePanel.vue';
import { createPluginPanelTargetRefs, pluginPanelTargetsKey } from '@/DockingThree/pluginPanelTargets';
import WsEditorTag from '@/components/WsEditorTag/WsEditorTag.vue';
import type {
  DockingThreeGroupNode,
  DockingThreeGroupBounds,
  DockingThreeIndicatorBounds,
  DockingThreeTab
} from '@/DockingThree/types';
import { useDockingThreeStore } from '@/store/dockingThree';
import { useWorkspaceStore } from '@/store/workspace';
import { pluginApi } from '@/api/plugin';
import { useNotification } from '@/components/notification/useNotification';
import { announceOverlayOpen } from '@/utils/contextMenuCoordinator';
import { requestWorkbenchContextMenu } from '@/utils/workbenchContextMenu';
import { WORKBENCH_TOOLTIP_OPEN_DELAY } from '@/utils/workbenchTooltip';
import type { WorkbenchContextMenuEntry, WorkspaceCopyPathKind } from '@/types/ipc';

const loadWorkbenchEditorPanel = () => import('@editor/Workbench/WorkbenchEditorPanel.vue');
const AsyncWorkbenchEditorPanel = defineAsyncComponent(loadWorkbenchEditorPanel);
const AsyncWorkbenchWelcomeTab = defineAsyncComponent(
  () => import('@editor/Workbench/WorkbenchWelcomeTab.vue')
);
const AsyncDockingThreeMediaPanel = defineAsyncComponent(
  () => import('@/components/workbench/DockingThreeMediaPanel.vue')
);
const AsyncSettingsDialog = defineAsyncComponent(
  () => import('@/components/workbench/SettingsDialog.vue')
);
const AsyncRenameTabDialog = defineAsyncComponent(
  () => import('@/components/workbench/RenameTabDialog.vue')
);
const AsyncWorkbenchListPickerDialog = defineAsyncComponent(
  () => import('@/components/workbench/WorkbenchListPickerDialog.vue')
);

const props = withDefaults(defineProps<{
  group: DockingThreeGroupNode;
  preview?: boolean;
  previewLayout?: boolean;
  topEdge?: boolean;
}>(), {
  preview: false,
  previewLayout: false,
  topEdge: false
});

const failedFaviconUrls = ref(new Set<string>());

/** 网站图标加载失败时使用声明图标，保持标签标题和关闭按钮可见。 */
function getWebViewerTabIcon(tab: DockingThreeTab): string | undefined {
  const favicon = tab.webViewerFaviconUrl;
  return favicon && !failedFaviconUrls.value.has(favicon)
    ? favicon
    : tab.viewIconUrl;
}

/** 记录失败的网站图标，后续导航获得新图标时自动重试。 */
function handleWebViewerIconError(tab: DockingThreeTab): void {
  if (tab.webViewerFaviconUrl) failedFaviconUrls.value.add(tab.webViewerFaviconUrl);
}

const dockingThreeStore = useDockingThreeStore();
const workspaceStore = useWorkspaceStore();
const notification = useNotification();
const pluginPanelTargets = inject(pluginPanelTargetsKey);
const { getPluginTargetRef, disposePluginTargetRefs } = createPluginPanelTargetRefs(pluginPanelTargets);
const groupElement = ref<HTMLElement>();
const headerElement = ref<HTMLElement>();
const tabScrollerElement = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | undefined;
let resizeFrame = 0;
let lastBounds: DockingThreeGroupBounds | undefined;
let lastCenterDropSlots: DockingThreeIndicatorBounds[] = [];

const activeTab = computed(() =>
  props.group.tabs.find((tab) => tab.id === props.group.activeTabId) ?? props.group.tabs[0]
);

const isSidebarGroup = computed(() =>
  props.group.role === 'left-sidebar' || props.group.role === 'right-sidebar'
);

const hasPluginTab = computed(() =>
  props.group.tabs.some((tab) => tab.kind === 'plugin' || tab.kind === 'host-panel')
);

/**
 * Activity-rail groups keep their compact single-item presentation. Any
 * plugin panel docked into the workspace edge (left/right/top/bottom) is a
 * context panel and exposes the shared icon toolbar, even with one tab.
 */
const showSidebarToolbar = computed(() => {
  const isWorkspacePanel = isSidebarGroup.value || props.group.role === 'bottom';
  const hasContextTab = props.group.tabs.some((tab) =>
    (tab.kind === 'plugin' || tab.kind === 'host-panel') && tab.sidebarDockTarget === 'context'
  );

  return isWorkspacePanel && hasPluginTab.value && hasContextTab;
});

const showHeader = computed(() =>
  props.group.header === 'tabs'
  && (
    props.group.tabs.length > (isSidebarGroup.value ? 1 : 0)
    // A sidebar context that is docked below another context is a distinct
    // panel. Keep its icon toolbar visible even when it contains one tab; the
    // toolbar identifies the lower panel and exposes its panel actions.
    || (showSidebarToolbar.value && (isSidebarGroup.value || props.group.role === 'bottom'))
  )
);

const showAddButton = computed(() =>
  !props.preview && !props.previewLayout && props.group.role === 'editor'
);
const showMoreButton = computed(() =>
  !showSidebarToolbar.value
  && !isSidebarGroup.value
  && showHeader.value
  && !props.preview
  && !props.previewLayout
  && Boolean(activeTab.value)
);

/** 将鼠标纵向滚轮映射为标签栏横向滚动。 */
function handleTabStripWheel(event: WheelEvent): void {
  const scroller = tabScrollerElement.value;

  if (!scroller || event.ctrlKey || scroller.scrollWidth <= scroller.clientWidth) {
    return;
  }

  const lineHeight = 16;
  const verticalDelta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaY * lineHeight
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * scroller.clientWidth
      : event.deltaY;
  const delta = Math.abs(event.deltaX) > Math.abs(verticalDelta)
    ? event.deltaX
    : verticalDelta;
  const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
  const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, scroller.scrollLeft + delta));

  if (nextScrollLeft === scroller.scrollLeft) {
    return;
  }

  scroller.scrollLeft = nextScrollLeft;
  event.preventDefault();
}

/** 保持活动标签可见；激活末尾标签时同时露出新增按钮，支持连续新建。 */
function scrollActiveTabIntoView(): void {
  const scroller = tabScrollerElement.value;

  if (!scroller || showSidebarToolbar.value) {
    return;
  }

  const activeTab = scroller.querySelector<HTMLElement>('.docking-three-group__tab--active');

  if (!activeTab) {
    return;
  }

  const addButton = activeTab.dataset.tabId === props.group.tabs.at(-1)?.id
    ? scroller.querySelector<HTMLElement>('.docking-three-group__add-tab')
    : null;

  if (addButton) {
    // 由浏览器钳制到真实滚动终点，避免 offsetWidth/clientWidth 取整造成末端裁切。
    scroller.scrollLeft = scroller.scrollWidth;
    return;
  }

  const tabLeft = activeTab.offsetLeft;
  const tabRight = tabLeft + activeTab.offsetWidth;
  const visibleLeft = scroller.scrollLeft;
  const visibleRight = visibleLeft + scroller.clientWidth;

  if (tabLeft < visibleLeft) {
    scroller.scrollLeft = tabLeft;
  } else if (tabRight > visibleRight) {
    scroller.scrollLeft = tabRight - scroller.clientWidth;
  }
}

const isFocusedGroup = computed(() => dockingThreeStore.focusedGroupId === props.group.id);
const previewTabTitle = computed(() => activeTab.value?.title ?? '新标签页');
const isPreviewGhost = computed(() => props.group.previewGhost);
const tabContextMenuTabId = ref<string>();
const renameDialogVisible = ref(false);
const renameDialogTabId = ref<string>();
const renameDialogInitialName = ref('');
const moveDialogVisible = ref(false);
const moveDialogSourcePath = ref('');
const moveDialogSourceName = computed(() => {
  const separatorIndex = moveDialogSourcePath.value.lastIndexOf('/');
  return separatorIndex < 0
    ? moveDialogSourcePath.value
    : moveDialogSourcePath.value.slice(separatorIndex + 1);
});

const moveDialogCurrentDirectory = computed(() => {
  const separatorIndex = moveDialogSourcePath.value.lastIndexOf('/');
  return separatorIndex < 0 ? '.' : moveDialogSourcePath.value.slice(0, separatorIndex);
});

watch(
  () => [props.group.activeTabId, props.group.tabs.length] as const,
  () => {
    void nextTick(scrollActiveTabIntoView);
  }
);

const sidebarToolbarItems = computed<SidebarTabToolbarItem[]>(() =>
  props.group.tabs.map((tab) => ({
    id: tab.id,
    label: tab.title,
    iconUrl: tab.hostPanelIconClass ? undefined : tab.viewIconUrl ?? tab.hostPanelIconUrl,
    iconClass: tab.hostPanelIconClass ?? (tab.viewIconUrl || tab.hostPanelIconUrl ? undefined : 'icon icon-folder'),
    active: tab.id === props.group.activeTabId
  }))
);

const tabContextMenuOwner = {};
const tabContextMenuTab = computed(() => props.group.tabs.find(tab => tab.id === tabContextMenuTabId.value));
interface TabContextMenuChildItem {
  id: string;
  label: string;
}

interface TabContextMenuItem {
  id: string;
  label?: string;
  divider?: boolean;
  children?: readonly TabContextMenuChildItem[];
}

const tabContextMenuItems: readonly TabContextMenuItem[] = [
  { id: 'close', label: '关闭' },
  { id: 'close-others', label: '关闭其他标签页' },
  { id: 'close-all', label: '关闭所有标签页' },
  { id: 'close-left', label: '关闭左侧标签页' },
  { id: 'close-right', label: '关闭右侧标签页' },
  { id: 'divider-1', divider: true },
  {
    id: 'copy-path',
    label: '复制路径',
    children: [
      { id: 'copy-absolute-path', label: '绝对路径' },
      { id: 'copy-repository-root', label: '仓库根路径' },
      { id: 'copy-content-root', label: '内容根路径' }
    ]
  },
  { id: 'lock', label: '锁定' },
  { id: 'related', label: '关联标签页' },
  { id: 'backlinks', label: '在标签页中显示反向链接' },
  { id: 'divider-2', divider: true },
  { id: 'split-right', label: '向右拆分' },
  { id: 'split-bottom', label: '向下拆分' },
  { id: 'new-window', label: '在新窗口中打开' },
  { id: 'divider-3', divider: true },
  { id: 'rename', label: '重命名' },
  { id: 'move', label: '将文件移动到...' },
  { id: 'favorite', label: '收藏' },
  { id: 'properties', label: '增加笔记属性' },
  { id: 'divider-4', divider: true },
  { id: 'find', label: '查找' },
  { id: 'replace', label: '替换' },
  { id: 'divider-5', divider: true },
  { id: 'default-app', label: '默认应用打开' },
  { id: 'reveal', label: '在资源管理器中打开' },
  { id: 'locate', label: '定位当前文件' },
  { id: 'divider-6', divider: true },
  { id: 'delete', label: '删除文件' }
] as const;

/** 网页标签页专用菜单，仅保留与网页和工作台布局有关的动作。 */
const webViewerTabContextMenuItems: readonly TabContextMenuItem[] = [
  { id: 'close', label: '关闭' },
  { id: 'close-others', label: '关闭其他标签页' },
  { id: 'close-all', label: '关闭所有标签页' },
  { id: 'close-left', label: '关闭左侧标签页' },
  { id: 'close-right', label: '关闭右侧标签页' },
  { id: 'web-divider-1', divider: true },
  { id: 'lock', label: '锁定' },
  { id: 'related', label: '关联标签页' },
  { id: 'split-right', label: '向右拆分' },
  { id: 'split-bottom', label: '向下拆分' },
  { id: 'new-window', label: '在新窗口中打开' },
  { id: 'web-divider-2', divider: true },
  { id: 'find', label: '查找' },
  { id: 'open-external', label: '在默认浏览器打开' },
  { id: 'favorite', label: '收藏' },
  { id: 'save-to-repository', label: '保存到仓库' },
  { id: 'web-divider-3', divider: true },
  { id: 'zoom-in', label: '放大' },
  { id: 'zoom-reset', label: '重置缩放' },
  { id: 'zoom-out', label: '缩小' }
] as const;

const copyPathKinds: Readonly<Record<string, WorkspaceCopyPathKind>> = {
  'copy-absolute-path': 'absolute',
  'copy-repository-root': 'repository-root',
  'copy-content-root': 'content-root'
};

const placeholderLabel = computed(() =>
  activeTab.value?.label ?? activeTab.value?.title ?? '模拟标签页'
);

/**
 * 判断当前标签是否为真实编辑器标签。 */
function isEditorTab(tab: DockingThreeTab): boolean {
  return tab.kind === 'editor';
}

/** 判断编辑器标签内容是否已偏离打开或最近保存的基线。 */
function isDirtyEditorTab(tab: DockingThreeTab): boolean {
  return isEditorTab(tab) && dockingThreeStore.isEditorDocumentDirty(tab.id);
}

/** 判断目标标签是否允许维护 Markdown 笔记属性。 */
function canManageNoteProperties(tab: DockingThreeTab | undefined): boolean {
  if (!tab || !isEditorTab(tab)) {
    return false;
  }

  return !tab.filePath || /\.(?:md|markdown)$/i.test(tab.filePath);
}

/** 统一计算标签页菜单项禁用状态。 */
function isTabContextItemDisabled(itemId: string): boolean {
  if (itemId === 'properties') {
    return !canManageNoteProperties(tabContextMenuTab.value);
  }

  if (itemId === 'new-window' && tabContextMenuTab.value?.kind === 'plugin') {
    return false;
  }

  return ['move', 'new-window'].includes(itemId) && !tabContextMenuTab.value?.relativePath;
}

/** 将当前标签对应的菜单配置转换为宿主统一菜单条目。 */
function buildTabContextMenuEntries(
  items: readonly TabContextMenuItem[]
): readonly WorkbenchContextMenuEntry[] {
  return items.map(item => {
    if (item.divider) return { type: 'separator', id: item.id };
    return {
      type: 'action',
      id: item.id,
      label: item.label ?? '',
      enabled: !isTabContextItemDisabled(item.id),
      ...(item.children ? {
        children: item.children.map(child => ({
          type: 'action' as const,
          id: child.id,
          label: child.label,
          enabled: Boolean(tabContextMenuTab.value?.relativePath)
        }))
      } : {})
    };
  });
}

/** 判断当前标签是否为媒体文件标签。 */
function isMediaTab(tab: DockingThreeTab): boolean {
  return tab.kind === 'media';
}

/**
 * 判断当前标签是否应渲染欢迎页内容。 */
function isWelcomeTab(tab: DockingThreeTab): boolean {
  return tab.kind === 'welcome';
}

/** 判断当前标签是否为插件视图标签。 */
function isPluginTab(tab: DockingThreeTab): boolean {
  return tab.kind === 'plugin';
}

function isHostPanelTab(tab: DockingThreeTab): boolean {
  return tab.kind === 'host-panel';
}

/** 判断当前标签是否为工作台设置页。 */
function isSettingsTab(tab: DockingThreeTab): boolean {
  return tab.kind === 'settings';
}

/**
 * 激活当前分组内的指定标签，并切换全局焦点分组。 */
function activateTab(tabId: string): void {
  dockingThreeStore.setActiveTab(props.group.id, tabId);
}

/**
 * 点击分组时切换全局焦点分组。 */
function handleGroupPointerDown(): void {
  dockingThreeStore.focusGroup(props.group.id);
}

/** 判断指定标签是否为当前分组的活动标签。 */
function isActiveTab(tabId: string): boolean {
  return tabId === props.group.activeTabId;
}

/**
 * 将标签拖拽入口交给 Store，以启动停靠拖拽流程。 */
function handleTabPointerDown(event: PointerEvent, tabId: string): void {
  if (props.preview || event.button !== 0) {
    return;
  }

  dockingThreeStore.beginPendingTabDrag(tabId, props.group.id, event.clientX, event.clientY);
}

/** Relays sidebar toolbar tab dragging into the shared docking workflow. */
function handleSidebarTabPointerDown(tabId: string, event: PointerEvent): void {
  handleTabPointerDown(event, tabId);
}

/** Relays sidebar toolbar context menus into the shared tab menu workflow. */
function handleSidebarTabContextMenu(tabId: string, event: MouseEvent): void {
  void openTabContextMenu(event, tabId);
}

/**
 * 关闭指定标签页。 */
function closeTab(tabId: string): void {
  dockingThreeStore.closeTab(props.group.id, tabId);
}

/** 打开标签页上下文菜单并记录目标标签。 */
async function openTabContextMenu(event: MouseEvent, tabId: string): Promise<void> {
  event.preventDefault();
  const tab = props.group.tabs.find(item => item.id === tabId);
  if (!tab) return;
  // Context-menu actions target the tab under the pointer without changing
  // the currently active editor tab.
  announceOverlayOpen(tabContextMenuOwner);
  tabContextMenuTabId.value = tabId;
  const menuItems = tab.viewCapabilities?.includes('webViewer')
    ? webViewerTabContextMenuItems
    : tabContextMenuItems;
  const request = {
    x: event.clientX,
    y: event.clientY,
    items: buildTabContextMenuEntries(menuItems)
  };
  const action = await requestWorkbenchContextMenu(request, { preferNative: false });
  if (action) await handleTabContextAction(action);
}

/** 按宿主路径语义复制当前标签关联的文件路径。 */
async function copyTabPath(kind: WorkspaceCopyPathKind): Promise<void> {
  const relativePath = tabContextMenuTab.value?.relativePath;

  if (!relativePath) {
    return;
  }

  await workspaceStore.copyPath(relativePath, kind);
}

/** 执行标签页上下文菜单动作。 */
async function handleTabContextAction(action: string): Promise<void> {
  const tab = tabContextMenuTab.value;
  if (!tab) return;
  const copyPathKind = copyPathKinds[action];
  if (copyPathKind) {
    await copyTabPath(copyPathKind);
    return;
  }
  const tabId = tab.id;
  if (action === 'close') dockingThreeStore.closeTab(props.group.id, tabId);
  else if (action === 'close-others') dockingThreeStore.closeOtherTabs(props.group.id, tabId);
  else if (action === 'close-all') dockingThreeStore.closeAllTabs(props.group.id);
  else if (action === 'close-left') dockingThreeStore.closeTabsToLeft(props.group.id, tabId);
  else if (action === 'close-right') dockingThreeStore.closeTabsToRight(props.group.id, tabId);
  else if (action === 'split-right') dockingThreeStore.splitTab(props.group.id, tabId, 'right', false);
  else if (action === 'split-bottom') dockingThreeStore.splitTab(props.group.id, tabId, 'bottom', false);
  else if (action === 'rename') {
    renameDialogTabId.value = tabId;
    renameDialogInitialName.value = tab.title;
    renameDialogVisible.value = true;
  }
  else if (action === 'move' && tab.relativePath) {
    moveDialogSourcePath.value = tab.relativePath;
    moveDialogVisible.value = true;
    await workspaceStore.loadDirectories();
  }
  else if (action === 'properties' && canManageNoteProperties(tab)) {
    dockingThreeStore.setActiveTab(props.group.id, tabId);
    dockingThreeStore.requestNotePropertiesMenu(tabId);
  }
  else if (action === 'new-window' && tab.relativePath) await workspaceStore.openInNewWindow(tab.relativePath);
  else if (action === 'default-app' && tab.relativePath) await workspaceStore.openWithSystem(tab.relativePath);
  else if (action === 'reveal' && tab.relativePath) await workspaceStore.revealInFileManager(tab.relativePath);
  else if (action === 'locate' && tab.relativePath) await workspaceStore.revealInFileManager(tab.relativePath);
  else if (
    tab.viewCapabilities?.includes('webViewer')
    && tab.pluginId
    && tab.viewInstanceId
    && ['new-window', 'open-external', 'save-to-repository', 'favorite', 'zoom-in', 'zoom-reset', 'zoom-out'].includes(action)
  ) {
    try {
      const completed = await pluginApi.executeWebViewerContextMenu({
        pluginId: tab.pluginId,
        instanceId: tab.viewInstanceId,
        viewType: tab.viewType ?? '',
        action: action as 'new-window' | 'open-external' | 'save-to-repository' | 'favorite' | 'zoom-in' | 'zoom-reset' | 'zoom-out'
      });
      if (completed && action === 'favorite') notification.normal('网页链接已收藏。');
      if (completed && action === 'save-to-repository') notification.normal('网页链接已保存到仓库。');
    } catch (reason: unknown) {
      // 旧安装记录可能缺少新增权限；保留授权边界并给出正常重新授权入口提示。
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes('PLUGIN_PERMISSION_NOT_DECLARED')) {
        notification.warning('网页操作需要额外权限，请在插件管理中为此插件重新授权。');
      } else {
        notification.error('网页操作失败，请刷新网页后重试。');
      }
    }
  }
}

/** 保存标签页重命名结果。 */
function handleRenameTab(name: string): void {
  const tabId = renameDialogTabId.value;
  if (!tabId) {
    return;
  }

  dockingThreeStore.renameTab(props.group.id, tabId, name);
  renameDialogTabId.value = undefined;
}

/** 将当前标签关联文件移动到所选仓库目录。 */
async function handleMoveTabFile(targetDirectoryRelativePath: string): Promise<void> {
  const result = await workspaceStore.moveFile(
    moveDialogSourcePath.value,
    targetDirectoryRelativePath
  );
  if (result.status === 'moved') {
    moveDialogVisible.value = false;
    moveDialogSourcePath.value = '';
  }
}

/**
 * 在当前编辑器分组中创建欢迎页标签。 */
function createWelcomeTab(): void {
  dockingThreeStore.createWelcomeTabInGroup(props.group.id);
}

/**
 * 比较中心停靠指示器集合是否发生变化，避免重复写入 Store。 */
function areIndicatorBoundsEqual(
  left: DockingThreeIndicatorBounds[],
  right: DockingThreeIndicatorBounds[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => {
    const target = right[index];

    return target
      && item.left === target.left
      && item.top === target.top
      && item.width === target.width
      && item.height === target.height;
  });
}

/**
 * 清理当前分组在 Store 中登记的中心停靠插槽。 */
function clearCenterDropSlots(): void {
  if (lastCenterDropSlots.length === 0) {
    return;
  }

  lastCenterDropSlots = [];
  dockingThreeStore.clearGroupCenterDropSlotsEntry(props.group.id);
}

/**
 * 基于标签头部布局同步中心停靠竖线插槽，用于标签插入预览。 */
function syncCenterDropSlots(): void {
  if (
    props.preview
    || props.previewLayout
    || (props.group.role !== 'editor'
      && props.group.role !== 'left-sidebar'
      && props.group.role !== 'right-sidebar')
    || !showHeader.value
    || !headerElement.value
  ) {
    clearCenterDropSlots();
    return;
  }

  const headerRect = headerElement.value.getBoundingClientRect();
  const tabElements = Array.from(
    headerElement.value.querySelectorAll(
      '.docking-three-group__tab, .sidebar-tab-toolbar__button'
    )
  ).filter((element): element is HTMLElement => element instanceof HTMLElement);

  if (tabElements.length === 0) {
    clearCenterDropSlots();
    return;
  }

  const slotCenters = tabElements.map((tabElement, index) => {
    const tabRect = tabElement.getBoundingClientRect();
    const previousTabRect = index > 0
      ? tabElements[index - 1]!.getBoundingClientRect()
      : undefined;

    if (!previousTabRect) {
      return headerRect.left + ((tabRect.left - headerRect.left) / 2);
    }

    return previousTabRect.right + ((tabRect.left - previousTabRect.right) / 2);
  });

  const lastTabRect = tabElements[tabElements.length - 1]!.getBoundingClientRect();
  const verticalInset = Math.max(2, Math.floor(headerRect.height * 0.2));
  // The trailing insertion slot belongs immediately after the last toolbar
  // button. Using the remaining header width places the indicator halfway to
  // the overflow button, which makes it look detached from the tab option.
  slotCenters.push(lastTabRect.right + 1);

  const nextSlots = slotCenters.map((centerX) => ({
    left: Math.min(
      Math.max(headerRect.left, centerX - 1),
      headerRect.right - 2
    ),
    top: headerRect.top + verticalInset,
    width: 2,
    height: Math.max(0, headerRect.height - (verticalInset * 2))
  }));

  if (areIndicatorBoundsEqual(lastCenterDropSlots, nextSlots)) {
    return;
  }

  lastCenterDropSlots = nextSlots;
  dockingThreeStore.setGroupCenterDropSlotsEntry(props.group.id, nextSlots);
}

/**
 * 同步当前分组的屏幕边界，用于拖拽命中检测与预览计算。 */
function syncBounds(): void {
  if (props.preview || props.previewLayout || !groupElement.value) {
    return;
  }

  const rect = groupElement.value.getBoundingClientRect();
  const bounds: DockingThreeGroupBounds = {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };

  if (
    lastBounds
    && lastBounds.left === bounds.left
    && lastBounds.top === bounds.top
    && lastBounds.right === bounds.right
    && lastBounds.bottom === bounds.bottom
    && lastBounds.width === bounds.width
    && lastBounds.height === bounds.height
  ) {
    syncCenterDropSlots();
    return;
  }

  lastBounds = bounds;
  dockingThreeStore.setGroupBoundsEntry(props.group.id, bounds);
  syncCenterDropSlots();
}

/**
 * 将分组边界同步合并到动画帧，减少高频测量带来的抖动。 */
function scheduleBoundsSync(): void {
  if (props.preview || props.previewLayout) {
    return;
  }

  if (resizeFrame !== 0) {
    window.cancelAnimationFrame(resizeFrame);
  }

  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = 0;
    syncBounds();
  });
}

/**
 * 挂载阶段开始监听当前分组尺寸变化与窗口 `resize`。 */
onMounted(() => {
  if (props.preview || props.previewLayout || !groupElement.value) {
    return;
  }

  resizeObserver = new ResizeObserver(() => {
    scheduleBoundsSync();
  });
  resizeObserver.observe(groupElement.value);
  window.addEventListener('resize', scheduleBoundsSync);
  nextTick(() => {
    syncBounds();
  });
});

/**
 * 组件更新后重新安排边界同步，保持拖拽命中区域与 DOM 一致。 */
onUpdated(() => {
  scheduleBoundsSync();
});

/**
 * 卸载阶段清理测量监听，并在非拖拽状态下移除当前分组登记信息。 */
onBeforeUnmount(() => {
  disposePluginTargetRefs();
  if (resizeFrame !== 0) {
    window.cancelAnimationFrame(resizeFrame);
  }

  resizeObserver?.disconnect();
  window.removeEventListener('resize', scheduleBoundsSync);

  if (!props.preview && !props.previewLayout && !dockingThreeStore.isDragging) {
    lastBounds = undefined;
    lastCenterDropSlots = [];
    dockingThreeStore.clearGroupBoundsEntry(props.group.id);
    dockingThreeStore.clearGroupCenterDropSlotsEntry(props.group.id);
  }
});
</script>

<template>
  <div
    ref="groupElement"
    class="docking-three-group-shell"
  >
    <v-sheet
      class="docking-three-group rounded-0"
      :class="{
        'docking-three-group--preview': preview,
        'docking-three-group--preview-ghost': group.previewGhost,
        'docking-three-group--docked': group.docked === true,
        'docking-three-group--top-edge': topEdge,
        'docking-three-group--editor': group.role === 'editor',
        'docking-three-group--bottom': group.role === 'bottom',
        'docking-three-group--left-sidebar': group.role === 'left-sidebar',
        'docking-three-group--right-sidebar': group.role === 'right-sidebar'
      }"
      elevation="0"
      @pointerdown="handleGroupPointerDown"
    >
      <template v-if="preview || isPreviewGhost">
        <template v-if="isPreviewGhost">
          <div class="docking-three-group__body docking-three-group__body--preview docking-three-group__body--preview-ghost" />
        </template>
        <template v-else>
          <div v-if="showHeader" class="docking-three-group__header docking-three-group__header--preview">
            <div class="docking-three-group__tab docking-three-group__tab--active">
              <span class="docking-three-group__tab-title">{{ previewTabTitle }}</span>
            </div>
          </div>
          <div class="docking-three-group__body docking-three-group__body--preview">
            <span class="docking-three-group__preview-label">{{ placeholderLabel }}</span>
          </div>
        </template>
      </template>

      <template v-else>
        <div
          v-if="showHeader"
          ref="headerElement"
          class="docking-three-group__header"
        >
          <div
            class="docking-three-group__tab-strip"
            @wheel="handleTabStripWheel"
          >
            <div
              ref="tabScrollerElement"
              class="docking-three-group__tabs"
            >
              <SidebarTabToolbar
                v-if="showSidebarToolbar"
                :items="sidebarToolbarItems"
                @select="activateTab"
                @tab-pointerdown="handleSidebarTabPointerDown"
                @tab-contextmenu="handleSidebarTabContextMenu"
              />
              <template v-else>
                <button
                  v-for="tab in group.tabs"
                  :key="tab.id"
                  type="button"
                  class="docking-three-group__tab"
                  :data-tab-id="tab.id"
                  :class="{
                    'docking-three-group__tab--active': isActiveTab(tab.id),
                    'docking-three-group__tab--inactive': isActiveTab(tab.id) && !isFocusedGroup,
                    'docking-three-group__tab--web-viewer': tab.viewCapabilities?.includes('webViewer')
                  }"
                  :title="tab.title"
                  @pointerdown.stop="handleTabPointerDown($event, tab.id)"
                  @click.stop="activateTab(tab.id)"
                  @contextmenu="openTabContextMenu($event, tab.id)"
                >
                  <img
                    v-if="tab.viewCapabilities?.includes('webViewer') && getWebViewerTabIcon(tab)"
                    :src="getWebViewerTabIcon(tab)"
                    class="docking-three-group__tab-favicon"
                    alt=""
                    draggable="false"
                    referrerpolicy="no-referrer"
                    @error="handleWebViewerIconError(tab)"
                  >
                  <span
                    v-else-if="tab.viewCapabilities?.includes('webViewer')"
                    class="docking-three-group__tab-favicon icon icon-folder"
                    aria-hidden="true"
                  />
                  <span class="docking-three-group__tab-title">{{ tab.title }}</span>
                  <span
                    v-if="tab.closable && (group.role === 'editor' || isPluginTab(tab) || isSettingsTab(tab))"
                    class="docking-three-group__tab-close"
                    :class="{ 'docking-three-group__tab-close--dirty': isDirtyEditorTab(tab) }"
                    :aria-label="`关闭 ${tab.title}`"
                    @pointerdown.stop
                    @click.stop="closeTab(tab.id)"
                  >
                    <span
                      v-if="isDirtyEditorTab(tab)"
                      class="docking-three-group__tab-close-icon docking-three-group__tab-close-icon--dirty"
                      :class="dirtyIcon"
                    />
                    <span
                      class="docking-three-group__tab-close-icon docking-three-group__tab-close-icon--close"
                      :class="closeIcon"
                    />
                  </span>
                </button>
                <WsTooltip
                  v-if="showAddButton"
                  location="bottom"
                  :open-delay="WORKBENCH_TOOLTIP_OPEN_DELAY"
                  text="新标签页"
                >
                  <template #activator="{ props: tooltipProps }">
                    <button
                      v-bind="tooltipProps"
                      type="button"
                      class="docking-three-group__add-tab"
                      aria-label="新标签页"
                      @click.stop="createWelcomeTab"
                    >
                      <span class="docking-three-group__add-tab-icon" :class="addIcon" />
                    </button>
                  </template>
                </WsTooltip>
              </template>
            </div>
            <WorkbenchHorizontalScrollbar
              v-if="!showSidebarToolbar"
              class="docking-three-group__tabs-scrollbar"
              :scroller-element="tabScrollerElement"
            />
          </div>
          <div class="docking-three-group__tab-toolbar">
            <WsTooltip
              v-if="showMoreButton"
              location="bottom"
              :open-delay="WORKBENCH_TOOLTIP_OPEN_DELAY"
              text="更多选项"
            >
              <template #activator="{ props: tooltipProps }">
                <button
                  v-bind="tooltipProps"
                  type="button"
                  class="docking-three-group__more-tab-options"
                  aria-label="更多选项"
                  @pointerdown.stop
                  @click.stop="openTabContextMenu($event, activeTab!.id)"
                >
                  <span
                    aria-hidden="true"
                    class="docking-three-group__more-tab-options-icon"
                    :class="moreVerticalIcon"
                  />
                </button>
              </template>
            </WsTooltip>
          </div>
        </div>

        <AsyncRenameTabDialog
          v-if="renameDialogVisible"
          v-model="renameDialogVisible"
          :initial-name="renameDialogInitialName"
          @save="handleRenameTab"
        />

        <AsyncWorkbenchListPickerDialog
          v-if="moveDialogVisible"
          v-model="moveDialogVisible"
          title="将文件移动到"
          confirm-label="移动"
          show-keyboard-hints
          searchable
          search-placeholder="搜索文件夹"
          :subtitle="moveDialogSourceName"
          :items="workspaceStore.directoryItems"
          :current-item-id="moveDialogCurrentDirectory"
          :loading="workspaceStore.directoriesLoading"
          :pending="workspaceStore.fileMovePending"
          :error="workspaceStore.fileMoveError"
          @confirm="handleMoveTabFile"
        />

        <div class="docking-three-group__body">
          <template v-for="tab in group.tabs" :key="tab.id">
            <!-- 插件实例由工作区持有，分组只提供显示位置。 -->
            <div
              v-if="tab.id === group.activeTabId || isPluginTab(tab)"
              v-show="tab.id === group.activeTabId"
              class="docking-three-group__panel"
              :ref="isPluginTab(tab) ? getPluginTargetRef(tab.id) : undefined"
            >
              <DockingThreePanel
                v-if="!isPluginTab(tab)"
                :scrollbar-top-inset="isHostPanelTab(tab) && tab.hostPanelId === 'right-sidebar-tags' ? 32 : 0"
              >
                <AsyncWorkbenchEditorPanel
                  v-if="isEditorTab(tab)"
                  :params="{ params: { tabId: tab.id, title: tab.title, label: tab.label, initialValue: tab.initialValue, filePath: tab.filePath } }"
                />
                <AsyncDockingThreeMediaPanel
                  v-else-if="isMediaTab(tab)"
                  :file-path="tab.filePath ?? ''"
                  :title="tab.title"
                  :media-mime-type="tab.mediaMimeType ?? ''"
                />
                <AsyncWorkbenchWelcomeTab
                  v-else-if="isWelcomeTab(tab)"
                  :group-id="group.id"
                  :tab-id="tab.id"
                />
                <AsyncSettingsDialog
                  v-else-if="isSettingsTab(tab)"
                  embedded
                  :initial-navigation-id="tab.settingsNavigationId"
                  @close="dockingThreeStore.closeTab(group.id, tab.id)"
                />
                <WsEditorTag
                  v-else-if="isHostPanelTab(tab) && tab.hostPanelId === 'right-sidebar-tags'"
                />
                <DockingThreePlaceholderPanel
                  v-else
                  :label="placeholderLabel"
                  :role="group.role"
                />
              </DockingThreePanel>
            </div>
          </template>
        </div>
      </template>
    </v-sheet>
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.docking-three-group {
  @include flex-column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ws-background);
}

.docking-three-group--editor {
  background: var(--ws-editor-background);
  color: var(--ws-editor-foreground);
}

.docking-three-group--bottom {
  background: var(--ws-editor-background);
  color: var(--ws-editor-foreground);
}

.docking-three-group--left-sidebar,
.docking-three-group--right-sidebar {
  background: var(--ws-sideBar-background);
  color: var(--ws-sideBar-foreground);
}

.docking-three-group-shell {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.docking-three-group--preview {
  border: $docking-preview-outline-width solid var(--ws-dockPreview-borderMuted);
  background: var(--ws-dockPreview-panel);
  opacity: 0.9;
}

.docking-three-group--preview-ghost {
  border: $docking-preview-outline-width solid var(--ws-dockPreview-border);
  border-color: var(--ws-dockPreview-border);
  background: var(--ws-dockPreview-panel);
  box-shadow: 0 0 0 1px var(--ws-dockPreview-border), 0 0 1rem var(--ws-dockPreview-shadow);
}

.docking-three-group__header {
  --workbench-scrollbar-hit-height: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-min-width: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb-height: #{$scrollbar-horizontal-thumb-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  display: flex;
  align-items: stretch;
  flex: 0 0 auto;
  min-width: 0;
  padding-right: 8px;
  min-height: $docking-group-header-height;
  max-height: $docking-group-header-height;
  background: var(--ws-editorGroupHeader-tabsBackground);
  border-bottom:1px solid var(--ws-tabs-borderBottom,var(--ws-border,transparent));
}

.docking-three-group--docked:not(.docking-three-group--top-edge) .docking-three-group__header {
  box-shadow: inset 0 1px 0 0 var(--ws-border);
}

.docking-three-group__header--preview {
  min-height: $dock-preview-header-height;
  max-height: $dock-preview-header-height;
  padding-inline: $spacing-xs;
  background: var(--ws-dockPreview-panel);
}

.docking-three-group__tab-strip {
  position: relative;
  align-self: stretch;
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
}

.docking-three-group__tabs {
  display: flex;
  align-items: stretch;
  min-width: 0;
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  overscroll-behavior-inline: contain;
  color: inherit;
}

.docking-three-group__tabs::-webkit-scrollbar {
  display: none;
}

.docking-three-group__tab {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: $spacing-xs;
  flex: 0 0 auto;
  user-select: none;
  min-width: $docking-tab-min-width;
  height: 100%;
  margin-block: auto;
  padding-inline: $docking-tab-padding-x $spacing-2xs;
  border: 0;
  background: transparent;
  color: var(--ws-tab-inactiveForeground);
  cursor: default;
  font-size: $docking-three-group-tabs-fontSize;
  line-height: 1;
  border-right: 1px solid var(--ws-tab-border,var(--ws-border,transparent));
}

.docking-three-group__tab-toolbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: $spacing-2xs;
}


.docking-three-group__tab--active {
  color: var(--ws-tab-activeForeground);
  background: var(--ws-tab-activeBackground);
  box-shadow: inset 0 1px 0 0 var(--ws-tab-activeBorderTop, var(--ws-tab-activeBorder));
}

.docking-three-group__tab--inactive {
  box-shadow: inset 0 2px 0 0 var(--ws-tab-inactiveTop);
}

.docking-three-group__tab-title {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
  line-height: 1.2;
}

.docking-three-group__tab--web-viewer {
  max-width: $docking-web-tab-max-width;
}

.docking-three-group__tab-favicon {
  flex: none;
  width: $icon-size-width;
  height: $icon-size-height;
  object-fit: contain;
}

.docking-three-group__tab-close {
  @include flex-center;
  flex: none;
  width: 1.25rem;
  height: 1.25rem;
  font-size: $font-size-md;
  line-height: 1;
  border-radius: $radius-xs;
  color: var(--ws-button-foreground);
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
}

.docking-three-group__tab-close:hover {
  background: var(--ws-button-hoverBackground);
  color: var(--ws-button-hoverForeground);
  opacity: 1;
}

.docking-three-group__tab--active .docking-three-group__tab-close,
.docking-three-group__tab:hover .docking-three-group__tab-close,
.docking-three-group__tab-close--dirty {
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
}

.docking-three-group__tab-close-icon {
  @include flex-center;
  width: 100%;
  height: 100%;
  font-size: $font-size-md;
  line-height: 1;
}

.docking-three-group__tab-close--dirty .docking-three-group__tab-close-icon--close {
  display: none;
}

.docking-three-group__tab-close--dirty:hover .docking-three-group__tab-close-icon--close {
  display: flex;
}

.docking-three-group__tab-close--dirty:hover .docking-three-group__tab-close-icon--dirty {
  display: none;
}

.docking-three-group__add-tab {
  @include flex-center;
  flex: none;
  width: $editor-header-action-width;
  min-width: $editor-header-action-width;
  height: $editor-header-action-width;
  margin: auto $spacing-2xs auto 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ws-tab-inactiveForeground);
  cursor: default;
  border-radius: $radius-xs;
}

.docking-three-group__more-tab-options {
  @include flex-center;
  flex: none;
  width: $editor-header-action-width;
  min-width: $editor-header-action-width;
  height: $editor-header-action-width;
  margin: auto 0;
  padding: 0;
  border: 0;
  border-radius: $radius-xs;
  background: transparent;
  color: var(--ws-tab-inactiveForeground);
  cursor: default;
}

.docking-three-group__add-tab:hover,
.docking-three-group__more-tab-options:hover,
.docking-three-group__tab:hover {
  color: var(--ws-tab-hoverForeground);
  background: var(--ws-tab-hoverBackground);
}

.docking-three-group__add-tab-icon {
  @include flex-center;
  width: $font-size-lg;
  height: $font-size-lg;
  font-size: $font-size-lg;
  line-height: 1;
}

.docking-three-group__more-tab-options-icon {
  @include flex-center;
  width: $font-size-lg;
  height: $font-size-lg;
  font-size: $font-size-lg;
  line-height: 1;
}

.docking-three-group__body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: inherit;
}

.docking-three-group__body--preview {
  @include flex-center;
  background: transparent;
}

.docking-three-group__body--preview-ghost {
  width: 100%;
  height: 100%;
  background: transparent;
}

.docking-three-group__panel {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.docking-three-group__preview-label {
  font-size: $font-size-sm;
  letter-spacing: 0.18em;
  color: inherit;
  text-transform: uppercase;
}

</style>
