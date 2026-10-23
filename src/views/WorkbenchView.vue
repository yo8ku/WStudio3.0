<script setup lang="ts">
/**
 * 文件说明：装配整个工作台页面，包括标题栏、活动栏、停靠布局区与状态栏。 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';

import {
  LEFT_SIDEBAR_GROUP_ID,
  RIGHT_SIDEBAR_GROUP_ID
} from '@/DockingThree/definitions';
import type { DockingThreeRailAction } from '@/DockingThree/types';
import { CommandCenterPanel, type CommandCenterItem } from '@/components/commandCenter';
import DockingThreeWorkspace from '@/DockingThree/DockingThreeWorkspace.vue';
import StatusBar from '@/components/workbench/StatusBar.vue';
import WorkbenchBreadcrumbs from '@/components/workbench/WorkbenchBreadcrumbs.vue';
import WorkbenchIconRail from '@/components/workbench/WorkbenchIconRail.vue';
import WorkbenchTitleBar from '@/components/workbench/WorkbenchTitleBar.vue';
import WorkbenchContextMenu from '@/components/workbench/WorkbenchContextMenu.vue';
import LoginDialog from '@/components/LoginDialog/LoginDialog.vue';
import AccountButton from '@/components/AccountButton/AccountButton.vue';
import { useAccountStore } from '@/store/account';
import { useDockingThreeStore } from '@/store/dockingThree';
import { usePluginStore } from '@/store/plugin';
import { useWorkspaceStore } from '@/store/workspace';
import { useShortcutStore } from '@/store/shortcuts';
import type { ProjectGradientPresentation } from '@/types/projectGradient';
import {
  getInitialPluginView,
  getInitialSettingsNavigationId,
  getWindowMode,
  shouldOpenInitialSettingsTab
} from '@/utils/windowMode';
import { editorHostApi } from '@/api/editor';
import { workspaceApi } from '@/api/workspace';
import { windowApi } from '@/api/window';
import type { WorkspaceFileEntry } from '@/types/ipc';
import type { WorkbenchContextMenuRequest } from '@/types/ipc';
import { registerWorkbenchContextMenuHandler } from '@/utils/workbenchContextMenu';

const ACTIVE_DOCUMENT_SYNC_DELAY = 80;
type StatusBarNavigationPosition = 'top' | 'status-bar' | 'hidden';

const dockingThreeStore = useDockingThreeStore();
const pluginStore = usePluginStore();
const workspaceStore = useWorkspaceStore();
const shortcutStore = useShortcutStore();
const accountStore = useAccountStore();
const isTabWindow = getWindowMode() === 'tab';
const initialSettingsNavigationId = getInitialSettingsNavigationId();
const openInitialSettingsTab = shouldOpenInitialSettingsTab();
if (isTabWindow) dockingThreeStore.configureTabWindow();
const isCommandCenterVisible = ref(false);
const isSettingsWindowOpen = ref(false);
const isLoginDialogOpen = ref(false);
const navigationPosition = ref<StatusBarNavigationPosition>('top');
const projectGradientPresentation = ref<ProjectGradientPresentation>({
  enabled: false,
  colorClass: 'ws-project-gradient--grass-green',
  style: undefined
});
const {
  leftSidebarOpen,
  leftSidebarRailSections,
  activeLeftSidebarPanelId,
  rightSidebarOpen,
  rightSidebarRailSections,
  activeRightSidebarPanelId,
  activeEditorTab,
  activeWorkspaceFilePath,
  editorDocuments,
  editorSelections
} = storeToRefs(dockingThreeStore);
const showLeftActivityRail = computed(() =>
  !isTabWindow
);
const showRightActivityRail = computed(() =>
  rightSidebarRailSections.value.length > 0 || Boolean(dockingThreeStore.activeTabDrag)
);
const { repository, workspaceFiles } = storeToRefs(workspaceStore);
const { contributions: pluginContributions } = storeToRefs(pluginStore);
const pendingContextMenu = shallowRef<{
  request: WorkbenchContextMenuRequest;
  resolve: (actionId?: string) => void;
}>();

watch(() => accountStore.loginRequestId, (requestId, previousRequestId) => {
  if (!isTabWindow && requestId !== previousRequestId) {
    isLoginDialogOpen.value = true;
  }
});
let disposeContextMenuHandler: (() => void) | undefined;
let stopSettingsWindowStateListener: (() => void) | undefined;

function resolvePendingContextMenu(actionId?: string): void {
  const pending = pendingContextMenu.value;
  pendingContextMenu.value = undefined;
  pending?.resolve(actionId);
}
const workbenchGradientClass = computed(() => (
  projectGradientPresentation.value.enabled
    ? ['ws-project-gradient', projectGradientPresentation.value.colorClass]
    : undefined
));
const workbenchGradientStyle = computed(() => (
  projectGradientPresentation.value.enabled
    ? projectGradientPresentation.value.style
    : undefined
));

/** 接收标题栏颜色控件发布的状态，并统一驱动工作台父级渐变背景。 */
function updateProjectGradientPresentation(presentation: ProjectGradientPresentation): void {
  projectGradientPresentation.value = presentation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 处理文件列表插件发出的外部文件拖拽开始事件。 */
function handleExternalFileDragStart(event: Event): void {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  if (!isRecord(detail) || typeof detail.path !== 'string') return;
  const title = typeof detail.title === 'string' ? detail.title : detail.path;
  dockingThreeStore.startExternalFileDrag(detail.path, title);
}

/** 更新文件拖拽在 DockingThree 编辑区内的停靠预览。 */
function handleExternalFileDragMove(event: Event): void {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  if (
    !isRecord(detail)
    || typeof detail.clientX !== 'number'
    || typeof detail.clientY !== 'number'
    || !Number.isFinite(detail.clientX)
    || !Number.isFinite(detail.clientY)
  ) return;
  dockingThreeStore.updateExternalFileDrag(detail.clientX, detail.clientY);
}

/** 完成外部文件停靠，再由主进程验证并读取文件内容。 */
async function handleExternalFileDragEnd(): Promise<void> {
  const result = dockingThreeStore.completeExternalFileDrag();
  if (!result) return;
  let request: Awaited<ReturnType<typeof workspaceApi.openFile>>;
  try {
    request = await workspaceApi.openFile(result.path);
  } catch {
    dockingThreeStore.discardExternalFileTab(result.tabId);
    return;
  }
  if (!request) {
    dockingThreeStore.discardExternalFileTab(result.tabId);
    return;
  }
  if (repository.value?.id !== request.repositoryId) {
    dockingThreeStore.discardExternalFileTab(result.tabId);
    return;
  }
  dockingThreeStore.hydrateExternalFileTab(result.tabId, request);
}

function handleExternalFileDragEndEvent(): void {
  void handleExternalFileDragEnd();
}

/** 取消文件列表外部拖拽并清除编辑区预览。 */
function handleExternalFileDragCancel(): void {
  dockingThreeStore.cancelExternalFileDrag();
}

/** 从路径菜单打开可读取的 Markdown 文件，保持文件打开流程集中在工作台视图。 */
async function handleBreadcrumbFileSelect(file: WorkspaceFileEntry): Promise<void> {
  const repositoryId = repository.value?.id;
  if (!repositoryId) return;

  const document = await workspaceApi.readMarkdownFile(file.path);
  if (!document) return;

  dockingThreeStore.openWorkspaceFile({
    repositoryId,
    filePath: file.path,
    relativePath: file.relativePath,
    title: file.name,
    kind: 'text',
    content: document.content
  });
}

/** 返回仓库根节点与当前文件相对路径，禁止向导航泄露本机绝对路径。 */
const activeEditorBreadcrumbItems = computed(() => {
  const repositoryName = repository.value?.name ?? 'WStudio3.0';
  const relativePathSegments = activeEditorTab.value?.relativePath
    ?.split(/[\\/]+/u)
    .filter(segment => segment.trim().length > 0);

  return relativePathSegments?.length
    ? [repositoryName, ...relativePathSegments]
    : [repositoryName];
});

/** 无活动文件时始终显示仓库根节点；活动编辑器继续遵循标签级显隐设置。 */
const activeEditorBreadcrumbsVisible = computed(() => (
  !activeEditorTab.value
  || !activeWorkspaceFilePath.value
  || dockingThreeStore.isPathNavigationVisible(activeEditorTab.value.id)
));
const showTopPathNavigation = computed(() => (
  activeEditorBreadcrumbsVisible.value
  && navigationPosition.value === 'top'
));
const showStatusBarPathNavigation = computed(() => (
  activeEditorBreadcrumbsVisible.value
  && navigationPosition.value === 'status-bar'
));

/** 判断当前路径导航是否处于仓库根路径空态。 */
const isRepositoryRootBreadcrumbs = computed(() => !activeWorkspaceFilePath.value);

/** Returns the active editor cursor position as a compact line and column label. */
const activeLineColumn = computed(() => {
  const tab = activeEditorTab.value;
  if (!tab) return '';

  const content = editorDocuments.value[tab.id] ?? '';
  const selectionEnd = editorSelections.value[tab.id]?.end ?? 0;
  const position = Math.max(0, Math.min(content.length, selectionEnd));
  const beforeCursor = content.slice(0, position);
  const line = beforeCursor.split('\n').length;
  const column = position - beforeCursor.lastIndexOf('\n');
  return `${line}:${column}`;
});

/** 生成公开 Editor SDK 可见的活动编辑器内存快照。 */
const activeEditorDocument = computed(() => {
  const tab = activeEditorTab.value;
  const path = activeWorkspaceFilePath.value;
  if (!tab || !path) return undefined;
  const selection = editorSelections.value[tab.id];
  return {
    path,
    content: editorDocuments.value[tab.id] ?? '',
    selection: selection
      ? { start: selection.start, end: selection.end }
      : { start: 0, end: 0 }
  };
});
let activeDocumentSyncTimer: ReturnType<typeof setTimeout> | undefined;
let stopOpenSettingsTabListener: (() => void) | undefined;
let activityReportTimer: ReturnType<typeof setTimeout> | undefined;

/** 合并连续输入事件，避免把高频交互逐次穿越 IPC。 */
function reportActivity(): void {
  if (activityReportTimer) return;
  activityReportTimer = setTimeout(() => {
    activityReportTimer = undefined;
    void windowApi.reportActivity();
  }, 1_000);
}

/** 合并连续输入产生的快照更新，避免每次按键都穿越 IPC。 */
watch(activeEditorDocument, document => {
  if (activeDocumentSyncTimer) clearTimeout(activeDocumentSyncTimer);
  activeDocumentSyncTimer = setTimeout(() => {
    activeDocumentSyncTimer = undefined;
    void editorHostApi.setActiveDocument(document);
  }, ACTIVE_DOCUMENT_SYNC_DELAY);
}, { immediate: true });

const builtInCommandCenterItems: readonly CommandCenterItem[] = [
  {
    id: 'open-file',
    title: '打开文件',
    description: '快速打开一个文件并在当前编辑区中聚焦。',
    group: '文件',
    shortcut: 'Ctrl+P'
  },
  {
    id: 'new-file',
    title: '新建文件',
    description: '在当前编辑器组中创建一个新的空白标签页。',
    group: '文件',
    shortcut: 'Ctrl+N'
  },
  {
    id: 'open-folder',
    title: '打开文件夹',
    description: '选择一个目录并在工作台中加载它的资源结构。',
    group: '文件',
    shortcut: 'Ctrl+K Ctrl+O'
  },
  {
    id: 'save-all',
    title: '全部保存',
    description: '保存当前工作区中所有已修改的文件。',
    group: '文件',
    shortcut: 'Ctrl+K S'
  },
  {
    id: 'toggle-sidebar',
    title: '切换左侧边栏',
    description: '展开或收起左侧侧边栏区域。',
    group: '布局',
    shortcut: 'Ctrl+B'
  },
  {
    id: 'toggle-right-sidebar',
    title: '切换右侧边栏',
    description: '展开或收起右侧侧边栏区域。',
    group: '布局',
    shortcut: 'Ctrl+Alt+B'
  },
  {
    id: 'split-editor',
    title: '拆分编辑器',
    description: '在主编辑区中创建新的编辑器标签组。',
    group: '布局',
    shortcut: 'Ctrl+\\'
  },
  {
    id: 'split-editor-down',
    title: '向下拆分编辑器',
    description: '在当前编辑器组下方创建新的编辑器标签组。',
    group: '布局',
    shortcut: 'Ctrl+K Ctrl+Down'
  },
  {
    id: 'change-theme',
    title: '切换主题',
    description: '后续会接入主题切换命令，目前仅用于命令中心展示。',
    group: '外观'
  },
  {
    id: 'toggle-zen-mode',
    title: '切换专注模式',
    description: '隐藏多余界面元素，只保留核心编辑区域。',
    group: '外观',
    shortcut: 'Ctrl+K Z'
  },
  {
    id: 'open-settings',
    title: '打开设置',
    description: '进入工作台设置与偏好配置入口。',
    group: '系统',
    shortcut: 'Ctrl+,'
  },
  {
    id: 'reload-window',
    title: '重新加载窗口',
    description: '刷新当前工作台窗口并重新装载界面。',
    group: '系统',
    shortcut: 'Ctrl+R'
  },
  {
    id: 'open-command-center',
    title: '打开命令中心',
    description: '显示命令中心并聚焦到命令输入框。',
    group: '系统',
    shortcut: 'F1'
  },
  {
    id: 'reopen-editor',
    title: '重新打开已关闭编辑器',
    description: '恢复最近一个被关闭的编辑器标签页。',
    group: '编辑器',
    shortcut: 'Ctrl+Shift+T'
  },
  {
    id: 'close-editor-group',
    title: '关闭编辑器组',
    description: '关闭当前编辑器标签组并释放该区域。',
    group: '编辑器',
    shortcut: 'Ctrl+K W'
  },
  {
    id: 'next-editor-group',
    title: '聚焦右侧编辑器组',
    description: '把焦点切换到右侧相邻的编辑器组。',
    group: '编辑器',
    shortcut: 'Ctrl+K Ctrl+Right'
  },
  {
    id: 'previous-editor-group',
    title: '聚焦左侧编辑器组',
    description: '把焦点切换到左侧相邻的编辑器组。',
    group: '编辑器',
    shortcut: 'Ctrl+K Ctrl+Left'
  },
  {
    id: 'toggle-terminal',
    title: '切换终端面板',
    description: '显示或隐藏内置终端面板区域。',
    group: '终端',
    shortcut: 'Ctrl+`'
  },
  {
    id: 'new-terminal',
    title: '新建终端',
    description: '创建一个新的终端会话标签页。',
    group: '终端',
    shortcut: 'Ctrl+Shift+`'
  },
  {
    id: 'run-task',
    title: '运行任务',
    description: '打开任务列表并执行预定义任务。',
    group: '任务',
    shortcut: 'Ctrl+Shift+B'
  },
  {
    id: 'debug-start',
    title: '启动调试',
    description: '开始当前工作区的调试流程。',
    group: '调试',
    shortcut: 'F5'
  },
  {
    id: 'debug-stop',
    title: '停止调试',
    description: '终止当前调试会话。',
    group: '调试',
    shortcut: 'Shift+F5'
  },
  {
    id: 'view-problems',
    title: '查看问题',
    description: '打开问题列表并聚焦到错误与警告。',
    group: '视图',
    shortcut: 'Ctrl+Shift+M'
  },
  {
    id: 'view-explorer',
    title: '聚焦资源管理器',
    description: '切换到左侧资源管理器面板。',
    group: '视图',
    shortcut: 'Ctrl+Shift+E'
  },
  {
    id: 'view-search',
    title: '聚焦搜索',
    description: '切换到全局搜索面板。',
    group: '视图',
    shortcut: 'Ctrl+Shift+F'
  },
  {
    id: 'view-source-control',
    title: '聚焦源代码管理',
    description: '切换到源代码管理面板。',
    group: '视图',
    shortcut: 'Ctrl+Shift+G'
  },
  {
    id: 'quick-open-recent',
    title: '打开最近项目',
    description: '显示最近访问过的项目与工作区列表。',
    group: '文件',
    shortcut: 'Ctrl+R'
  },
  {
    id: 'duplicate-editor',
    title: '复制当前标签页',
    description: '在当前组中复制一个新的编辑器标签页。',
    group: '编辑器',
    shortcut: 'Ctrl+K Ctrl+D'
  },
  {
    id: 'format-document',
    title: '格式化文档',
    description: '按照当前格式化规则重新整理文档内容。',
    group: '编辑器',
    shortcut: 'Shift+Alt+F'
  },
  {
    id: 'rename-symbol',
    title: '重命名符号',
    description: '在当前文件或工作区内重命名光标所在符号。',
    group: '编辑器',
    shortcut: 'F2'
  },
  {
    id: 'toggle-word-wrap',
    title: '切换自动换行',
    description: '为当前编辑器开启或关闭自动换行。',
    group: '编辑器',
    shortcut: 'Alt+Z'
  },
  {
    id: 'go-to-line',
    title: '转到行',
    description: '根据行号快速跳转到目标位置。',
    group: '导航',
    shortcut: 'Ctrl+G'
  },
  {
    id: 'go-to-symbol',
    title: '转到文件内符号',
    description: '在当前文件的符号列表中快速跳转。',
    group: '导航',
    shortcut: 'Ctrl+Shift+O'
  },
  {
    id: 'go-to-definition',
    title: '转到定义',
    description: '跳转到当前符号的定义位置。',
    group: '导航',
    shortcut: 'F12'
  },
  {
    id: 'peek-definition',
    title: '预览定义',
    description: '以内联方式查看当前符号定义。',
    group: '导航',
    shortcut: 'Alt+F12'
  },
  {
    id: 'reveal-active-file',
    title: '在资源管理器中定位文件',
    description: '让左侧资源管理器定位到当前活动文件。',
    group: '导航',
    shortcut: 'Ctrl+K R'
  },
  {
    id: 'copy-relative-path',
    title: '复制相对路径',
    description: '复制当前文件相对于工作区的路径。',
    group: '文件',
    shortcut: 'Alt+Shift+C'
  },
  {
    id: 'compare-active-with-saved',
    title: '与已保存版本比较',
    description: '打开当前文件与上次保存版本的差异视图。',
    group: '文件'
  },
  {
    id: 'open-keyboard-shortcuts',
    title: '打开键盘快捷方式',
    description: '查看并搜索所有快捷键绑定。',
    group: '系统',
    shortcut: 'Ctrl+K Ctrl+S'
  },
  {
    id: 'toggle-devtools',
    title: '切换开发者工具',
    description: '显示或隐藏开发者工具窗口。',
    group: '系统',
    shortcut: 'Ctrl+Shift+I'
  },
  {
    id: 'show-command-history',
    title: '显示命令历史',
    description: '查看最近执行过的命令中心记录。',
    group: '系统'
  }
] as const;

const commandCenterItems = computed<readonly CommandCenterItem[]>(() => [
  ...builtInCommandCenterItems.filter(item => item.action),
  ...pluginContributions.value.flatMap((contribution) => [
    ...contribution.commands.map((command) => ({
      id: `plugin-command:${contribution.pluginId}:${command.id}`,
      title: command.title,
      description: command.description ?? `执行 ${contribution.pluginName} 提供的命令。`,
      group: contribution.pluginName,
      action: {
        type: 'plugin-command' as const,
        pluginId: contribution.pluginId,
        commandId: command.id
      }
    })),
    ...contribution.views.map((view) => ({
      id: `plugin-view:${contribution.pluginId}:${view.type}`,
      title: `打开 ${view.title}`,
      description: `打开 ${contribution.pluginName} 提供的工作台视图。`,
      group: contribution.pluginName,
      action: {
        type: 'plugin-view' as const,
        pluginId: contribution.pluginId,
        viewType: view.type
      }
    }))
  ])
]);

/**
 * 打开命令中心浮层。 */
function openCommandCenter(): void {
  isCommandCenterVisible.value = true;
}

/** 打开无边框搜索子窗口，同时收起命令中心；设置窗口存在时由宿主互斥拦截。 */
function openSearch(): void {
  if (isSettingsWindowOpen.value) return;
  isCommandCenterVisible.value = false;
  void windowApi.openSearchWindow();
}

/** 打开唯一的独立设置窗口，并同步主工作台入口状态。 */
function openSettings(navigationId?: string): void {
  isSettingsWindowOpen.value = true;
  void windowApi.openSettings(navigationId).catch(() => {
    isSettingsWindowOpen.value = false;
  });
}

/**
 * 关闭命令中心浮层。 */
function closeCommandCenter(): void {
  isCommandCenterVisible.value = false;
}

/** 处理命令中心选中项，并转发插件命令或打开插件视图。 */
async function handleCommandCenterSelect(item: CommandCenterItem): Promise<void> {
  if (!item.action) {
    return;
  }

  if (item.action.type === 'plugin-command') {
    await pluginStore.executeCommand(item.action.pluginId, item.action.commandId);
  } else {
    const viewAction = item.action;
    const contribution = pluginContributions.value
      .find((candidate) => candidate.pluginId === viewAction.pluginId);
    const view = contribution?.views.find((candidate) => candidate.type === viewAction.viewType);

    if (view) {
      dockingThreeStore.openPluginView(viewAction.pluginId, view);
    }
  }

  closeCommandCenter();
}

/**
 * 处理左侧活动栏标签点击，切换对应侧边栏面板。 */
function handleActivityBarSelect(panelId: string): void {
  dockingThreeStore.handleSidebarRailSelect('left', panelId);
}

/**
 * 处理左侧活动栏动作，直接打开独立设置子窗口。
 */
function handleActivityBarAction(action: DockingThreeRailAction): void {
  if (action === 'open-settings') {
    openSettings();
  }
}

/**
 * 处理右侧活动栏标签点击，切换对应侧边栏面板。 */
function handleRightSidebarRailSelect(panelId: string): void {
  dockingThreeStore.handleSidebarRailSelect('right', panelId);
}

/** 为全部已运行插件打开公开声明为启动显示的视图。 */
function openStartupPluginViews(): void {
  for (const contribution of pluginContributions.value) {
    const view = contribution.views.find((candidate) => candidate.openOnStartup);

    if (view) {
      dockingThreeStore.openPluginView(contribution.pluginId, view);
    }
  }
}

/** 初始化插件状态、贡献并打开 manifest 声明的启动视图。 */
async function initializePlugins(): Promise<void> {
  pluginStore.initialize();
  await pluginStore.refresh();
  await pluginStore.refreshContributions();
  openStartupPluginViews();
}

/** 在独立标签窗口中挂载主进程指定的单个插件视图。 */
async function initializeTabWindowPluginView(): Promise<void> {
  const initialPluginView = getInitialPluginView();
  if (!initialPluginView) return;
  await pluginStore.refreshContributions();
  await pluginStore.handleViewOpenRequested(initialPluginView);
}

/**
 * 将左侧活动栏标签纳入停靠拖拽流程。 */
function handleLeftSidebarRailPointerDown(tabId: string, event: PointerEvent): void {
  if (event.button !== 0) return;
  dockingThreeStore.beginPendingTabDrag(tabId, LEFT_SIDEBAR_GROUP_ID, event.clientX, event.clientY);
}

/** 通过文件列表插件公开命令打开仓库管理子窗口。 */
async function openRepositoryManager(): Promise<void> {
  await windowApi.openRepositoryManager();
}

/**
 * 将右侧活动栏标签纳入停靠拖拽流程。 */
function handleRightSidebarRailPointerDown(tabId: string, event: PointerEvent): void {
  if (event.button !== 0) return;
  dockingThreeStore.beginPendingTabDrag(tabId, RIGHT_SIDEBAR_GROUP_ID, event.clientX, event.clientY);
}

/** 保存当前活动编辑器，忽略未关联工作区文件的临时标签。 */
function saveActiveEditor(): void {
  void workspaceStore.saveActiveEditor();
}

/** 监听工作台级快捷键，用于保存当前文件与呼出或关闭命令中心。 */
function matchesShortcut(event: KeyboardEvent, binding: string): boolean {
  const normalizedBinding = binding.trim();
  if (!normalizedBinding || normalizedBinding.includes(' ')) return false;

  const parts = new Set(normalizedBinding.split('+').filter(Boolean));
  const expectedKey = [...parts].find(part => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(part));
  if (!expectedKey) return false;

  const actualKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (actualKey !== expectedKey) return false;

  const primaryModifierMatches = parts.has('Ctrl')
    ? event.ctrlKey || event.metaKey
    : !event.ctrlKey;

  return primaryModifierMatches
    && event.altKey === parts.has('Alt')
    && event.shiftKey === parts.has('Shift')
    && (parts.has('Meta') ? event.metaKey : !event.metaKey || parts.has('Ctrl'));
}

function handleWindowKeydown(event: KeyboardEvent): void {
  if (matchesShortcut(event, shortcutStore.getBinding('保存当前文件'))) {
    event.preventDefault();
    event.stopPropagation();
    saveActiveEditor();
    return;
  }

  if (matchesShortcut(event, shortcutStore.getBinding('打开命令中心'))) {
    event.preventDefault();
    openCommandCenter();
    return;
  }

  if (event.key === 'Escape' && isCommandCenterVisible.value) {
    event.preventDefault();
    closeCommandCenter();
  }
}

/**
 * 注册工作台级快捷键监听。 */
onMounted(() => {
  if (!isTabWindow) void accountStore.restore();
  // 开发态记录导航至工作台首帧的耗时，区分页面加载与 Cargo 编译时间。
  if (import.meta.env.DEV) {
    requestAnimationFrame(() => {
      console.info('[startup] workbench', JSON.stringify({
        readyMs: Math.round(performance.now()),
        resourceCount: performance.getEntriesByType('resource').length
      }));
    });
  }
  disposeContextMenuHandler = registerWorkbenchContextMenuHandler(request => new Promise(resolve => {
    pendingContextMenu.value = { request, resolve };
  }));
  window.addEventListener('keydown', handleWindowKeydown, true);
  window.addEventListener('pointerdown', reportActivity, true);
  window.addEventListener('input', reportActivity, true);
  window.addEventListener('wheel', reportActivity, { capture: true, passive: true });
  window.addEventListener('focus', reportActivity);
  window.addEventListener('wstudio:file-drag-start', handleExternalFileDragStart);
  window.addEventListener('wstudio:file-drag-move', handleExternalFileDragMove);
  window.addEventListener('wstudio:file-drag-end', handleExternalFileDragEndEvent);
  window.addEventListener('wstudio:file-drag-cancel', handleExternalFileDragCancel);
  reportActivity();
  stopOpenSettingsTabListener = windowApi.onOpenSettingsTabRequested((event) => {
    dockingThreeStore.openSettingsTab(event.navigationId);
  });
  stopSettingsWindowStateListener = windowApi.onSettingsWindowState((event) => {
    isSettingsWindowOpen.value = event.open;
  });
  if (openInitialSettingsTab || initialSettingsNavigationId) {
    dockingThreeStore.openSettingsTab(initialSettingsNavigationId);
  }
  void initializeWorkbenchWorkspace();
  if (isTabWindow) void initializeTabWindowPluginView();
  else void initializePlugins();
});

/** 初始化工作区并处理独立窗口 URL 携带的初始文件请求。 */
async function initializeWorkbenchWorkspace(): Promise<void> {
  await workspaceStore.initialize();
}

/**
 * 释放工作台级快捷键监听。 */
onBeforeUnmount(() => {
  pendingContextMenu.value?.resolve();
  pendingContextMenu.value = undefined;
  disposeContextMenuHandler?.();
  disposeContextMenuHandler = undefined;
  if (activeDocumentSyncTimer) clearTimeout(activeDocumentSyncTimer);
  if (activityReportTimer) clearTimeout(activityReportTimer);
  void editorHostApi.setActiveDocument(undefined);
  window.removeEventListener('keydown', handleWindowKeydown, true);
  window.removeEventListener('pointerdown', reportActivity, true);
  window.removeEventListener('input', reportActivity, true);
  window.removeEventListener('wheel', reportActivity, true);
  window.removeEventListener('focus', reportActivity);
  window.removeEventListener('wstudio:file-drag-start', handleExternalFileDragStart);
  window.removeEventListener('wstudio:file-drag-move', handleExternalFileDragMove);
  window.removeEventListener('wstudio:file-drag-end', handleExternalFileDragEndEvent);
  window.removeEventListener('wstudio:file-drag-cancel', handleExternalFileDragCancel);
  stopOpenSettingsTabListener?.();
  stopOpenSettingsTabListener = undefined;
  stopSettingsWindowStateListener?.();
  stopSettingsWindowStateListener = undefined;
  workspaceStore.dispose();
  pluginStore.dispose();
});
</script>

<template>
  <v-app class="workbench-app">
    <v-layout
      class="workbench-layout d-flex flex-column"
      :class="workbenchGradientClass"
      :style="workbenchGradientStyle"
    >
      <!-- S = 标题栏 -->
      <WorkbenchTitleBar
        @open-search="openSearch"
        :controls-disabled="isSettingsWindowOpen"
        @open-settings="openSettings"
        @open-repository-manager="openRepositoryManager"
        @update:project-gradient="updateProjectGradientPresentation"
      >
        <template #after>
          <!-- S = 路径导航 -->
          <WorkbenchBreadcrumbs
            v-if="showTopPathNavigation"
            :items="activeEditorBreadcrumbItems"
            :workspace-files="workspaceFiles"
            :trailing-divider="isRepositoryRootBreadcrumbs"
            class="workbench-path-navigation"
            @select-file="handleBreadcrumbFileSelect"
          />
          <!-- E = 路径导航 -->
        </template>
        <template #account>
          <!-- S = AccountButton -->
          <AccountButton
            :disabled="isSettingsWindowOpen"
            @login="isLoginDialogOpen = true"
          />
          <!-- E = AccountButton -->
        </template>
      </WorkbenchTitleBar>
      <!-- E = 标题栏 -->

      <v-sheet class="workbench-shell d-flex" color="transparent">
          <v-sheet
            v-if="!isTabWindow"
            class="workbench-activity-bar"
            v-show="showLeftActivityRail"
          >
          <!-- S = 左侧活动栏 -->
          <WorkbenchIconRail
            v-if="!isTabWindow"
            position="left"
            :sections="leftSidebarRailSections"
            :active-tab-id="activeLeftSidebarPanelId"
            :sidebar-open="leftSidebarOpen"
            :disabled="isSettingsWindowOpen"
            :highlight-active-when-collapsed="false"
            separator-side="right"
            :show-separator="!leftSidebarOpen"
            @select="handleActivityBarSelect"
            @action="handleActivityBarAction"
            @tab-pointerdown="handleLeftSidebarRailPointerDown"
          />
          <!-- E = 左侧活动栏 -->
        </v-sheet>

        <v-main
          class="workbench-main pa-0"
          :class="{
            'workbench-main--left-sidebar-empty': !showLeftActivityRail,
            'workbench-main--right-sidebar-empty': !showRightActivityRail
          }"
        >
          <v-sheet
            class="workbench-docking-shell"
            color="transparent"
          >
            <!-- S = 停靠工作区 -->
            <DockingThreeWorkspace />
            <!-- E = 停靠工作区 -->
          </v-sheet>

          <!-- S = 右侧活动栏 -->
          <WorkbenchIconRail
            v-if="!isTabWindow"
            v-show="showRightActivityRail"
            position="right"
            :sections="rightSidebarRailSections"
            :active-tab-id="activeRightSidebarPanelId"
            :sidebar-open="rightSidebarOpen"
            :disabled="isSettingsWindowOpen"
            separator-side="left"
            :show-separator="!rightSidebarOpen"
            @select="handleRightSidebarRailSelect"
            @tab-pointerdown="handleRightSidebarRailPointerDown"
          />
          <!-- E = 右侧活动栏 -->
        </v-main>

        <!-- S = 命令中心 -->
        <CommandCenterPanel
          v-if="!isTabWindow && isCommandCenterVisible"
          :items="commandCenterItems"
          @request-close="closeCommandCenter"
          @select="handleCommandCenterSelect"
        />
        <!-- E = 命令中心 -->

      </v-sheet>

      <!-- S = 状态栏 -->
      <StatusBar
        v-if="!isTabWindow"
        :active-line-column="activeLineColumn"
        :navigation-items="activeEditorBreadcrumbItems"
        :navigation-workspace-files="workspaceFiles"
        :navigation-position="navigationPosition"
        :navigation-trailing-divider="isRepositoryRootBreadcrumbs"
        :navigation-visible="showStatusBarPathNavigation"
        @select-navigation-file="handleBreadcrumbFileSelect"
        @update:navigation-position="navigationPosition = $event"
      />
      <!-- E = 状态栏 -->
    </v-layout>
    <!-- S = LoginDialog -->
    <LoginDialog
      v-if="!isTabWindow"
      v-model="isLoginDialogOpen"
      :restore-existing="false"
    />
    <!-- E = LoginDialog -->
    <WorkbenchContextMenu
      v-if="pendingContextMenu"
      :items="pendingContextMenu.request.items"
      :x="pendingContextMenu.request.x"
      :y="pendingContextMenu.request.y"
      @select="resolvePendingContextMenu"
      @dismiss="resolvePendingContextMenu()"
    />
  </v-app>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.workbench-app {
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
}

.workbench-layout {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--ws-titleBar-activeBackground);
  overflow: hidden;
}

.workbench-layout.ws-project-gradient {
  background-image:
    linear-gradient(
      to right,
      var(--ws-activityBar-background) 0,
      var(--ws-activityBar-background) $icon-rail-width,
      rgb(from var(--ws-activityBar-background) r g b / $project-color-gradient-end-opacity)
        $project-color-gradient-peak-stop
    ),
    radial-gradient(
      ellipse $project-color-gradient-width $project-color-gradient-height
        at $project-color-gradient-peak-stop 0,
      rgb(from var(--ws-project-color) r g b / $project-color-gradient-peak-opacity) 0,
      rgb(from var(--ws-project-color) r g b / $project-color-gradient-end-opacity) 100%
    );
}

.workbench-shell {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workbench-path-navigation {
  flex: none;
  min-width: 0;
}

.workbench-activity-bar {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: $icon-rail-width;
  background: var(--ws-activityBar-background);
}

.workbench-main {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workbench-docking-shell {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workbench-main--left-sidebar-empty .workbench-docking-shell {
  margin-inline-start: $spacing-2xs;
}

.workbench-main--right-sidebar-empty .workbench-docking-shell {
  margin-inline-end: $spacing-2xs;
}
</style>
