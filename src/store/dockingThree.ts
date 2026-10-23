/**
 * 文件说明：统一管理 DockingThree 布局树、侧边栏开关、标签拖拽与分割条缩放状态。
 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import {
  CENTER_COLUMN_NODE_ID,
  DEFAULT_EDITOR_GROUP_ID,
  DEFAULT_LEFT_SIDEBAR_PANEL_ID,
  DEFAULT_RIGHT_SIDEBAR_PANEL_ID,
  LEFT_SIDEBAR_LANE_ID,
  LEFT_SIDEBAR_GROUP_ID,
  LEFT_SIDEBAR_TOP_ID,
  LEFT_SIDEBAR_BOTTOM_ID,
  LEFT_SIDEBAR_BOTTOM_GROUP_ID,
  RIGHT_SIDEBAR_LANE_ID,
  RIGHT_SIDEBAR_GROUP_ID,
  RIGHT_SIDEBAR_TOP_ID,
  RIGHT_SIDEBAR_BOTTOM_ID,
  RIGHT_SIDEBAR_BOTTOM_GROUP_ID,
  rightSidebarPanels
} from '@/DockingThree/definitions';
import {
  buildInitialDockingTree,
  buildEditorOnlyDockingTree,
  collapseEmptySidebarBottomContainer,
  cloneNode,
  createEditorGroup,
  createWorkbenchGroup,
  createEditorTab,
  createMediaTab,
  createSettingsTab,
  createPluginTab,
  createWelcomeTab,
  ensureSidebarBottomContainer,
  appendGroupToSplit,
  appendNodeToSplit,
  findFirstEditorGroup,
  findGroupById,
  findNodePathById,
  findTabById,
  insertTabIntoGroup,
  removeGroupById,
  removeTabFromGroup,
  ROOT_DEFAULT_SIDEBAR_SIZE,
  setGroupActiveTab,
  splitNodeWithNestedGroup,
  splitNodeWithNestedNode,
  splitNodeWithNewGroup,
  splitNodeWithNewNode,
  updateGroupById,
  removeNodeByIdPreservingParent,
  updateSplitById
} from '@/DockingThree/tree';
import type {
  DockingThreeActivityRailBounds,
  DockingThreeActivityRailPreview,
  DockingThreeDropDirection,
  DockingThreeDropTarget,
  DockingThreeGroupBounds,
  DockingThreeGroupNode,
  DockingThreeIconRailSection,
  DockingThreeIndicatorBounds,
  DockingThreeNode,
  DockingThreeSidebarPanelDefinition,
  DockingThreeSplitNode,
  DockingThreeSidebarDockTarget,
  DockingThreeSidebarPosition,
  DockingThreeTab
} from '@/DockingThree/types';
import type {
  PluginEditorRange,
  PluginEditorVerticalAlignment,
  PluginViewContributionSummary,
  WebViewerTabSummary
} from '../../plugin/sdk';
import type { WorkspaceOpenFileRequest } from '@/types/ipc';
import { nativeApi } from '@/api/native';
import { resolveDocumentTypeLabel } from '@/utils/documentTypeLabel';
import { getWindowMode } from '@/utils/windowMode';
import { closeInlineChat } from '@editor/InlineChat/inlineChatLifecycle';

const TAB_DRAG_THRESHOLD = 6;
const DROP_EDGE_THRESHOLD = 40;
const MIN_RESIZE_RATIO = 0.12;
const ROOT_SPLIT_ID = 'dock-split-root';
const ROOT_LEFT_SIDEBAR_INDEX = 0;
const ROOT_CENTER_COLUMN_INDEX = 1;
const ROOT_RIGHT_SIDEBAR_INDEX = 2;
const GROUP_HEADER_DROP_HEIGHT = 32;
const EDITOR_CENTER_DROP_BAND_HEIGHT = 96;
const HORIZONTAL_DROP_EDGE_RATIO = 0.2;
const HORIZONTAL_DROP_EDGE_MAX_WIDTH = 160;
const VERTICAL_DROP_EDGE_RATIO = 0.14;
const VERTICAL_DROP_EDGE_MAX_HEIGHT = 96;
const EDITOR_BODY_TOP_ZONE_RATIO = 0.22;
const EDITOR_BODY_BOTTOM_ZONE_RATIO = 0.34;
const EDITOR_BODY_SIDE_ZONE_RATIO = 0.28;
// Activity rails are fixed to the workbench edges. Keep a generous edge hit
// zone so a drag cannot fall through to a sidebar group's top/bottom target.
const ACTIVITY_RAIL_DROP_PADDING = 20;
const ACTIVITY_RAIL_FALLBACK_WIDTH = 64;

interface PendingTabDrag {
  tabId: string;
  sourceGroupId: string;
  startX: number;
  startY: number;
}

interface ActiveTabDrag {
  tabId: string;
  sourceGroupId: string;
  pointerX: number;
  pointerY: number;
  target?: DockingThreeDropTarget;
}

interface ExternalFileDrag {
  path: string;
  title: string;
  tabId: string;
  pointerX: number;
  pointerY: number;
  target?: DockingThreeDropTarget;
}

export interface ExternalFileDropResult {
  tabId: string;
  path: string;
  title: string;
}

export interface EditorNavigationRequest {
  readonly id: number;
  readonly tabId: string;
  readonly position: number;
  readonly selectionEnd?: number;
  readonly verticalAlignment?: PluginEditorVerticalAlignment;
}

/** 标签页触发编辑器笔记属性菜单时使用的一次性请求。 */
export interface NotePropertiesMenuRequest {
  readonly id: number;
  readonly tabId: string;
}

export interface OpenTextFileRequest {
  readonly filePath: string;
  readonly relativePath?: string;
  readonly title: string;
  readonly content: string;
  readonly position: number;
  readonly selectionEnd?: number;
  readonly verticalAlignment?: PluginEditorVerticalAlignment;
  readonly temporary?: boolean;
}

function cloneTab(tab: DockingThreeTab): DockingThreeTab {
  return { ...tab };
}

/** Resolve the persisted docking target for a sidebar plugin, keeping older tabs rail-visible. */
function resolveSidebarDockTarget(tab: DockingThreeTab): DockingThreeSidebarDockTarget {
  return tab.sidebarDockTarget ?? 'activity-rail';
}

function isSidebarPanelTab(tab: DockingThreeTab | undefined): boolean {
  return tab?.kind === 'plugin' || tab?.kind === 'host-panel';
}

function isActivityRailTab(tab: DockingThreeTab | undefined): boolean {
  return isSidebarPanelTab(tab) && tab !== undefined
    && resolveSidebarDockTarget(tab) === 'activity-rail';
}

function withSidebarDockTarget(
  tab: DockingThreeTab,
  target: DockingThreeSidebarDockTarget
): DockingThreeTab {
  return isSidebarPanelTab(tab) ? { ...tab, sidebarDockTarget: target } : tab;
}

/** 递归更新布局树中满足条件的标签，保持布局节点不可变。 */
function updateNodeTabs(
  node: DockingThreeNode,
  updater: (tab: DockingThreeTab) => DockingThreeTab
): DockingThreeNode {
  if (node.type === 'group') {
    return { ...node, tabs: node.tabs.map(updater) };
  }

  return { ...node, children: node.children.map(child => updateNodeTabs(child, updater)) };
}

function remapNodeIds(node: DockingThreeNode, prefix: string): DockingThreeNode {
  if (node.type === 'group') {
    return {
      ...node,
      id: `${prefix}-${node.id}`,
      tabs: node.tabs.map(cloneTab)
    };
  }

  return {
    ...node,
    id: `${prefix}-${node.id}`,
    sizes: [...node.sizes],
    children: node.children.map(child => remapNodeIds(child, prefix))
  };
}

function collectNodeTabs(node: DockingThreeNode, tabs: DockingThreeTab[] = []): DockingThreeTab[] {
  if (node.type === 'group') {
    tabs.push(...node.tabs.map(cloneTab));
    return tabs;
  }

  node.children.forEach((child) => collectNodeTabs(child, tabs));
  return tabs;
}

/** 在布局树中查找关联指定文件路径的编辑器标签及分组。 */
function findEditorTabByFilePath(
  node: DockingThreeNode,
  filePath: string
): { group: DockingThreeGroupNode; tab: DockingThreeTab } | undefined {
  if (node.type === 'group') {
    const tab = node.tabs.find((item) => item.kind === 'editor' && item.filePath === filePath);
    return tab ? { group: node, tab } : undefined;
  }

  for (const child of node.children) {
    const match = findEditorTabByFilePath(child, filePath);

    if (match) {
      return match;
    }
  }

  return undefined;
}

/** 在布局树中查找关联指定媒体路径的标签及分组。 */
function findMediaTabByFilePath(
  node: DockingThreeNode,
  filePath: string
): { group: DockingThreeGroupNode; tab: DockingThreeTab } | undefined {
  if (node.type === 'group') {
    const tab = node.tabs.find((item) => item.kind === 'media' && item.filePath === filePath);
    return tab ? { group: node, tab } : undefined;
  }

  for (const child of node.children) {
    const match = findMediaTabByFilePath(child, filePath);

    if (match) {
      return match;
    }
  }

  return undefined;
}

interface WorkspaceFileTabReference {
  groupId: string;
  tabId: string;
  relativePath?: string;
}

/** 最近使用的工作区文件摘要，供编辑器引用入口复用。 */
export interface RecentWorkspaceFile {
  path: string;
  relativePath?: string;
  title: string;
}

/** 递归收集所有绑定仓库文件路径的编辑器标签。 */
function collectWorkspaceFileTabs(
  node: DockingThreeNode,
  references: WorkspaceFileTabReference[] = []
): WorkspaceFileTabReference[] {
  if (node.type === 'group') {
    for (const tab of node.tabs) {
      if (tab.kind === 'editor' && tab.filePath) {
        references.push({ groupId: node.id, tabId: tab.id, relativePath: tab.relativePath });
      }
    }

    return references;
  }

  for (const child of node.children) {
    collectWorkspaceFileTabs(child, references);
  }

  return references;
}

/** 在布局树中查找已打开的插件视图标签。 */
function findPluginViewTab(
  node: DockingThreeNode,
  pluginId: string,
  viewType: string,
  instanceId?: string
): { group: DockingThreeGroupNode; tab: DockingThreeTab } | undefined {
  if (node.type === 'group') {
    const tab = node.tabs.find((item) => (
      item.kind === 'plugin'
      && item.pluginId === pluginId
      && item.viewType === viewType
      && (instanceId === undefined || item.viewInstanceId === instanceId)
    ));
    return tab ? { group: node, tab } : undefined;
  }

  for (const child of node.children) {
    const match = findPluginViewTab(child, pluginId, viewType, instanceId);

    if (match) {
      return match;
    }
  }

  return undefined;
}

/** 在布局树中查找已存在的设置标签，避免同一窗口重复创建设置页。 */
function findSettingsTab(
  node: DockingThreeNode
): { group: DockingThreeGroupNode; tab: DockingThreeTab } | undefined {
  if (node.type === 'group') {
    const tab = node.tabs.find(item => item.kind === 'settings');
    return tab ? { group: node, tab } : undefined;
  }

  for (const child of node.children) {
    const match = findSettingsTab(child);
    if (match) return match;
  }

  return undefined;
}

/**
 * 判断当前缩放对是否对应根横向布局中的左右侧边栏。
 */
function resolveRootSidebarResizeTarget(
  splitId: string,
  leftIndex: number,
  rightIndex: number
): DockingThreeSidebarPosition | undefined {
  if (splitId !== ROOT_SPLIT_ID) {
    return undefined;
  }

  if (leftIndex === ROOT_LEFT_SIDEBAR_INDEX && rightIndex === ROOT_CENTER_COLUMN_INDEX) {
    return 'left';
  }

  if (leftIndex === ROOT_CENTER_COLUMN_INDEX && rightIndex === ROOT_RIGHT_SIDEBAR_INDEX) {
    return 'right';
  }

  return undefined;
}

export const useDockingThreeStore = defineStore('dockingThree', () => {
  const isTabWindow = ref(getWindowMode() === 'tab');
  const initialWelcomeTab = createWelcomeTab('welcome-tab-1');
  const editorTabSequence = ref(1);
  const welcomeTabSequence = ref(1);
  const editorGroupSequence = ref(1);
  const panelGroupSequence = ref(1);
  const pluginViewSequence = ref(0);
  const splitSequence = ref(2);
  const root = ref<DockingThreeNode>(
    isTabWindow.value
      ? buildEditorOnlyDockingTree(initialWelcomeTab)
      : buildInitialDockingTree(initialWelcomeTab)
  );
  const editorDocuments = ref<Record<string, string>>({});
  const editorDocumentBaselines = ref<Record<string, string>>({});
  const editorSelections = ref<Record<string, PluginEditorRange>>({});
  const recentWorkspaceFiles = ref<RecentWorkspaceFile[]>([]);
  const leftSidebarOpen = ref(true);
  const rightSidebarOpen = ref(false);
  // The selected activity item owns the visible sidebar context. Other
  // activity-rail groups remain mounted but are hidden, so adding an item to
  // the rail never turns into a visual top/bottom split with a sibling.
  const activeSidebarPanelIds = ref<Partial<Record<DockingThreeSidebarPosition, string>>>({});
  const workspaceWidth = ref<number>();
  const activeEditorGroupId = ref(DEFAULT_EDITOR_GROUP_ID);
  const focusedGroupId = ref(DEFAULT_EDITOR_GROUP_ID);
  /** Each docking group keeps its own most-recently-activated tab history. */
  const tabActivationHistory = ref<Record<string, string[]>>({});
  const groupBounds = ref<Record<string, DockingThreeGroupBounds>>({});
  const groupCenterDropSlots = ref<Record<string, DockingThreeIndicatorBounds[]>>({});
  const activityRailBounds = ref<
    Partial<Record<DockingThreeSidebarPosition, DockingThreeActivityRailBounds>>
  >({});
  const pendingTabDrag = ref<PendingTabDrag>();
  const activeTabDrag = ref<ActiveTabDrag>();
  const externalFileDrag = ref<ExternalFileDrag>();
  let externalFileDragSequence = 0;
  const editorNavigationSequence = ref(0);
  const pendingEditorNavigation = ref<EditorNavigationRequest>();
  const notePropertiesMenuSequence = ref(0);
  const notePropertiesVisibility = ref<Record<string, boolean>>({});
  const pendingNotePropertiesMenu = ref<NotePropertiesMenuRequest>();
  const pathNavigationVisibility = ref<Record<string, boolean>>({});

  /** 确保编辑器标签拥有当前内容和对应的未保存判断基线。 */
  function ensureEditorDocument(tabId: string, initialValue?: string): void {
    if (editorDocuments.value[tabId] !== undefined) {
      if (!(tabId in editorDocumentBaselines.value)) {
        editorDocumentBaselines.value[tabId] = editorDocuments.value[tabId] ?? '';
      }
      return;
    }

    const documentValue = initialValue ?? '';
    editorDocuments.value[tabId] = documentValue;
    editorDocumentBaselines.value[tabId] = documentValue;
  }
  /** 更新指定编辑器标签的当前文档内容。 */
  function setEditorDocumentValue(tabId: string, value: string): void {
    if (!(tabId in editorDocumentBaselines.value)) {
      editorDocumentBaselines.value[tabId] = editorDocuments.value[tabId] ?? '';
    }

    if (editorDocuments.value[tabId] === value) {
      return;
    }

    editorDocuments.value[tabId] = value;
  }

  /** 将指定编辑器标签的当前内容记录为已保存基线。 */
  function setEditorDocumentBaseline(tabId: string, value: string): void {
    editorDocumentBaselines.value[tabId] = value;
  }

  /** 获取指定编辑器标签最近一次打开或保存时的内容基线。 */
  function getEditorDocumentBaseline(tabId: string): string | undefined {
    return editorDocumentBaselines.value[tabId];
  }

  function getEditorDocumentBaselineByFilePath(filePath: string): string | undefined {
    const match = findEditorTabByFilePath(root.value, filePath);
    return match ? editorDocumentBaselines.value[match.tab.id] : undefined;
  }

  /** 判断指定编辑器标签的持久化内容是否已偏离打开时或最近保存的内容。 */
  function isEditorDocumentDirty(tabId: string): boolean {
    const currentValue = editorDocuments.value[tabId];
    const baselineValue = editorDocumentBaselines.value[tabId];

    return currentValue !== undefined
      && baselineValue !== undefined
      && closeInlineChat(currentValue) !== closeInlineChat(baselineValue);
  }

  /** 更新指定编辑器标签的公开选区快照。 */
  function setEditorSelection(tabId: string, start: number, end: number): void {
    if (!tabId || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return;
    const documentLength = editorDocuments.value[tabId]?.length ?? 0;
    const normalizedStart = Math.max(0, Math.min(documentLength, start));
    const normalizedEnd = Math.max(normalizedStart, Math.min(documentLength, end));
    const current = editorSelections.value[tabId];
    if (current?.start === normalizedStart && current.end === normalizedEnd) return;
    editorSelections.value[tabId] = { start: normalizedStart, end: normalizedEnd };
  }

  /** 更新目标标签的笔记属性块显隐状态。 */
  function setNotePropertiesVisibility(tabId: string, visible: boolean): void {
    if (!tabId) {
      return;
    }

    notePropertiesVisibility.value[tabId] = visible;
    if (!visible && pendingNotePropertiesMenu.value?.tabId === tabId) {
      pendingNotePropertiesMenu.value = undefined;
    }
  }

  /** 显示目标标签的笔记属性区域，并请求其打开属性选择菜单。 */
  function requestNotePropertiesMenu(tabId: string): void {
    setNotePropertiesVisibility(tabId, true);
    notePropertiesMenuSequence.value += 1;
    pendingNotePropertiesMenu.value = {
      id: notePropertiesMenuSequence.value,
      tabId
    };
  }

  /** 按文件路径条件更新已打开的编辑器缓冲区，避免覆盖并发输入。 */
  function updateEditorDocumentByFilePath(
    filePath: string,
    expectedContent: string,
    content: string
  ): boolean {
    const match = findEditorTabByFilePath(root.value, filePath);

    if (!match || editorDocuments.value[match.tab.id] !== expectedContent) {
      return false;
    }

    setEditorDocumentValue(match.tab.id, content);
    setEditorDocumentBaseline(match.tab.id, content);
    return true;
  }

  /** 仅更新指定文件编辑器的已保存基线，保留当前内容中的临时编辑器块。 */
  function updateEditorDocumentBaselineByFilePath(
    filePath: string,
    expectedContent: string,
    baselineContent: string
  ): boolean {
    const match = findEditorTabByFilePath(root.value, filePath);

    if (!match || editorDocuments.value[match.tab.id] !== expectedContent) {
      return false;
    }

    setEditorDocumentBaseline(match.tab.id, baselineContent);
    return true;
  }

  function removeEditorDocument(tabId: string): void {
    if (!(tabId in editorDocuments.value)) {
      return;
    }

    delete editorDocuments.value[tabId];
    delete editorDocumentBaselines.value[tabId];
    delete editorSelections.value[tabId];
    delete notePropertiesVisibility.value[tabId];
    delete pathNavigationVisibility.value[tabId];

    if (pendingNotePropertiesMenu.value?.tabId === tabId) {
      pendingNotePropertiesMenu.value = undefined;
    }
  }

  /** 返回指定编辑器标签是否显示路径导航；未设置时默认显示。 */
  function isPathNavigationVisible(tabId: string): boolean {
    return pathNavigationVisibility.value[tabId] !== false;
  }

  /** 更新指定编辑器标签的路径导航可见状态。 */
  function setPathNavigationVisibility(tabId: string, visible: boolean): void {
    if (!tabId) {
      return;
    }

    pathNavigationVisibility.value[tabId] = visible;
  }

  function buildRailSections(
    sections: readonly DockingThreeIconRailSection[],
    activeTabIds: ReadonlySet<string>
  ): DockingThreeIconRailSection[] {
    return sections
      .map((section) => ({
        id: section.id,
        tabs: section.tabs.filter((tab) => activeTabIds.has(tab.id))
      }))
      .filter((section) => section.tabs.length > 0);
  }

  function isRootSidebarGroupId(groupId: string): boolean {
    return groupId === LEFT_SIDEBAR_GROUP_ID || groupId === RIGHT_SIDEBAR_GROUP_ID;
  }

  /** Return the root-layout branch owned by an activity rail. */
  function findSidebarLaneNode(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition
  ): DockingThreeNode | undefined {
    if (node.type !== 'split' || node.id !== ROOT_SPLIT_ID) {
      return undefined;
    }

    const laneNode = node.children[position === 'left'
      ? ROOT_LEFT_SIDEBAR_INDEX
      : ROOT_RIGHT_SIDEBAR_INDEX];
    const laneId = position === 'left' ? LEFT_SIDEBAR_LANE_ID : RIGHT_SIDEBAR_LANE_ID;

    return laneNode?.type === 'split' && laneNode.id === laneId
      ? laneNode
      : undefined;
  }

  function findSidebarSlotNode(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition,
    slot: 'top' | 'bottom'
  ): DockingThreeSplitNode | undefined {
    const laneNode = findSidebarLaneNode(node, position);
    if (!laneNode || laneNode.type !== 'split') {
      return undefined;
    }

    const slotId = position === 'left'
      ? slot === 'top' ? LEFT_SIDEBAR_TOP_ID : LEFT_SIDEBAR_BOTTOM_ID
      : slot === 'top' ? RIGHT_SIDEBAR_TOP_ID : RIGHT_SIDEBAR_BOTTOM_ID;
    const slotNode = laneNode.children.find((child) => child.id === slotId);
    return slotNode?.type === 'split' ? slotNode : undefined;
  }

  function findSidebarSlotForGroup(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition,
    groupId: string
  ): 'top' | 'bottom' | undefined {
    for (const slot of ['top', 'bottom'] as const) {
      const slotNode = findSidebarSlotNode(node, position, slot);
      if (slotNode && findNodePathById(slotNode, groupId)) {
        return slot;
      }
    }

    return undefined;
  }

  /** Collapse fixed sidebar bottoms that no longer contain any plugin content. */
  function collapseEmptySidebarBottoms(node: DockingThreeNode): DockingThreeNode {
    return collapseEmptySidebarBottomContainer(
      collapseEmptySidebarBottomContainer(node, 'left'),
      'right'
    );
  }

  /** Add an activity-bar context as a sibling of the lane's existing contexts. */
  function appendActivityRailGroup(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition,
    group: DockingThreeGroupNode
  ): DockingThreeNode {
    const laneNode = findSidebarSlotNode(node, position, 'top');

    if (!laneNode) {
      return cloneNode(node);
    }

    return appendGroupToSplit(node, laneNode.id, group);
  }

  /** Collect every plugin tab from a whole sidebar branch, including docked contexts. */
  function collectSidebarPluginTabs(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition
  ): DockingThreeTab[] {
    const laneNode = findSidebarLaneNode(node, position);
    if (!laneNode) {
      return [];
    }

    const tabs: DockingThreeTab[] = [];
    const seenTabIds = new Set<string>();

    function collect(currentNode: DockingThreeNode): void {
      if (currentNode.type === 'group') {
        currentNode.tabs.forEach((tab) => {
          if (isSidebarPanelTab(tab) && !seenTabIds.has(tab.id)) {
            seenTabIds.add(tab.id);
            tabs.push(tab);
          }
        });
        return;
      }

      currentNode.children.forEach(collect);
    }

    collect(laneNode);
    return tabs;
  }

  /** Remove every stale sidebar reference before a tab is re-created on a rail. */
  function removeTabFromSidebarLanes(
    node: DockingThreeNode,
    tabId: string
  ): DockingThreeNode {
    let nextRoot = node;

    for (const position of ['left', 'right'] as const) {
      const laneNode = findSidebarLaneNode(nextRoot, position);
      if (!laneNode) {
        continue;
      }

      const groupIds: string[] = [];
      const collectGroupIds = (currentNode: DockingThreeNode): void => {
        if (currentNode.type === 'group') {
          groupIds.push(currentNode.id);
          return;
        }

        currentNode.children.forEach(collectGroupIds);
      };
      collectGroupIds(laneNode);

      for (const groupId of groupIds) {
        const group = findGroupById(nextRoot, groupId);
        if (!group || !group.tabs.some((tab) => tab.id === tabId)) {
          continue;
        }

        // `removeTabFromGroup` intentionally preserves the last tab in a
        // group when no replacement is supplied. A rail drop is different:
        // the tab must leave the sidebar completely, even when it is the last
        // item in a fixed bottom group.
        nextRoot = updateGroupById(nextRoot, groupId, (currentGroup) => {
          const remainingTabs = currentGroup.tabs
            .filter((tab) => tab.id !== tabId)
            .map(cloneTab);
          const nextActiveTabId = remainingTabs.some((tab) => tab.id === currentGroup.activeTabId)
            ? currentGroup.activeTabId
            : remainingTabs[0]?.id ?? '';

          return {
            ...currentGroup,
            tabs: remainingTabs,
            activeTabId: nextActiveTabId
          };
        });
      }
    }

    return nextRoot;
  }

  /** Collect only plugins that are represented by activity-rail icons. */
  function collectActivityRailPluginTabs(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition
  ): DockingThreeTab[] {
    return collectSidebarPluginTabs(node, position)
      .filter((tab) => isActivityRailTab(tab));
  }

  function findSidebarGroupWithTab(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition,
    tabId: string
  ): DockingThreeGroupNode | undefined {
    const laneNode = findSidebarLaneNode(node, position);
    if (!laneNode) {
      return undefined;
    }

    function find(currentNode: DockingThreeNode): DockingThreeGroupNode | undefined {
      if (currentNode.type === 'group') {
        return currentNode.tabs.some((tab) => tab.id === tabId) ? currentNode : undefined;
      }

      for (const child of currentNode.children) {
        const match = find(child);
        if (match) {
          return match;
        }
      }

      return undefined;
    }

    return find(laneNode);
  }

  function hasSidebarTab(
    node: DockingThreeNode,
    position: DockingThreeSidebarPosition
  ): boolean {
    if (position === 'right' && rightSidebarPanels.length > 0) {
      return true;
    }

    return collectSidebarPluginTabs(node, position).length > 0;
  }

  function resolveActiveSidebarPanelId(position: DockingThreeSidebarPosition): string {
    const rootGroup = findRootSidebarGroup(position);
    const defaultPanelId = position === 'left'
      ? DEFAULT_LEFT_SIDEBAR_PANEL_ID
      : DEFAULT_RIGHT_SIDEBAR_PANEL_ID;

    if (!rootGroup) {
      return defaultPanelId;
    }

    const activityRailTabs = collectActivityRailPluginTabs(root.value, position);
    const rememberedPanelId = activeSidebarPanelIds.value[position];
    if (rememberedPanelId && activityRailTabs.some((tab) => tab.id === rememberedPanelId)) {
      return rememberedPanelId;
    }

    const activePluginTab = activityRailTabs.find((tab) => {
      const group = findSidebarGroupWithTab(root.value, position, tab.id);
      return group?.activeTabId === tab.id;
    });

    return activePluginTab?.id ?? rootGroup.activeTabId ?? defaultPanelId;
  }

  function findRootSidebarGroup(position: DockingThreeSidebarPosition): DockingThreeGroupNode | undefined {
    return findGroupById(root.value, position === 'left' ? LEFT_SIDEBAR_GROUP_ID : RIGHT_SIDEBAR_GROUP_ID);
  }

  const activeLeftSidebarPanelId = computed(() => resolveActiveSidebarPanelId('left'));

  const activeRightSidebarPanelId = computed(() => resolveActiveSidebarPanelId('right'));

  const leftSidebarRailSections = computed(() => {
    const pluginTabs = collectActivityRailPluginTabs(root.value, 'left');
    const availableTabIds = new Set(pluginTabs.map((tab) => tab.id));
    const railTabs: DockingThreeSidebarPanelDefinition[] = pluginTabs
      .map((tab) => ({
        id: tab.id,
        title: tab.title,
        label: tab.label,
        iconUrl: tab.hostPanelIconClass ? undefined : tab.viewIconUrl ?? tab.hostPanelIconUrl,
        iconClass: tab.hostPanelIconClass ?? (tab.viewIconUrl || tab.hostPanelIconUrl ? undefined : 'icon icon-folder')
      }));

    return buildRailSections([
      {
        id: 'activity-top',
        tabs: railTabs
      }
    ], availableTabIds);
  });

  const rightSidebarRailSections = computed(() => {
    const panelTabs = collectActivityRailPluginTabs(root.value, 'right');
    const availableTabIds = new Set(panelTabs.map((tab) => tab.id));
    const railTabs: DockingThreeSidebarPanelDefinition[] = panelTabs
      .map((tab) => ({
        id: tab.id,
        title: tab.title,
        label: tab.label,
        iconUrl: tab.hostPanelIconClass ? undefined : tab.viewIconUrl ?? tab.hostPanelIconUrl,
        iconClass: tab.hostPanelIconClass ?? (tab.viewIconUrl || tab.hostPanelIconUrl ? undefined : 'icon icon-folder')
      }));

    return buildRailSections([
      {
        id: 'right-rail',
        // 右侧活动栏仅展示运行时插件视图，隐藏预置的“上下文”和“历史”入口。
        tabs: railTabs
      }
    ], availableTabIds);
  });

  /** 创建编辑器标签，并为其初始化文档内容与未保存判断基线。 */
  function buildEditorTab(initialValue?: string): DockingThreeTab {
    editorTabSequence.value += 1;

    const nextTab: DockingThreeTab = {
      ...createEditorTab(`editor-tab-${editorTabSequence.value}`),
      ...(initialValue !== undefined ? { initialValue } : {})
    };

    ensureEditorDocument(nextTab.id, initialValue);

    return nextTab;
  }

  /**
   * 构建新的欢迎页标签，供顶部新增按钮与默认占位标签复用。
   */
  function buildWelcomeTab(): DockingThreeTab {
    welcomeTabSequence.value += 1;

    return createWelcomeTab(`welcome-tab-${welcomeTabSequence.value}`);
  }

  /** 编辑器宿主失去最后一个标签时补入启动页，保持关闭、拆分与拖拽行为一致。 */
  function buildEditorHostReplacementTab(): DockingThreeTab {
    return buildWelcomeTab();
  }

  function buildEditorGroup(tab: DockingThreeTab, previewGhost = false): DockingThreeGroupNode {
    if (previewGhost) {
      return createEditorGroup(`preview-group-${tab.id}`, tab, true);
    }

    editorGroupSequence.value += 1;
    return {
      ...createEditorGroup(`editor-group-${editorGroupSequence.value}`, tab),
      docked: true
    };
  }

  function buildPanelGroup(
    sourceGroup: DockingThreeGroupNode,
    tab: DockingThreeTab,
    previewGhost = false
  ): DockingThreeGroupNode {
    if (sourceGroup.role === 'editor') {
      return buildEditorGroup(tab, previewGhost);
    }

    if (previewGhost) {
      return createWorkbenchGroup(`preview-group-${tab.id}`, sourceGroup.role, tab, true);
    }

    panelGroupSequence.value += 1;
    return {
      ...createWorkbenchGroup(
      `${sourceGroup.role}-group-${panelGroupSequence.value}`,
      sourceGroup.role,
      tab
      ),
      docked: true
    };
  }

  function buildSplitId(preview = false, suffix = 'preview'): string {
    if (preview) {
      return `preview-split-${suffix}`;
    }

    splitSequence.value += 1;
    return `dock-split-${splitSequence.value}`;
  }

  function resolveSidebarLaneForGroup(groupId: string): DockingThreeSidebarPosition | undefined {
    const targetPath = findNodePathById(root.value, groupId);

    if (!targetPath || targetPath.length < 2) {
      return undefined;
    }

    const rootNode = targetPath[0];
    const topLevelNode = targetPath[1];

    if (rootNode?.type !== 'split' || rootNode.axis !== 'horizontal' || !topLevelNode) {
      return undefined;
    }

    const centerChildIndex = rootNode.children.findIndex((child) => child.id === CENTER_COLUMN_NODE_ID);
    const topLevelChildIndex = rootNode.children.findIndex((child) => child.id === topLevelNode.id);

    if (centerChildIndex === -1 || topLevelChildIndex === -1 || topLevelChildIndex === centerChildIndex) {
      return undefined;
    }

    return topLevelChildIndex < centerChildIndex ? 'left' : 'right';
  }

  /**
   * 判断指定分组当前是否位于主编辑工作区（center column）内部。
   * 只有主编辑工作区里的编辑器组，在拖走最后一个标签时才需要立即补一个启动页兜底。
   */
  function isGroupInCenterWorkspace(groupId: string): boolean {
    const targetPath = findNodePathById(root.value, groupId);

    if (!targetPath || targetPath.length < 2) {
      return false;
    }

    return targetPath[1]?.id === CENTER_COLUMN_NODE_ID;
  }

  function isGroupVisible(groupId: string): boolean {
    const sidebarLane = resolveSidebarLaneForGroup(groupId);

    if (sidebarLane === 'left') {
      const group = findGroupById(root.value, groupId);
      const activePanelId = resolveActiveSidebarPanelId('left');
      const containsActivePanel = Boolean(group?.tabs.some((tab) => tab.id === activePanelId));
      const sidebarSlot = findSidebarSlotForGroup(root.value, 'left', groupId);

      if (sidebarSlot === 'bottom') {
        return leftSidebarOpen.value
          && (hasSidebarTab(root.value, 'left') || Boolean(activeTabDrag.value));
      }

      return leftSidebarOpen.value
        && hasSidebarTab(root.value, 'left')
        && Boolean(group?.tabs.some((tab) => isSidebarPanelTab(tab)))
        && (containsActivePanel || isSidebarContextVisible('left', groupId));
    }

    if (sidebarLane === 'right') {
      const group = findGroupById(root.value, groupId);
      const activePanelId = resolveActiveSidebarPanelId('right');
      const containsActivePanel = Boolean(group?.tabs.some((tab) => tab.id === activePanelId));
      const sidebarSlot = findSidebarSlotForGroup(root.value, 'right', groupId);

      if (sidebarSlot === 'bottom') {
        return rightSidebarOpen.value
          && (hasSidebarTab(root.value, 'right') || Boolean(activeTabDrag.value));
      }

      return rightSidebarOpen.value
        && hasSidebarTab(root.value, 'right')
        && Boolean(group?.tabs.some((tab) => (
          isSidebarPanelTab(tab)
        )))
        && (containsActivePanel || isSidebarContextVisible('right', groupId));
    }

    return true;
  }

  /** Resolve the owning top-level activity context for a sidebar group. */
  function findSidebarActivityContextId(
    position: DockingThreeSidebarPosition,
    groupId: string
  ): string | undefined {
    const laneNode = findSidebarLaneNode(root.value, position);
    if (!laneNode || laneNode.type !== 'split') {
      return undefined;
    }

    // The lane child is the fixed `top` slot wrapper. Each independent
    // activity context lives under that wrapper, so resolve ownership from
    // the slot's direct children instead of treating the whole slot as one
    // shared context.
    const topSlot = findSidebarSlotNode(root.value, position, 'top');
    if (!topSlot) {
      return undefined;
    }

    const owningContext = topSlot.children.find((child) =>
      Boolean(findNodePathById(child, groupId))
    );
    if (!owningContext) {
      return undefined;
    }

    function findActivityTabId(node: DockingThreeNode): string | undefined {
      if (node.type === 'group') {
        return node.tabs.find((tab) =>
          isActivityRailTab(tab)
        )?.id;
      }

      for (const child of node.children) {
        const activityTabId = findActivityTabId(child);
        if (activityTabId) {
          return activityTabId;
        }
      }

      return undefined;
    }

    return findActivityTabId(owningContext);
  }

  /** Keep every top-level activity context independent, including its nested children. */
  function isSidebarContextVisible(
    position: DockingThreeSidebarPosition,
    groupId: string
  ): boolean {
    const slot = findSidebarSlotForGroup(root.value, position, groupId);
    if (slot === 'bottom') {
      return true;
    }

    const owningActivityTabId = findSidebarActivityContextId(position, groupId);
    const activePanelId = resolveActiveSidebarPanelId(position);
    const hasActivityRailContext = collectActivityRailPluginTabs(root.value, position).length > 0;
    const group = findGroupById(root.value, groupId);

    // The active activity item itself is always the visible root context. This
    // direct check keeps a closed-then-reopened rail from losing its panel when
    // the surrounding split was cloned or normalized.
    if (group?.tabs.some((tab) => tab.id === activePanelId)) {
      return true;
    }

    // A context group that sits directly under the lane but is not owned by an
    // activity-rail group is a legacy/orphan sibling. Keep it mounted for
    // state preservation, but do not let it consume half of the lane height.
    if (!owningActivityTabId && hasActivityRailContext) {
      return false;
    }

    return !owningActivityTabId || owningActivityTabId === activePanelId;
  }

  /**
   * Prevent an activity-rail root tab from being docked into its own context
   * tree. The source and target can be different groups (A and nested B), so a
   * simple group-id equality check is not sufficient here.
   */
  function isActivityContextSelfDrop(
    sourceGroup: DockingThreeGroupNode | undefined,
    movingTab: DockingThreeTab | undefined,
    targetGroup: DockingThreeGroupNode
  ): boolean {
    if (
      !sourceGroup
      || !isActivityRailTab(movingTab)
    ) {
      return false;
    }

    const sourcePosition = resolveSidebarLaneForGroup(sourceGroup.id);
    const targetPosition = resolveSidebarLaneForGroup(targetGroup.id);
    if (!sourcePosition || sourcePosition !== targetPosition) {
      return false;
    }

    const sourceContextId = findSidebarActivityContextId(sourcePosition, sourceGroup.id);
    const targetContextId = findSidebarActivityContextId(targetPosition, targetGroup.id);

    return Boolean(sourceContextId && sourceContextId === targetContextId);
  }

  /** Return the lane child that owns an activity-rail tab and all of its nested contexts. */
  function findActivityContextNode(
    tabId: string,
    sourceGroupId: string
  ): { position: DockingThreeSidebarPosition; node: DockingThreeNode } | undefined {
    const containsTab = (node: DockingThreeNode): boolean => {
      if (node.type === 'group') {
        return node.tabs.some((tab) => tab.id === tabId);
      }
      return node.children.some(containsTab);
    };

    for (const position of ['left', 'right'] as const) {
      const topNode = findSidebarSlotNode(root.value, position, 'top');
      if (!topNode || topNode.type !== 'split') continue;

      const owner = topNode.children.find((child) =>
        Boolean(findNodePathById(child, sourceGroupId))
      );
      if (!owner) continue;

      if (containsTab(owner)) {
        return { position, node: owner };
      }
    }

    return undefined;
  }

  function setGroupBoundsEntry(groupId: string, bounds: DockingThreeGroupBounds): void {
    groupBounds.value = {
      ...groupBounds.value,
      [groupId]: bounds
    };
  }

  function clearGroupBoundsEntry(groupId: string): void {
    const nextBounds = { ...groupBounds.value };
    delete nextBounds[groupId];
    groupBounds.value = nextBounds;
  }

  function setGroupCenterDropSlotsEntry(
    groupId: string,
    slots: DockingThreeIndicatorBounds[]
  ): void {
    groupCenterDropSlots.value = {
      ...groupCenterDropSlots.value,
      [groupId]: slots
    };
  }

  function clearGroupCenterDropSlotsEntry(groupId: string): void {
    const nextSlots = { ...groupCenterDropSlots.value };
    delete nextSlots[groupId];
    groupCenterDropSlots.value = nextSlots;
  }

  /** 同步左右活动栏及其图标项的屏幕边界，供停靠命中和预览层使用。 */
  function setActivityRailBounds(
    position: DockingThreeSidebarPosition,
    bounds: DockingThreeActivityRailBounds
  ): void {
    activityRailBounds.value = {
      ...activityRailBounds.value,
      [position]: bounds
    };
  }

  /** 清理已卸载活动栏的边界，避免拖拽命中隐藏或过期区域。 */
  function clearActivityRailBounds(position: DockingThreeSidebarPosition): void {
    const nextBounds = { ...activityRailBounds.value };
    delete nextBounds[position];
    activityRailBounds.value = nextBounds;
  }

  function resolveSidebarOpenRef(position: DockingThreeSidebarPosition) {
    return position === 'left' ? leftSidebarOpen : rightSidebarOpen;
  }

  function resolveSidebarGroupId(position: DockingThreeSidebarPosition): string {
    return position === 'left' ? LEFT_SIDEBAR_GROUP_ID : RIGHT_SIDEBAR_GROUP_ID;
  }

  /**
   * 同步停靠工作区的真实宽度，并根据当前侧边栏开关状态重算中心列宽度。
   */
  function syncWorkspaceWidth(nextWidth: number): void {
    if (!Number.isFinite(nextWidth) || nextWidth <= 0) {
      return;
    }

    workspaceWidth.value = nextWidth;

    const rootSplit = findSplitById(root.value, ROOT_SPLIT_ID);

    if (!rootSplit || rootSplit.axis !== 'horizontal') {
      return;
    }

    const leftSidebarSize = rootSplit.sizes[ROOT_LEFT_SIDEBAR_INDEX] ?? ROOT_DEFAULT_SIDEBAR_SIZE;
    const rightSidebarSize = rootSplit.sizes[ROOT_RIGHT_SIDEBAR_INDEX] ?? ROOT_DEFAULT_SIDEBAR_SIZE;
    const visibleSidebarWidth = (
      leftSidebarOpen.value && hasSidebarTab(root.value, 'left')
        ? leftSidebarSize
        : 0
    ) + (
      rightSidebarOpen.value && hasSidebarTab(root.value, 'right')
        ? rightSidebarSize
        : 0
    );
    const nextCenterSize = Math.max(nextWidth - visibleSidebarWidth, 1);

    if (rootSplit.sizes[ROOT_CENTER_COLUMN_INDEX] === nextCenterSize) {
      return;
    }

    root.value = updateSplitById(root.value, ROOT_SPLIT_ID, (split) => ({
      ...split,
      sizes: [
        split.sizes[ROOT_LEFT_SIDEBAR_INDEX] ?? ROOT_DEFAULT_SIDEBAR_SIZE,
        nextCenterSize,
        split.sizes[ROOT_RIGHT_SIDEBAR_INDEX] ?? ROOT_DEFAULT_SIDEBAR_SIZE
      ]
    }));
  }

  /**
   * 在侧边栏重新展开前恢复根布局中的默认宽度，避免自动收起后沿用最小尺寸。
   */
  function restoreRootSidebarSize(position: DockingThreeSidebarPosition): void {
    const rootSplit = findSplitById(root.value, ROOT_SPLIT_ID);

    if (!rootSplit || rootSplit.axis !== 'horizontal') {
      return;
    }

    const sidebarIndex = position === 'left'
      ? ROOT_LEFT_SIDEBAR_INDEX
      : ROOT_RIGHT_SIDEBAR_INDEX;
    const defaultSidebarSize = ROOT_DEFAULT_SIDEBAR_SIZE;
    const currentSidebarSize = rootSplit.sizes[sidebarIndex] ?? defaultSidebarSize;

    if (currentSidebarSize >= defaultSidebarSize) {
      return;
    }

    const nextSizes = [...rootSplit.sizes];
    nextSizes[sidebarIndex] = defaultSidebarSize;
    setSplitSizes(ROOT_SPLIT_ID, nextSizes);
  }

  /**
   * 统一更新指定侧边栏的展开状态，避免缩放与点击逻辑各自写一份。
   */
  function setSidebarOpen(position: DockingThreeSidebarPosition, open: boolean): void {
    const sidebarOpen = resolveSidebarOpenRef(position);

    if (!sidebarOpen.value && open) {
      restoreRootSidebarSize(position);
    }

    sidebarOpen.value = open;

    if (workspaceWidth.value) {
      syncWorkspaceWidth(workspaceWidth.value);
    }
  }

  function toggleSidebar(position: DockingThreeSidebarPosition): void {
    const sidebarOpen = resolveSidebarOpenRef(position);
    setSidebarOpen(position, !sidebarOpen.value);
  }

  function handleSidebarRailSelect(
    position: DockingThreeSidebarPosition,
    panelId: string
  ): void {
    const targetGroup = findSidebarGroupWithTab(root.value, position, panelId);

    if (!targetGroup) {
      return;
    }

    // Activity-rail buttons behave as a toggle: clicking the already visible
    // context collapses that sidebar, while clicking another item switches the
    // context and keeps the sidebar open.
    const sidebarOpen = resolveSidebarOpenRef(position);
    if (sidebarOpen.value && resolveActiveSidebarPanelId(position) === panelId) {
      setSidebarOpen(position, false);
      return;
    }

    root.value = setGroupActiveTab(root.value, targetGroup.id, panelId);
    activeSidebarPanelIds.value = {
      ...activeSidebarPanelIds.value,
      [position]: panelId
    };
    setSidebarOpen(position, true);
  }

  /**
   * 聚焦指定标签组，并在目标为编辑器组时同步更新默认编辑目标组。
   */
  function focusGroup(groupId: string): void {
    const group = findGroupById(root.value, groupId);

    if (!group) {
      return;
    }

    focusedGroupId.value = groupId;

    if (group.role === 'editor') {
      activeEditorGroupId.value = groupId;
    }
  }

  /**
   * 聚焦指定编辑器分组，兼容既有编辑器入口逻辑。
   */
  function focusEditorGroup(groupId: string): void {
    const group = findGroupById(root.value, groupId);

    if (group?.role === 'editor') {
      focusGroup(groupId);
    }
  }

  /** 记录分组内的活动标签，保留当前标签之前仍可能回退到的历史。 */
  function rememberTabActivation(group: DockingThreeGroupNode, tabId: string): void {
    if (!group.tabs.some((tab) => tab.id === tabId)) {
      return;
    }

    const previousHistory = tabActivationHistory.value[group.id] ?? [];
    const candidates = [tabId, group.activeTabId, ...previousHistory];
    const nextHistory: string[] = [];

    candidates.forEach((candidate) => {
      if (
        candidate
        && group.tabs.some((tab) => tab.id === candidate)
        && !nextHistory.includes(candidate)
      ) {
        nextHistory.push(candidate);
      }
    });

    tabActivationHistory.value = {
      ...tabActivationHistory.value,
      [group.id]: nextHistory
    };
  }

  /** 删除标签后按最近激活历史恢复当前分组的活动标签。 */
  function restorePreviousTabActivation(groupId: string, closedTabId: string): void {
    const nextGroup = findGroupById(root.value, groupId);
    const historyWithoutClosedTab = (tabActivationHistory.value[groupId] ?? [])
      .filter((tabId) => tabId !== closedTabId);

    if (!nextGroup) {
      const remainingHistory = { ...tabActivationHistory.value };
      delete remainingHistory[groupId];
      tabActivationHistory.value = remainingHistory;
      return;
    }

    const existingTabIds = new Set(nextGroup.tabs.map((tab) => tab.id));
    const validHistory = historyWithoutClosedTab.filter((tabId) => existingTabIds.has(tabId));
    const nextActiveTabId = validHistory[0]
      ?? (existingTabIds.has(nextGroup.activeTabId) ? nextGroup.activeTabId : nextGroup.tabs[0]?.id);

    if (nextActiveTabId && nextActiveTabId !== nextGroup.activeTabId) {
      root.value = setGroupActiveTab(root.value, groupId, nextActiveTabId);
    }

    tabActivationHistory.value = {
      ...tabActivationHistory.value,
      [groupId]: nextActiveTabId
        ? [nextActiveTabId, ...validHistory.filter((tabId) => tabId !== nextActiveTabId)]
        : validHistory
    };
  }

  function setActiveTab(groupId: string, tabId: string): void {
    const group = findGroupById(root.value, groupId);
    const tab = group?.tabs.find((item) => item.id === tabId);
    if (group && tab) {
      rememberTabActivation(group, tabId);
    }
    root.value = setGroupActiveTab(root.value, groupId, tabId);
    focusGroup(groupId);
    const sidebarPosition = resolveSidebarLaneForGroup(groupId);
    if (sidebarPosition) {
      if (tab && isActivityRailTab(tab)) {
        activeSidebarPanelIds.value = {
          ...activeSidebarPanelIds.value,
          [sidebarPosition]: tab.id
        };
      }
      setSidebarOpen(sidebarPosition, true);
    }
    if (tab?.filePath && (tab.kind === 'editor' || tab.kind === 'media')) {
      rememberRecentWorkspaceFile(tab);
    }
  }

  /** 将最近激活的工作区文件移到列表首位，并限制内存中的记录数量。 */
  function rememberRecentWorkspaceFile(tab: DockingThreeTab): void {
    if (!tab.filePath || !tab.title) return;

    const nextFile: RecentWorkspaceFile = {
      path: tab.filePath,
      relativePath: tab.relativePath,
      title: tab.title
    };
    recentWorkspaceFiles.value = [
      nextFile,
      ...recentWorkspaceFiles.value.filter((file) => file.path !== nextFile.path)
    ].slice(0, 20);
  }

  /** 切换仓库时清理旧仓库的最近文件记录。 */
  function clearRecentWorkspaceFiles(): void {
    recentWorkspaceFiles.value = [];
  }

  /**
   * 将新打开的文件标签放入目标编辑器分组。
   * 分组仅包含启动页时直接替换，避免首次打开文件后残留无用启动页。
   */
  function placeOpenedFileTab(
    targetGroup: DockingThreeGroupNode,
    nextTab: DockingThreeTab
  ): void {
    const shouldReplaceWelcome = targetGroup.tabs.length === 1
      && targetGroup.tabs[0]?.kind === 'welcome';

    root.value = shouldReplaceWelcome
      ? updateGroupById(root.value, targetGroup.id, (group) => ({
          ...group,
          tabs: [cloneTab(nextTab)],
          activeTabId: nextTab.id
        }))
      : insertTabIntoGroup(root.value, targetGroup.id, nextTab);
  }

  function createEditorTabInGroup(referenceGroupId?: string): void {
    const requestedGroup = referenceGroupId
      ? findGroupById(root.value, referenceGroupId)
      : undefined;
    const targetGroup = requestedGroup?.role === 'editor'
      ? requestedGroup
      : findGroupById(root.value, activeEditorGroupId.value) ?? findFirstEditorGroup(root.value);

    if (!targetGroup) {
      return;
    }

    const nextTab = buildEditorTab();
    root.value = insertTabIntoGroup(root.value, targetGroup.id, nextTab);
    activeEditorGroupId.value = targetGroup.id;
    focusedGroupId.value = targetGroup.id;
  }

  /** 打开或激活文本文件标签，并发布编辑器定位请求。 */
  function openTextFileAtPosition(request: OpenTextFileRequest): void {
    const existing = findEditorTabByFilePath(root.value, request.filePath);

    if (existing) {
      setActiveTab(existing.group.id, existing.tab.id);
      editorNavigationSequence.value += 1;
      pendingEditorNavigation.value = {
        id: editorNavigationSequence.value,
        tabId: existing.tab.id,
        position: request.position,
        selectionEnd: request.selectionEnd,
        verticalAlignment: request.verticalAlignment
      };
      return;
    }

    const targetGroup = findGroupById(root.value, activeEditorGroupId.value)
      ?? findFirstEditorGroup(root.value);

    if (!targetGroup) {
      return;
    }

    const nextTab = {
      ...buildEditorTab(closeInlineChat(request.content)),
      title: request.title,
      label: request.title,
      filePath: request.filePath,
      relativePath: request.relativePath,
      temporary: request.temporary
    };
    placeOpenedFileTab(targetGroup, nextTab);
    setActiveTab(targetGroup.id, nextTab.id);
    editorNavigationSequence.value += 1;
    pendingEditorNavigation.value = {
      id: editorNavigationSequence.value,
      tabId: nextTab.id,
      position: request.position,
      selectionEnd: request.selectionEnd,
      verticalAlignment: request.verticalAlignment
    };
  }

  /** 打开或激活已由主进程验证的媒体文件标签。 */
  function openMediaFile(request: Extract<WorkspaceOpenFileRequest, { kind: 'image' | 'video' | 'audio' }>): void {
    const existing = findMediaTabByFilePath(root.value, request.filePath);

    if (existing) {
      setActiveTab(existing.group.id, existing.tab.id);
      return;
    }

    const targetGroup = findGroupById(root.value, activeEditorGroupId.value)
      ?? findFirstEditorGroup(root.value);

    if (!targetGroup) {
      return;
    }

    const nextTab = {
      ...createMediaTab(
        `media-tab-${++editorTabSequence.value}`,
        request.filePath,
        request.title,
        request.mediaMimeType
      ),
      relativePath: request.relativePath,
      temporary: request.temporary
    };
    placeOpenedFileTab(targetGroup, nextTab);
    setActiveTab(targetGroup.id, nextTab.id);
  }

  /** 在当前编辑组右侧创建新标签组并打开独立文件标签。 */
  function openWorkspaceFileInNewGroup(request: WorkspaceOpenFileRequest): void {
    const targetGroup = findGroupById(root.value, activeEditorGroupId.value)
      ?? findFirstEditorGroup(root.value);
    if (!targetGroup) return;

    const nextTab = request.kind === 'text'
      ? {
          ...buildEditorTab(closeInlineChat(request.content)),
          title: request.title,
          label: request.title,
          filePath: request.filePath,
          relativePath: request.relativePath,
          temporary: request.temporary
        }
      : {
          ...createMediaTab(
            `media-tab-${++editorTabSequence.value}`,
            request.filePath,
            request.title,
            request.mediaMimeType
          ),
          relativePath: request.relativePath,
          temporary: request.temporary
        };
    const nextGroup = buildEditorGroup(nextTab);
    root.value = splitNodeWithNewGroup(
      root.value,
      targetGroup.id,
      'right',
      nextGroup,
      buildSplitId(false, `open-${nextTab.id}`)
    );
    setActiveTab(nextGroup.id, nextTab.id);
  }

  /** 根据主进程验证结果路由文本编辑器或媒体预览标签。 */
  function openWorkspaceFile(request: WorkspaceOpenFileRequest): void {
    if (request.disposition === 'new-group') {
      openWorkspaceFileInNewGroup(request);
      return;
    }
    if (request.kind === 'text') {
      openTextFileAtPosition({
        filePath: request.filePath,
        relativePath: request.relativePath,
        title: request.title,
        content: request.content,
        position: request.position ?? 0,
        selectionEnd: request.selectionEnd,
        verticalAlignment: request.verticalAlignment,
        temporary: request.temporary
      });
      removeInitialTabWindowWelcomeTab();
      return;
    }

    openMediaFile(request);
    removeInitialTabWindowWelcomeTab();
  }

  /** 专用标签窗口首次打开文件后移除初始欢迎页标签。 */
  function removeInitialTabWindowWelcomeTab(): void {
    if (!isTabWindow.value) return;
    const editorGroup = findFirstEditorGroup(root.value);
    const welcomeTab = editorGroup?.tabs.find(tab => tab.kind === 'welcome');
    if (!editorGroup || !welcomeTab || editorGroup.tabs.length < 2) return;
    root.value = removeTabFromGroup(root.value, editorGroup.id, welcomeTab.id);
  }

  /** 在指定区域打开插件视图；每个停靠标签拥有独立的宿主 DOM 视图实例。 */
  function openPluginView(
    pluginId: string,
    view: PluginViewContributionSummary,
    requestedInstanceId?: string,
    initialUrl?: string
  ): void {
    if (!view.multiple) {
      const existing = findPluginViewTab(root.value, pluginId, view.type);

      if (existing) {
        setActiveTab(existing.group.id, existing.tab.id);
        return;
      }
    }

    if (requestedInstanceId) {
      const existingInstance = findPluginViewTab(
        root.value,
        pluginId,
        view.type,
        requestedInstanceId
      );

      if (existingInstance) {
        setActiveTab(existingInstance.group.id, existingInstance.tab.id);
        return;
      }
    }

    pluginViewSequence.value += 1;
    const viewInstanceId = requestedInstanceId ?? `plugin-view-instance-${pluginViewSequence.value}`;
    const nextTab = createPluginTab(
      `plugin-view-tab-${pluginViewSequence.value}`,
      pluginId,
      view,
      viewInstanceId,
      initialUrl
    );
    const region = isTabWindow.value ? 'editor' : (view.region ?? 'editor');

    if (region === 'left-sidebar' || region === 'right-sidebar') {
      const position = region === 'left-sidebar' ? 'left' : 'right';
      const targetGroup = findRootSidebarGroup(position);

      if (!targetGroup) {
        return;
      }

      const nextGroup = {
        ...buildPanelGroup(targetGroup, {
          ...nextTab,
          sidebarDockTarget: 'activity-rail'
        }),
        role: position === 'left' ? 'left-sidebar' : 'right-sidebar'
      } satisfies DockingThreeGroupNode;
      root.value = appendActivityRailGroup(
        root.value,
        position,
        nextGroup
      );
      setSidebarOpen(position, true);
      setActiveTab(nextGroup.id, nextTab.id);
      return;
    }

    if (region === 'bottom') {
      const existingBottomGroup = findGroupById(root.value, 'plugin-bottom-group');

      if (existingBottomGroup) {
        root.value = insertTabIntoGroup(root.value, existingBottomGroup.id, nextTab);
        setActiveTab(existingBottomGroup.id, nextTab.id);
        return;
      }

      const targetGroup = findGroupById(root.value, activeEditorGroupId.value)
        ?? findFirstEditorGroup(root.value);

      if (!targetGroup) {
        return;
      }

      const bottomGroup = createWorkbenchGroup(
        'plugin-bottom-group',
        'bottom',
        nextTab
      );
      root.value = splitNodeWithNewGroup(
        root.value,
        targetGroup.id,
        'bottom',
        bottomGroup,
        'plugin-bottom-split'
      );
      setActiveTab(bottomGroup.id, nextTab.id);
      return;
    }

    const targetGroup = findGroupById(root.value, activeEditorGroupId.value)
      ?? findFirstEditorGroup(root.value);

    if (!targetGroup) {
      return;
    }

    root.value = insertTabIntoGroup(root.value, targetGroup.id, nextTab);
    setActiveTab(targetGroup.id, nextTab.id);
    removeInitialTabWindowWelcomeTab();
  }

  /** 在当前工作台窗口创建或激活设置标签。 */
  function openSettingsTab(settingsNavigationId?: string): void {
    const existing = findSettingsTab(root.value);
    if (existing) {
      root.value = updateNodeTabs(root.value, tab => (
        tab.id === existing.tab.id
          ? { ...tab, ...(settingsNavigationId ? { settingsNavigationId } : {}) }
          : tab
      ));
      setActiveTab(existing.group.id, existing.tab.id);
      return;
    }

    const targetGroup = findFirstEditorGroup(root.value);
    if (!targetGroup) return;

    const settingsTab = createSettingsTab(
      `settings-tab-${++editorTabSequence.value}`,
      '设置',
      settingsNavigationId
    );
    root.value = insertTabIntoGroup(root.value, targetGroup.id, settingsTab);
    setActiveTab(targetGroup.id, settingsTab.id);
    removeInitialTabWindowWelcomeTab();
  }

  /** 关闭指定插件视图实例，并通知 provider 释放资源。 */
  function closePluginView(
    pluginId: string,
    viewType: string,
    instanceId?: string
  ): void {
    const matches: Array<{ groupId: string; tabId: string }> = [];

    function collect(node: DockingThreeNode): void {
      if (node.type === 'group') {
        node.tabs.forEach((tab) => {
          if (
            tab.kind === 'plugin'
            && tab.pluginId === pluginId
            && tab.viewType === viewType
            && (instanceId === undefined || tab.viewInstanceId === instanceId)
          ) {
            matches.push({ groupId: node.id, tabId: tab.id });
          }
        });
        return;
      }

      node.children.forEach(collect);
    }

    collect(root.value);
    matches.forEach((match) => closeTab(match.groupId, match.tabId));
  }

  /** 关闭指定插件全部视图实例，供插件停用和卸载时清理。 */
  function closePluginViews(pluginId: string): void {
    const matches: Array<{ viewType: string; instanceId?: string }> = [];

    function collect(node: DockingThreeNode): void {
      if (node.type === 'group') {
        node.tabs.forEach((tab) => {
          if (tab.kind === 'plugin' && tab.pluginId === pluginId && tab.viewType) {
            matches.push({ viewType: tab.viewType, instanceId: tab.viewInstanceId });
          }
        });
        return;
      }

      node.children.forEach(collect);
    }

    collect(root.value);
    matches.forEach((match) => closePluginView(pluginId, match.viewType, match.instanceId));
  }

  /**
   * 在目标编辑器分组中创建新的欢迎页标签，供标签头部新增按钮复用。
   */
  function createWelcomeTabInGroup(referenceGroupId?: string): void {
    const requestedGroup = referenceGroupId
      ? findGroupById(root.value, referenceGroupId)
      : undefined;
    const targetGroup = requestedGroup?.role === 'editor'
      ? requestedGroup
      : findGroupById(root.value, activeEditorGroupId.value) ?? findFirstEditorGroup(root.value);

    if (!targetGroup) {
      return;
    }

    const nextTab = buildWelcomeTab();
    root.value = insertTabIntoGroup(root.value, targetGroup.id, nextTab);
    activeEditorGroupId.value = targetGroup.id;
    focusedGroupId.value = targetGroup.id;
  }

  /**
   * 将当前欢迎页标签原位替换成编辑器标签，避免额外新增一个新标签。
   */
  function replaceWelcomeTabWithEditor(
    referenceGroupId: string,
    referenceTabId: string
  ): void {
    const targetGroup = findGroupById(root.value, referenceGroupId);
    const targetTab = targetGroup?.tabs.find((tab) => tab.id === referenceTabId);

    if (!targetGroup || targetGroup.role !== 'editor' || targetTab?.kind !== 'welcome') {
      return;
    }

    const nextTab = {
      ...createEditorTab(referenceTabId),
    };

    ensureEditorDocument(referenceTabId, nextTab.initialValue);
    root.value = updateGroupById(root.value, referenceGroupId, (group) => ({
      ...group,
      tabs: group.tabs.map((tab) => tab.id === referenceTabId ? { ...nextTab } : { ...tab }),
      activeTabId: referenceTabId
    }));
    activeEditorGroupId.value = referenceGroupId;
    focusedGroupId.value = referenceGroupId;
  }

  /** 将文件型标签交给宿主任务栏历史，侧边栏和欢迎页不进入最近关闭列表。 */
  function recordRecentlyClosedTab(tab: DockingThreeTab): void {
    if (
      !tab.relativePath
      || !tab.title.trim()
      || (tab.kind !== 'editor' && tab.kind !== 'media')
    ) {
      return;
    }
    void nativeApi.workspace.recordClosedTab({
      relativePath: tab.relativePath,
      title: tab.title
    }).catch((error: unknown) => {
      console.warn('[taskbar] Failed to record recently closed tab:', error);
    });
  }

  function closeTab(groupId: string, tabId: string): void {
    const group = findGroupById(root.value, groupId);
    const tab = group?.tabs.find((item) => item.id === tabId);

    if (!group || !tab?.closable) {
      return;
    }

    recordRecentlyClosedTab(tab);

    if (
      (group.role === 'left-sidebar' || group.role === 'right-sidebar')
      && group.tabs.length === 1
    ) {
      const sidebarPosition = resolveSidebarLaneForGroup(groupId);
      const nextRoot = isRootSidebarGroupId(groupId)
        ? removeActivityRailTab(root.value, groupId, tabId)
        : removeGroupById(root.value, groupId);
      root.value = collapseEmptySidebarBottoms(nextRoot);
      restorePreviousTabActivation(groupId, tabId);

      if (sidebarPosition && !hasSidebarTab(root.value, sidebarPosition)) {
        setSidebarOpen(sidebarPosition, false);
      }
      return;
    }

    if (group.role === 'bottom' && group.tabs.length === 1) {
      root.value = collapseEmptySidebarBottoms(removeGroupById(root.value, groupId));
      restorePreviousTabActivation(groupId, tabId);
      const nextEditorGroup = findFirstEditorGroup(root.value);
      if (nextEditorGroup) {
        activeEditorGroupId.value = nextEditorGroup.id;
        focusedGroupId.value = nextEditorGroup.id;
      }
      return;
    }

    if (group.role === 'editor' && group.tabs.length === 1) {
      const editorGroupCount = countEditorGroups(root.value);

      if (tab.kind === 'editor') {
        const content = editorDocuments.value[tab.id];
        if (content !== undefined) {
          editorDocuments.value[tab.id] = closeInlineChat(content);
        }
      }

      if (editorGroupCount > 1) {
        const nextRoot = removeGroupById(root.value, groupId);
        removeEditorDocument(tabId);
        root.value = nextRoot;
        restorePreviousTabActivation(groupId, tabId);

        const nextEditorGroup = findFirstEditorGroup(nextRoot);

        if (nextEditorGroup) {
          activeEditorGroupId.value = nextEditorGroup.id;

          if (focusedGroupId.value === groupId) {
            focusedGroupId.value = nextEditorGroup.id;
          }
        }

        return;
      }

      removeEditorDocument(tabId);
      root.value = removeTabFromGroup(
        root.value,
        groupId,
        tabId,
        buildEditorHostReplacementTab()
      );
      restorePreviousTabActivation(groupId, tabId);
      activeEditorGroupId.value = groupId;

      if (focusedGroupId.value === groupId) {
        focusedGroupId.value = groupId;
      }

      return;
    }

    if (tab.kind === 'editor') {
      const content = editorDocuments.value[tab.id];
      if (content !== undefined) {
        editorDocuments.value[tab.id] = closeInlineChat(content);
      }
    }

    root.value = collapseEmptySidebarBottoms(removeTabFromGroup(root.value, groupId, tabId));
    restorePreviousTabActivation(groupId, tabId);
    if (tab.kind === 'editor') {
      removeEditorDocument(tabId);
    }

    closeEmptyActivityRail(groupId);

    if (group.role === 'editor') {
      activeEditorGroupId.value = groupId;
    }
  }

  /** 按插件、视图和实例统一同步网页标题及图标，不改变停靠位置或网页身份。 */
  function updateWebViewerTabMetadata(
    pluginId: string,
    metadata: Pick<WebViewerTabSummary, 'instanceId' | 'viewType' | 'title' | 'url' | 'faviconUrl'>
  ): void {
    if (!metadata.viewType) return;
    const match = findPluginViewTab(root.value, pluginId, metadata.viewType, metadata.instanceId);
    if (!match?.tab.viewCapabilities?.includes('webViewer')) return;
    let pageUrl: URL;
    try {
      pageUrl = new URL(metadata.url);
      if (!['http:', 'https:'].includes(pageUrl.protocol)) return;
    } catch {
      return;
    }
    const title = metadata.title.trim().slice(0, 512) || pageUrl.host;
    let faviconUrl: string | undefined;
    if (metadata.faviconUrl) {
      try {
        const icon = new URL(metadata.faviconUrl);
        if (['http:', 'https:'].includes(icon.protocol) && !icon.username && !icon.password) {
          faviconUrl = icon.href;
        }
      } catch {
        // 缺失或无效的网站图标继续使用插件默认图标。
      }
    }
    if (match.tab.title === title && match.tab.webViewerFaviconUrl === faviconUrl) return;
    root.value = updateGroupById(root.value, match.group.id, group => ({
      ...group,
      tabs: group.tabs.map(tab => tab.id === match.tab.id
        ? { ...tab, title, label: title, webViewerFaviconUrl: faviconUrl }
        : tab)
    }));
  }

  /** 更新指定标签页的显示名称，不改变其关联文件路径。 */
  function renameTab(groupId: string, tabId: string, name: string): void {
    const nextName = name.trim();
    if (!nextName) {
      return;
    }

    const group = findGroupById(root.value, groupId);
    if (!group || !group.tabs.some((tab) => tab.id === tabId)) {
      return;
    }

    root.value = updateGroupById(root.value, groupId, (currentGroup) => ({
      ...currentGroup,
      tabs: currentGroup.tabs.map((tab) => tab.id === tabId
        ? { ...tab, title: nextName, label: nextName }
        : tab)
    }));
  }

  /** 同步移动文件后所有打开标签的绝对路径和仓库相对路径。 */
  function updateWorkspaceFilePath(
    sourceRelativePath: string,
    filePath: string,
    relativePath: string
  ): void {
    root.value = updateNodeTabs(root.value, (tab) => (
      tab.relativePath === sourceRelativePath
        ? { ...tab, filePath, relativePath }
        : tab
    ));
  }

  /** 关闭旧仓库文件标签，保留欢迎页、空白编辑器和插件视图。 */
  function closeWorkspaceFileTabs(): void {
    const references = collectWorkspaceFileTabs(root.value);
    const closedTabIds = new Set(references.map(reference => reference.tabId));

    for (const reference of references) {
      closeTab(reference.groupId, reference.tabId);
    }

    if (
      pendingEditorNavigation.value
      && closedTabIds.has(pendingEditorNavigation.value.tabId)
    ) {
      pendingEditorNavigation.value = undefined;
    }
  }

  /** 按仓库相对路径关闭对应的编辑器文件标签。 */
  function closeWorkspaceFileTabsByPath(paths: readonly string[]): void {
    const wanted = new Set(paths);
    const references = collectWorkspaceFileTabs(root.value)
      .filter((reference): reference is WorkspaceFileTabReference & { relativePath: string } => (
        reference.relativePath !== undefined && wanted.has(reference.relativePath)
      ));
    references.forEach(reference => closeTab(reference.groupId, reference.tabId));
  }

  /** 切换仓库时关闭所有编辑器分组标签并回到欢迎页。 */
  function closeAllEditorGroups(recordClosedTabs = true): void {
    const groupIds: string[] = [];
    function collect(node: DockingThreeNode): void {
      if (node.type === 'group') {
        if (node.role === 'editor') groupIds.push(node.id);
        return;
      }
      node.children.forEach(collect);
    }
    collect(root.value);
    groupIds.forEach(groupId => closeAllTabs(groupId, recordClosedTabs));
  }

  /** 关闭指定分组中除目标标签外的其他标签。 */
  function closeOtherTabs(groupId: string, tabId: string): void {
    const group = findGroupById(root.value, groupId);
    if (!group) return;
    group.tabs.filter(tab => tab.id !== tabId).map(tab => tab.id).forEach(id => closeTab(groupId, id));
  }

  /**
   * 关闭指定分组中的全部可关闭标签。
   * 编辑器分组关闭全部标签后统一重置为一个启动页，避免逐个关闭时
   * 根据最后一个标签类型生成空白编辑器或其他错误替补页。
   */
  function closeAllTabs(groupId: string, recordClosedTabs = true): void {
    const group = findGroupById(root.value, groupId);
    if (!group) return;

    if (group.role === 'editor') {
      const closedTabIds = new Set(group.tabs.map((tab) => tab.id));

      for (const tab of group.tabs) {
        if (recordClosedTabs) {
          recordRecentlyClosedTab(tab);
        }
        if (tab.kind === 'editor') {
          const content = editorDocuments.value[tab.id];
          if (content !== undefined) {
            editorDocuments.value[tab.id] = closeInlineChat(content);
          }
          removeEditorDocument(tab.id);
        }
      }

      const welcomeTab = buildWelcomeTab();
      root.value = updateGroupById(root.value, groupId, (currentGroup) => ({
        ...currentGroup,
        tabs: [welcomeTab],
        activeTabId: welcomeTab.id
      }));
      activeEditorGroupId.value = groupId;
      focusedGroupId.value = groupId;

      if (
        pendingEditorNavigation.value
        && closedTabIds.has(pendingEditorNavigation.value.tabId)
      ) {
        pendingEditorNavigation.value = undefined;
      }

      return;
    }

    group.tabs.map(tab => tab.id).forEach(id => closeTab(groupId, id));
  }

  /** 关闭目标标签左侧的全部标签。 */
  function closeTabsToLeft(groupId: string, tabId: string): void {
    const group = findGroupById(root.value, groupId);
    if (!group) return;
    const index = group.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    group.tabs.slice(0, index).map(tab => tab.id).forEach(id => closeTab(groupId, id));
  }

  /** 关闭目标标签右侧的全部标签。 */
  function closeTabsToRight(groupId: string, tabId: string): void {
    const group = findGroupById(root.value, groupId);
    if (!group) return;
    const index = group.tabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    group.tabs.slice(index + 1).map(tab => tab.id).forEach(id => closeTab(groupId, id));
  }

  /** 创建拆分副本；插件副本使用独立实例，避免共享同一个原生网页和释放生命周期。 */
  function buildSplitDuplicateTab(tab: DockingThreeTab): DockingThreeTab {
    if (tab.kind === 'welcome') {
      return buildWelcomeTab();
    }

    const nextTabId = `${tab.kind}-tab-${++editorTabSequence.value}`;
    const nextTab = {
      ...cloneTab(tab),
      id: nextTabId
    };

    if (tab.kind === 'plugin') {
      nextTab.viewInstanceId = `plugin-view-instance-${++pluginViewSequence.value}`;
    }

    if (tab.kind === 'editor') {
      ensureEditorDocument(nextTabId, editorDocuments.value[tab.id] ?? tab.initialValue);
      setEditorDocumentBaseline(
        nextTabId,
        editorDocumentBaselines.value[tab.id] ?? tab.initialValue ?? ''
      );
    }

    return nextTab;
  }

  /** 在目标分组指定方向创建拆分组，可选择将目标标签移动到新分组。 */
  function splitTab(
    groupId: string,
    tabId: string,
    direction: 'right' | 'bottom',
    moveTab: boolean
  ): void {
    const group = findGroupById(root.value, groupId);
    const tab = group?.tabs.find(item => item.id === tabId);
    if (!group || group.role !== 'editor' || !tab) return;

    const nextTab = moveTab ? cloneTab(tab) : buildSplitDuplicateTab(tab);
    const nextGroup = buildEditorGroup(nextTab);
    let nextRoot = root.value;
    if (moveTab) {
      nextRoot = group.tabs.length === 1
        ? removeTabFromGroup(nextRoot, groupId, tabId, buildEditorHostReplacementTab())
        : removeTabFromGroup(nextRoot, groupId, tabId);
    }
    nextRoot = splitNodeWithNewGroup(
      nextRoot,
      groupId,
      direction,
      nextGroup,
      buildSplitId(false, `tab-context-${tabId}-${direction}`)
    );
    root.value = nextRoot;
    setActiveTab(nextGroup.id, nextTab.id);
  }

  /**
   * 统一判断标签是否具备拖拽停靠资格。
   * 拖拽属于标签组的基础通用能力，不应与 editor / welcome / placeholder 内容类型耦合。
   * 根侧边栏最后一个插件标签允许跨活动栏移动，拖到普通停靠区时仍由提交阶段保护根分组。
   */
  function canBeginTabDrag(
    sourceGroup: DockingThreeGroupNode | undefined,
    tab: DockingThreeTab | undefined
  ): boolean {
    if (!sourceGroup || !tab) {
      return false;
    }

    if (isRootSidebarGroupId(sourceGroup.id) && sourceGroup.tabs.length <= 1) {
      return isSidebarPanelTab(tab);
    }

    return true;
  }

  function beginPendingTabDrag(
    tabId: string,
    sourceGroupId: string,
    startX: number,
    startY: number
  ): void {
    let resolvedSourceGroupId = sourceGroupId;
    let sourceGroup = findGroupById(root.value, sourceGroupId);
    let tab = sourceGroup?.tabs.find((item) => item.id === tabId);

    // 活动栏展示的是整棵侧栏分支中的插件标签。标签可能已经停放在
    // 嵌套上下文分组中，因此从活动栏开始拖拽时要先解析真实来源分组。
    if (!tab && sourceGroupId === LEFT_SIDEBAR_GROUP_ID) {
      sourceGroup = findSidebarGroupWithTab(root.value, 'left', tabId);
      resolvedSourceGroupId = sourceGroup?.id ?? sourceGroupId;
      tab = sourceGroup?.tabs.find((item) => item.id === tabId);
    } else if (!tab && sourceGroupId === RIGHT_SIDEBAR_GROUP_ID) {
      sourceGroup = findSidebarGroupWithTab(root.value, 'right', tabId);
      resolvedSourceGroupId = sourceGroup?.id ?? sourceGroupId;
      tab = sourceGroup?.tabs.find((item) => item.id === tabId);
    }

    if (!canBeginTabDrag(sourceGroup, tab)) {
      return;
    }

    pendingTabDrag.value = {
      tabId,
      sourceGroupId: resolvedSourceGroupId,
      startX,
      startY
    };
  }

  function clearPendingDrag(): void {
    pendingTabDrag.value = undefined;
  }

  function countEditorGroups(node: DockingThreeNode): number {
    if (node.type === 'group') {
      return node.role === 'editor' ? 1 : 0;
    }

    return node.children.reduce((sum, child) => sum + countEditorGroups(child), 0);
  }

  /**
   * 统计主编辑工作区（center column）内当前仍存在的编辑器组数量。
   * 该数量决定拖走最后一个标签时是否需要为主编辑工作区保留一个新的“启动页”。
   */
  function countCenterWorkspaceEditorGroups(): number {
    const centerWorkspacePath = findNodePathById(root.value, CENTER_COLUMN_NODE_ID);
    const centerWorkspaceNode = centerWorkspacePath?.[centerWorkspacePath.length - 1];

    if (!centerWorkspaceNode) {
      return 0;
    }

    return countEditorGroups(centerWorkspaceNode);
  }

  function supportsCenterDrop(group: DockingThreeGroupNode): boolean {
    return group.role === 'editor'
      || group.role === 'left-sidebar'
      || group.role === 'right-sidebar';
  }

  function resolveSidebarDropDirection(
    group: DockingThreeGroupNode,
    bounds: DockingThreeGroupBounds,
    clientY: number
  ): DockingThreeDropDirection | undefined {
    if (
      (group.role !== 'left-sidebar' && group.role !== 'right-sidebar')
      || clientY < bounds.top
      || clientY > bounds.bottom
    ) {
      return undefined;
    }

    const sidebarPosition = resolveSidebarLaneForGroup(group.id);
    const sidebarSlot = sidebarPosition
      ? findSidebarSlotForGroup(root.value, sidebarPosition, group.id)
      : undefined;
    if (sidebarSlot === 'top') {
      // A lane without a bottom slot uses the lower edge of its sole top
      // panel as the insertion target that creates the bottom container.
      // Existing top contexts remain fixed and cannot otherwise be split.
      const hasBottomSlot = sidebarPosition
        ? Boolean(findSidebarSlotNode(root.value, sidebarPosition, 'bottom'))
        : true;
      if (hasBottomSlot) {
        return undefined;
      }

      const edgeHeight = Math.min(
        VERTICAL_DROP_EDGE_MAX_HEIGHT,
        Math.max(DROP_EDGE_THRESHOLD, bounds.height * VERTICAL_DROP_EDGE_RATIO)
      );

      return clientY >= bounds.bottom - edgeHeight ? 'bottom' : undefined;
    }
    if (sidebarSlot === 'bottom') {
      return 'center';
    }

    const hasTabHeader = group.tabs.length > 1;
    const headerBottom = Math.min(
      bounds.bottom,
      bounds.top + (hasTabHeader ? GROUP_HEADER_DROP_HEIGHT : 0)
    );
    if (hasTabHeader && clientY <= headerBottom) {
      return 'center';
    }

    const bodyHeight = Math.max(0, bounds.bottom - headerBottom);
    if (bodyHeight <= 0) {
      return 'center';
    }

    const edgeHeight = Math.min(
      VERTICAL_DROP_EDGE_MAX_HEIGHT,
      Math.max(DROP_EDGE_THRESHOLD, bodyHeight * VERTICAL_DROP_EDGE_RATIO)
    );

    if (clientY <= headerBottom + edgeHeight) {
      return 'top';
    }

    if (clientY >= bounds.bottom - edgeHeight) {
      return 'bottom';
    }

    return 'center';
  }

  function isWithinCenterDropHeader(
    group: DockingThreeGroupNode,
    bounds: DockingThreeGroupBounds,
    clientY: number
  ): boolean {
    if (!supportsCenterDrop(group) || group.header !== 'tabs' || group.tabs.length === 0) {
      return false;
    }

    const headerBottom = Math.min(bounds.bottom, bounds.top + GROUP_HEADER_DROP_HEIGHT);
    return clientY >= bounds.top && clientY <= headerBottom;
  }

  function isWithinCenterDropBand(
    group: DockingThreeGroupNode,
    bounds: DockingThreeGroupBounds,
    clientY: number
  ): boolean {
    if (!supportsCenterDrop(group) || group.header !== 'tabs' || group.tabs.length === 0) {
      return false;
    }

    const bandHeight = Math.max(
      GROUP_HEADER_DROP_HEIGHT,
      Math.min(EDITOR_CENTER_DROP_BAND_HEIGHT, bounds.height * 0.35)
    );
    const bandBottom = Math.min(bounds.bottom, bounds.top + bandHeight);

    return clientY >= bounds.top && clientY <= bandBottom;
  }

  /** 计算左右边缘触发带宽度，确保两侧始终对称并适配工作区宽度。 */
  function resolveHorizontalEdgeThreshold(bounds: DockingThreeGroupBounds): number {
    return Math.min(
      HORIZONTAL_DROP_EDGE_MAX_WIDTH,
      Math.max(DROP_EDGE_THRESHOLD, bounds.width * HORIZONTAL_DROP_EDGE_RATIO)
    );
  }

  /** 计算上下边缘触发带高度，确保上下区域保持对称。 */
  function resolveVerticalEdgeThreshold(bounds: DockingThreeGroupBounds): number {
    return Math.min(
      VERTICAL_DROP_EDGE_MAX_HEIGHT,
      Math.max(DROP_EDGE_THRESHOLD, bounds.height * VERTICAL_DROP_EDGE_RATIO)
    );
  }

  /** 解析外部文件拖拽在编辑器中的四边触发带和中心区域。 */
  function resolveExternalEditorDropDirection(
    group: DockingThreeGroupNode,
    bounds: DockingThreeGroupBounds,
    clientX: number,
    clientY: number
  ): DockingThreeDropDirection | undefined {
    if (!supportsCenterDrop(group) || group.header !== 'tabs' || group.tabs.length === 0) {
      return undefined;
    }

    const edgeThresholdX = resolveHorizontalEdgeThreshold(bounds);
    const edgeThresholdY = resolveVerticalEdgeThreshold(bounds);
    const distances: Array<{
      direction: Exclude<DockingThreeDropDirection, 'center'>;
      score: number;
      active: boolean;
    }> = [
      {
        direction: 'left',
        score: clientX - bounds.left,
        active: clientX - bounds.left <= edgeThresholdX
      },
      {
        direction: 'right',
        score: bounds.right - clientX,
        active: bounds.right - clientX <= edgeThresholdX
      },
      {
        direction: 'top',
        score: clientY - bounds.top,
        active: clientY - bounds.top <= edgeThresholdY
      },
      {
        direction: 'bottom',
        score: bounds.bottom - clientY,
        active: bounds.bottom - clientY <= edgeThresholdY
      }
    ];
    const activeEdges = distances.filter((item) => item.active);
    const edgeMatch = activeEdges
      .filter((item) => supportsEdgeDrop(group, item.direction))
      .sort((left, right) => left.score - right.score)[0];

    if (edgeMatch) {
      return edgeMatch.direction;
    }

    if (activeEdges.length > 0 || !isPointerWithinBounds(bounds, clientX, clientY)) {
      return undefined;
    }

    return 'center';
  }

  function resolveEditorBodyDropDirection(
    group: DockingThreeGroupNode,
    bounds: DockingThreeGroupBounds,
    clientX: number,
    clientY: number,
    options?: {
      allowHorizontal?: boolean;
      allowVertical?: boolean;
    }
  ): Exclude<DockingThreeDropDirection, 'center'> | undefined {
    if (group.role !== 'editor') {
      return undefined;
    }

    const allowHorizontal = options?.allowHorizontal ?? true;
    const allowVertical = options?.allowVertical ?? true;
    const bodyTop = isWithinCenterDropHeader(group, bounds, bounds.top)
      ? Math.min(bounds.bottom, bounds.top + GROUP_HEADER_DROP_HEIGHT)
      : bounds.top;
    const bodyHeight = bounds.bottom - bodyTop;

    if (bounds.width <= 0 || bodyHeight <= 0 || clientY < bodyTop || clientY > bounds.bottom) {
      return undefined;
    }

    const relativeX = (clientX - bounds.left) / bounds.width;
    const relativeY = (clientY - bodyTop) / bodyHeight;
    const candidates: Array<{
      direction: Exclude<DockingThreeDropDirection, 'center'>;
      score: number;
      limit: number;
    }> = [];

    if (allowHorizontal && supportsEdgeDrop(group, 'left')) {
      candidates.push({
        direction: 'left',
        score: relativeX,
        limit: EDITOR_BODY_SIDE_ZONE_RATIO
      });
    }

    if (allowHorizontal && supportsEdgeDrop(group, 'right')) {
      candidates.push({
        direction: 'right',
        score: 1 - relativeX,
        limit: EDITOR_BODY_SIDE_ZONE_RATIO
      });
    }

    if (allowVertical && supportsEdgeDrop(group, 'top')) {
      candidates.push({
        direction: 'top',
        score: relativeY,
        limit: EDITOR_BODY_TOP_ZONE_RATIO
      });
    }

    if (allowVertical && supportsEdgeDrop(group, 'bottom')) {
      candidates.push({
        direction: 'bottom',
        score: 1 - relativeY,
        limit: EDITOR_BODY_BOTTOM_ZONE_RATIO
      });
    }

    return candidates
      .filter((candidate) => candidate.score >= 0 && candidate.score <= candidate.limit)
      .sort((left, right) => left.score - right.score)[0]
      ?.direction;
  }

  function behavesLikeWholeGroupEdgeDrag(sourceGroup: DockingThreeGroupNode): boolean {
    if (sourceGroup.role === 'editor') {
      return sourceGroup.tabs.length === 1;
    }

    // 侧栏标签按单个插件标签处理，即使分组只剩一个标签，也允许上/中/下停放。
    return false;
  }

  function resolveCenterDropInsertionIndex(groupId: string, clientX: number): number {
    const slots = groupCenterDropSlots.value[groupId];

    if (!slots || slots.length === 0) {
      return 0;
    }

    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;

    slots.forEach((slot, index) => {
      const centerX = slot.left + (slot.width / 2);
      const distance = Math.abs(clientX - centerX);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  function resolveNormalizedEdgeTarget(
    groupId: string,
    direction: Exclude<DockingThreeDropDirection, 'center'>
  ): {
    targetNodeId: string;
    direction: Exclude<DockingThreeDropDirection, 'center'>;
  } {
    if (direction === 'right' || direction === 'bottom') {
      return {
        targetNodeId: groupId,
        direction
      };
    }

    const targetPath = findNodePathById(root.value, groupId);

    if (!targetPath || targetPath.length < 2) {
      return {
        targetNodeId: groupId,
        direction
      };
    }

    const parentNode = targetPath[targetPath.length - 2];
    const childNode = targetPath[targetPath.length - 1];
    const targetAxis = direction === 'left' ? 'horizontal' : 'vertical';

    if (parentNode?.type !== 'split' || parentNode.axis !== targetAxis || !childNode) {
      return {
        targetNodeId: groupId,
        direction
      };
    }

    const childIndex = parentNode.children.findIndex((child) => child.id === childNode.id);

    if (childIndex <= 0) {
      return {
        targetNodeId: groupId,
        direction
      };
    }

    const previousSibling = parentNode.children[childIndex - 1];

    return {
      targetNodeId: previousSibling!.id,
      direction: direction === 'left' ? 'right' : 'bottom'
    };
  }

  function isEquivalentEdgeDropTarget(
    sourceGroup: DockingThreeGroupNode,
    targetNodeId: string,
    direction: Exclude<DockingThreeDropDirection, 'center'>
  ): boolean {
    if (!behavesLikeWholeGroupEdgeDrag(sourceGroup)) {
      return false;
    }

    const sourcePath = findNodePathById(root.value, sourceGroup.id);
    const targetPath = findNodePathById(root.value, targetNodeId);

    if (!sourcePath || !targetPath || sourcePath.length < 2 || targetPath.length < 2) {
      return false;
    }

    const sourceParent = sourcePath[sourcePath.length - 2];
    const targetParent = targetPath[targetPath.length - 2];
    const sourceNode = sourcePath[sourcePath.length - 1];
    const targetNode = targetPath[targetPath.length - 1];
    const insertionAxis = direction === 'left' || direction === 'right'
      ? 'horizontal'
      : 'vertical';

    if (
      sourceParent?.type !== 'split'
      || targetParent?.type !== 'split'
      || sourceParent.id !== targetParent.id
      || sourceParent.axis !== insertionAxis
      || !sourceNode
      || !targetNode
    ) {
      return false;
    }

    const sourceIndex = sourceParent.children.findIndex((child) => child.id === sourceNode.id);
    const targetIndex = targetParent.children.findIndex((child) => child.id === targetNode.id);

    if (sourceIndex === -1 || targetIndex === -1) {
      return false;
    }

    const insertionIndex = direction === 'left' || direction === 'top'
      ? targetIndex
      : targetIndex + 1;
    const nextIndex = insertionIndex > sourceIndex
      ? insertionIndex - 1
      : insertionIndex;

    return nextIndex === sourceIndex;
  }

  function supportsEdgeDrop(
    group: DockingThreeGroupNode,
    direction: Exclude<DockingThreeDropDirection, 'center'>
  ): boolean {
    if (direction === 'left' || direction === 'right') {
      return group.role === 'editor';
    }

    if (group.role === 'left-sidebar' || group.role === 'right-sidebar') {
      return direction === 'top' || direction === 'bottom';
    }

    if (group.role === 'editor') {
      return true;
    }

    return false;
  }

  function resolveDropDirection(
    group: DockingThreeGroupNode,
    bounds: DockingThreeGroupBounds,
    clientX: number,
    clientY: number
  ): DockingThreeDropDirection | undefined {
    const sidebarDirection = resolveSidebarDropDirection(group, bounds, clientY);
    if (sidebarDirection) {
      return sidebarDirection;
    }

    const edgeThresholdX = resolveHorizontalEdgeThreshold(bounds);
    const edgeThresholdY = resolveVerticalEdgeThreshold(bounds);
    const distances: Array<{
      direction: Exclude<DockingThreeDropDirection, 'center'>;
      score: number;
      active: boolean;
    }> = [
      {
        direction: 'left',
        score: clientX - bounds.left,
        active: clientX - bounds.left <= edgeThresholdX
      },
      {
        direction: 'right',
        score: bounds.right - clientX,
        active: bounds.right - clientX <= edgeThresholdX
      },
      {
        direction: 'top',
        score: clientY - bounds.top,
        active: clientY - bounds.top <= edgeThresholdY
      },
      {
        direction: 'bottom',
        score: bounds.bottom - clientY,
        active: bounds.bottom - clientY <= edgeThresholdY
      }
    ];
    const activeEdges = distances.filter((item) => item.active);
    const edgeMatch = activeEdges
      .filter((item) => supportsEdgeDrop(group, item.direction))
      .sort((left, right) => left.score - right.score)[0];

    if (edgeMatch) {
      return edgeMatch.direction;
    }

    if (activeEdges.length > 0) {
      return undefined;
    }

    if (isWithinCenterDropBand(group, bounds, clientY)) {
      return 'center';
    }

    const bodyDirection = resolveEditorBodyDropDirection(group, bounds, clientX, clientY);

    if (bodyDirection) {
      return bodyDirection;
    }

    if (supportsCenterDrop(group)) {
      return 'center';
    }

    return undefined;
  }

  function isPointerWithinBounds(
    bounds: DockingThreeGroupBounds,
    clientX: number,
    clientY: number
  ): boolean {
    return clientX >= bounds.left
      && clientX <= bounds.right
      && clientY >= bounds.top
      && clientY <= bounds.bottom;
  }

  function resolveBoundsOverflowDistance(
    bounds: DockingThreeGroupBounds,
    clientX: number,
    clientY: number
  ): number {
    const overflowLeft = Math.max(0, bounds.left - clientX);
    const overflowRight = Math.max(0, clientX - bounds.right);
    const overflowTop = Math.max(0, bounds.top - clientY);
    const overflowBottom = Math.max(0, clientY - bounds.bottom);

    return overflowLeft + overflowRight + overflowTop + overflowBottom;
  }

  /** 根据活动栏图标的垂直中线计算插件面板插入位置。 */
  function resolveActivityRailInsertionIndex(
    bounds: DockingThreeActivityRailBounds,
    clientY: number
  ): number {
    for (const [index, itemBounds] of bounds.itemBounds.entries()) {
      const midpoint = itemBounds.top + (itemBounds.height / 2);
      if (clientY < midpoint) {
        return index;
      }
    }

    return bounds.itemBounds.length;
  }

  /** Keep the activity-rail target active at the rail/panel boundary instead of falling through to a sidebar edge drop. */
  function isPointerWithinActivityRailBounds(
    bounds: DockingThreeActivityRailBounds,
    clientX: number,
    clientY: number
  ): boolean {
    return clientX >= bounds.left - ACTIVITY_RAIL_DROP_PADDING
      && clientX <= bounds.right + ACTIVITY_RAIL_DROP_PADDING
      && clientY >= bounds.top
      && clientY <= bounds.bottom;
  }

  /** Use the rendered rail as the source of truth while a drag is active. */
  function isPointerOverActivityRailElement(
    position: DockingThreeSidebarPosition,
    clientX: number,
    clientY: number
  ): boolean {
    if (typeof document === 'undefined') {
      return false;
    }

    const element = document.elementFromPoint(clientX, clientY);
    return Boolean(element?.closest(`[data-activity-rail-position="${position}"]`));
  }

  /** Resolve an edge fallback while the rail is hidden, mounting, or waiting for its first ResizeObserver pass. */
  function resolveActivityRailFallbackBounds(
    position: DockingThreeSidebarPosition
  ): DockingThreeActivityRailBounds {
    const viewportWidth = Math.max(window.innerWidth, ACTIVITY_RAIL_FALLBACK_WIDTH);
    const isLeft = position === 'left';
    const left = isLeft ? 0 : viewportWidth - ACTIVITY_RAIL_FALLBACK_WIDTH;
    const right = isLeft ? ACTIVITY_RAIL_FALLBACK_WIDTH : viewportWidth;

    return {
      position,
      left,
      top: 0,
      right,
      bottom: window.innerHeight,
      width: right - left,
      height: window.innerHeight,
      itemBounds: []
    };
  }

  function isSingleSidebarLaneSelfDrop(
    sourceGroup: DockingThreeGroupNode,
    targetGroup: DockingThreeGroupNode
  ): boolean {
    const sourcePosition = resolveSidebarLaneForGroup(sourceGroup.id);
    const targetPosition = resolveSidebarLaneForGroup(targetGroup.id);

    if (!sourcePosition || sourcePosition !== targetPosition) {
      return false;
    }

    const sourceSlot = findSidebarSlotForGroup(root.value, sourcePosition, sourceGroup.id);
    const targetSlot = findSidebarSlotForGroup(root.value, targetPosition, targetGroup.id);
    if (sourceSlot !== targetSlot) {
      return false;
    }

    return collectActivityRailPluginTabs(root.value, sourcePosition).length <= 1;
  }

  /** 解析插件面板拖入左右活动栏的目标，编辑器标签不会进入该路径。 */
  function resolveActivityRailDropTarget(
    clientX: number,
    clientY: number
  ): DockingThreeDropTarget | undefined {
    const dragState = activeTabDrag.value;
    const sourceGroup = dragState
      ? findGroupById(root.value, dragState.sourceGroupId)
      : undefined;
    const movingTab = dragState
      ? findTabById(root.value, dragState.sourceGroupId, dragState.tabId)
      : undefined;

    if (!dragState || !sourceGroup || !movingTab || !isSidebarPanelTab(movingTab) || sourceGroup.role === 'editor') {
      return undefined;
    }

    const positions: DockingThreeSidebarPosition[] = ['left', 'right'];
    for (const position of positions) {
      // Prefer the fixed edge zone over measured bounds. Measured bounds can
      // briefly describe the previous layout while the rail is being revealed
      // during a drag, which would otherwise route the drop to a sidebar split.
      const fallbackBounds = resolveActivityRailFallbackBounds(position);
      const measuredBounds = activityRailBounds.value[position];
      const overRenderedRail = isPointerOverActivityRailElement(position, clientX, clientY);
      const inFallbackZone = isPointerWithinActivityRailBounds(
        fallbackBounds,
        clientX,
        clientY
      );
      const inMeasuredZone = measuredBounds
        ? isPointerWithinActivityRailBounds(measuredBounds, clientX, clientY)
        : false;

      if (!overRenderedRail && !inFallbackZone && !inMeasuredZone) {
        continue;
      }

      const targetGroupId = resolveSidebarGroupId(position);
      // A single tab in the root sidebar group can still be a workspace
      // context. It must be allowed to move back to the activity rail; only an
      // item that is already rail-backed is a no-op at this target.
      if (
        sourceGroup.id === targetGroupId
        && sourceGroup.tabs.length <= 1
        && isActivityRailTab(movingTab)
      ) {
        continue;
      }

      const insertionIndex = resolveActivityRailInsertionIndex(
        measuredBounds ?? fallbackBounds,
        clientY
      );
      return {
        groupId: targetGroupId,
        targetNodeId: targetGroupId,
        direction: 'center',
        insertionIndex,
        activityRail: {
          position,
          insertionIndex
        }
      };
    }

    return undefined;
  }

  /** 从根侧栏移除最后一个插件标签但保留空根组，供跨活动栏停放使用。 */
  function removeActivityRailTab(
    node: DockingThreeNode,
    groupId: string,
    tabId: string
  ): DockingThreeNode {
    return updateGroupById(node, groupId, (group) => {
      const remainingTabs = group.tabs.filter((tab) => tab.id !== tabId).map(cloneTab);
      return {
        ...group,
        tabs: remainingTabs,
        activeTabId: remainingTabs[0]?.id ?? ''
      };
    });
  }

  function closeEmptyActivityRail(groupId: string): void {
    const position = groupId === LEFT_SIDEBAR_GROUP_ID
      ? 'left'
      : groupId === RIGHT_SIDEBAR_GROUP_ID
        ? 'right'
        : undefined;

    if (!position) {
      return;
    }

    if (!hasSidebarTab(root.value, position)) {
      setSidebarOpen(position, false);
    }
  }

  function normalizeCenterInsertionIndex(
    sourceGroup: DockingThreeGroupNode,
    tabId: string,
    targetGroupId: string,
    insertionIndex?: number
  ): number | undefined {
    if (insertionIndex === undefined) {
      return undefined;
    }

    if (sourceGroup.id !== targetGroupId) {
      return insertionIndex;
    }

    const sourceIndex = sourceGroup.tabs.findIndex((tab) => tab.id === tabId);

    if (sourceIndex === -1) {
      return insertionIndex;
    }

    return insertionIndex > sourceIndex
      ? insertionIndex - 1
      : insertionIndex;
  }

  function resolveSelfEditorDropDirection(
    group: DockingThreeGroupNode,
    bounds: DockingThreeGroupBounds,
    clientX: number,
    clientY: number
  ): DockingThreeDropDirection | undefined {
    if (isWithinCenterDropBand(group, bounds, clientY)) {
      return 'center';
    }

    const bodyDirection = resolveEditorBodyDropDirection(group, bounds, clientX, clientY, {
      allowHorizontal: false,
      allowVertical: true
    });

    return bodyDirection ?? 'center';
  }

  function resolveDropTarget(clientX: number, clientY: number): DockingThreeDropTarget | undefined {
    const sourceGroup = activeTabDrag.value
      ? findGroupById(root.value, activeTabDrag.value.sourceGroupId)
      : undefined;
    const movingTab = activeTabDrag.value
      ? findTabById(root.value, activeTabDrag.value.sourceGroupId, activeTabDrag.value.tabId)
      : undefined;

    if (!sourceGroup && !externalFileDrag.value) {
      return undefined;
    }

    const activityRailTarget = resolveActivityRailDropTarget(clientX, clientY);
    if (activityRailTarget) {
      return activityRailTarget;
    }

    const candidates = Object.entries(groupBounds.value)
      .filter(([groupId, bounds]) => {
        const withinExpandedX = (
          clientX >= bounds.left - DROP_EDGE_THRESHOLD
          && clientX <= bounds.right + DROP_EDGE_THRESHOLD
        );
        const withinExpandedY = (
          clientY >= bounds.top - DROP_EDGE_THRESHOLD
          && clientY <= bounds.bottom + DROP_EDGE_THRESHOLD
        );

        return withinExpandedX && withinExpandedY && isGroupVisible(groupId);
      })
      .map(([groupId, bounds]) => ({
        groupId,
        bounds,
        containsPointer: isPointerWithinBounds(bounds, clientX, clientY),
        overflowDistance: resolveBoundsOverflowDistance(bounds, clientX, clientY),
        area: bounds.width * bounds.height
      }))
      .sort((left, right) => {
        if (left.containsPointer !== right.containsPointer) {
          return left.containsPointer ? -1 : 1;
        }

        if (left.overflowDistance !== right.overflowDistance) {
          return left.overflowDistance - right.overflowDistance;
        }

        return left.area - right.area;
      });

    for (const candidate of candidates) {
      const group = findGroupById(root.value, candidate.groupId);

      if (!group) {
        continue;
      }

      const candidateSidebarPosition = resolveSidebarLaneForGroup(group.id);
      const candidateSidebarSlot = candidateSidebarPosition
        ? findSidebarSlotForGroup(root.value, candidateSidebarPosition, group.id)
        : undefined;

      if (externalFileDrag.value && candidateSidebarSlot) {
        continue;
      }

      if (candidateSidebarSlot && !isSidebarPanelTab(movingTab)) {
        continue;
      }

      const isSelfEditorReorderCandidate = (
        sourceGroup
        && !externalFileDrag.value
        &&
        candidate.groupId === sourceGroup.id
        && sourceGroup.role === 'editor'
        && sourceGroup.tabs.length > 1
        && candidate.containsPointer
      );
      const isExternalEditorCandidate = (
        (!sourceGroup || candidate.groupId !== sourceGroup.id)
        && group.role === 'editor'
        && Boolean(externalFileDrag.value)
      );
      const direction = isSelfEditorReorderCandidate
        ? resolveSelfEditorDropDirection(group, candidate.bounds, clientX, clientY)
        : isExternalEditorCandidate
          ? resolveExternalEditorDropDirection(group, candidate.bounds, clientX, clientY)
        : resolveDropDirection(group, candidate.bounds, clientX, clientY);

      if (!direction) {
        continue;
      }

      // Sidebar top containers are fixed, standalone contexts. The only
      // exception is their lower edge when no bottom container exists yet;
      // that edge creates the bottom fixed panel at commit time. Bottom
      // containers accept only a center drop so their content remains a
      // single tab toolbar.
      const canCreateSidebarBottom = Boolean(
        candidateSidebarSlot === 'top'
        && direction === 'bottom'
        && candidateSidebarPosition
        && !findSidebarSlotNode(root.value, candidateSidebarPosition, 'bottom')
      );
      if (candidateSidebarSlot === 'top' && !canCreateSidebarBottom) {
        continue;
      }

      if (
        isActivityContextSelfDrop(sourceGroup, movingTab, group)
        && !canCreateSidebarBottom
      ) {
        continue;
      }

      if (
        sourceGroup
        && (sourceGroup.role === 'left-sidebar' || sourceGroup.role === 'right-sidebar')
        && isSingleSidebarLaneSelfDrop(sourceGroup, group)
        && !canCreateSidebarBottom
      ) {
        continue;
      }

      if (candidateSidebarSlot === 'bottom' && direction !== 'center') {
        continue;
      }

      if (sourceGroup && candidate.groupId === sourceGroup.id) {
        const allowSelfCenterReorder = (
          direction === 'center'
          && sourceGroup.role === 'editor'
          && sourceGroup.tabs.length > 1
        );

        if (
          direction === 'center'
          && !allowSelfCenterReorder
        ) {
          continue;
        }

        if (sourceGroup.role !== 'left-sidebar'
          && sourceGroup.role !== 'right-sidebar'
          && behavesLikeWholeGroupEdgeDrag(sourceGroup)) {
          continue;
        }
      }

      const normalizedTarget = direction === 'center'
        ? undefined
        : (
            (group.role === 'left-sidebar' || group.role === 'right-sidebar')
            && (direction === 'top' || direction === 'bottom')
              ? { targetNodeId: candidate.groupId, direction }
              : resolveNormalizedEdgeTarget(candidate.groupId, direction)
          );

      if (
        sourceGroup
        &&
        normalizedTarget
        && isEquivalentEdgeDropTarget(
          sourceGroup,
          normalizedTarget.targetNodeId,
          normalizedTarget.direction
        )
      ) {
        continue;
      }

      return {
        groupId: candidate.groupId,
        targetNodeId: direction === 'center'
          ? candidate.groupId
          : normalizedTarget!.targetNodeId,
        direction: direction === 'center'
          ? direction
          : normalizedTarget!.direction,
        insertionIndex: direction === 'center'
          ? resolveCenterDropInsertionIndex(candidate.groupId, clientX)
          : undefined,
        ...(canCreateSidebarBottom && candidateSidebarPosition
          ? { sidebarBottom: candidateSidebarPosition }
          : {})
      };
    }

    return undefined;
  }

  function startActiveDrag(
    tabId: string,
    sourceGroupId: string,
    pointerX: number,
    pointerY: number
  ): void {
    activeTabDrag.value = {
      tabId,
      sourceGroupId,
      pointerX,
      pointerY,
      target: resolveDropTarget(pointerX, pointerY)
    };
  }

  /** 创建外部文件拖拽的临时标签，仅用于停靠预览和提交布局。 */
  function buildExternalDragTab(drag: ExternalFileDrag): DockingThreeTab {
    return {
      ...createEditorTab(drag.tabId, drag.title),
      title: drag.title,
      label: drag.title
    };
  }

  /** 开始由文件列表发起的外部文件拖拽。 */
  function startExternalFileDrag(path: string, title = path): void {
    const normalizedPath = path.trim();
    if (!normalizedPath) return;
    const tabId = "external-file-tab-" + (++externalFileDragSequence);
    externalFileDrag.value = {
      path: normalizedPath,
      title: title.trim() || normalizedPath,
      tabId,
      pointerX: 0,
      pointerY: 0
    };
  }

  /** 更新外部文件拖拽位置，并计算统一停靠目标。 */
  function updateExternalFileDrag(clientX: number, clientY: number): void {
    if (!externalFileDrag.value) return;
    externalFileDrag.value = {
      ...externalFileDrag.value,
      pointerX: clientX,
      pointerY: clientY,
      target: resolveDropTarget(clientX, clientY)
    };
  }

  /** 提交外部文件拖拽布局并返回待补齐文件内容的临时标签信息。 */
  function completeExternalFileDrag(): ExternalFileDropResult | undefined {
    const drag = externalFileDrag.value;
    const target = drag?.target;
    if (!drag || !target) {
      externalFileDrag.value = undefined;
      return undefined;
    }

    const tab = buildExternalDragTab(drag);
    let nextRoot = root.value;
    if (target.direction === 'center') {
      nextRoot = insertTabIntoGroup(nextRoot, target.groupId, tab, target.insertionIndex);
      root.value = nextRoot;
      setActiveTab(target.groupId, tab.id);
    } else {
      const nextGroup = buildEditorGroup(tab);
      nextRoot = splitNodeWithNewGroup(
        nextRoot,
        target.targetNodeId,
        target.direction,
        nextGroup,
        buildSplitId(false, `external-${tab.id}`)
      );
      root.value = nextRoot;
      setActiveTab(nextGroup.id, tab.id);
    }

    externalFileDrag.value = undefined;
    return {
      tabId: tab.id,
      path: drag.path,
      title: drag.title
    };
  }

  /** 取消外部文件拖拽并清除停靠预览。 */
  function cancelExternalFileDrag(): void {
    externalFileDrag.value = undefined;
  }

  /** 将外部文件读取结果写入临时标签，并完成其文件元数据绑定。 */
  function hydrateExternalFileTab(tabId: string, request: WorkspaceOpenFileRequest): void {
    root.value = updateNodeTabs(root.value, (tab) => {
      if (tab.id !== tabId) return tab;
      if (request.kind === 'text') {
        return {
          ...tab,
          title: request.title,
          label: request.title,
        kind: 'editor',
          filePath: request.filePath,
          relativePath: request.relativePath,
          temporary: request.temporary,
          initialValue: closeInlineChat(request.content)
        };
      }
      return {
        ...createMediaTab(tab.id, request.filePath, request.title, request.mediaMimeType),
        relativePath: request.relativePath,
        temporary: request.temporary
      };
    });
    if (request.kind === 'text') {
      const content = closeInlineChat(request.content);
      ensureEditorDocument(tabId, content);
      setEditorDocumentValue(tabId, content);
      setEditorDocumentBaseline(tabId, content);
    }
  }

  /** 删除外部文件拖拽未能解析出的临时标签。 */
  function discardExternalFileTab(tabId: string): void {
    const match = findNodePathById(root.value, tabId);
    const group = match?.at(-1);
    if (!group || group.type !== 'group') return;
    closeTab(group.id, tabId);
  }

  function handlePointerMove(clientX: number, clientY: number): void {
    if (pendingTabDrag.value && !activeTabDrag.value) {
      const deltaX = clientX - pendingTabDrag.value.startX;
      const deltaY = clientY - pendingTabDrag.value.startY;

      if (Math.hypot(deltaX, deltaY) >= TAB_DRAG_THRESHOLD) {
        startActiveDrag(
          pendingTabDrag.value.tabId,
          pendingTabDrag.value.sourceGroupId,
          clientX,
          clientY
        );
      }
    }

    if (!activeTabDrag.value) {
      return;
    }

    activeTabDrag.value = {
      ...activeTabDrag.value,
      pointerX: clientX,
      pointerY: clientY,
      target: resolveDropTarget(clientX, clientY)
    };
  }

  function buildDraggedLayout(
    target: DockingThreeDropTarget,
    preview = false
  ): DockingThreeNode | undefined {
    const dragState = activeTabDrag.value;

    if (!dragState) {
      return undefined;
    }

    const movingTab = findTabById(root.value, dragState.sourceGroupId, dragState.tabId);
    const sourceGroup = findGroupById(root.value, dragState.sourceGroupId);
    // A drop onto the activity rail always creates one independent panel for
    // the dragged tab. Never carry a nested context tree back onto the rail;
    // doing so is what leaves a previously merged A/B panel under B. For other
    // docking targets, a single-item activity branch may still move as a unit.
    const activityContextCandidate = isActivityRailTab(movingTab)
      && sourceGroup?.tabs.length === 1
      ? findActivityContextNode(dragState.tabId, dragState.sourceGroupId)
      : undefined;
    const activityBranchPluginCount = activityContextCandidate
      ? collectNodeTabs(activityContextCandidate.node).filter((tab) => isSidebarPanelTab(tab)).length
      : 0;
    const activityContext = !target.activityRail && activityBranchPluginCount <= 1
      ? activityContextCandidate
      : undefined;

    if (!movingTab || !sourceGroup) {
      return undefined;
    }

    if (
      target.direction !== 'center'
      && target.groupId !== dragState.sourceGroupId
      && target.targetNodeId === dragState.sourceGroupId
    ) {
      return undefined;
    }

    if (preview) {
      // 活动栏是独立的停靠表面，只显示活动栏插入预览，不预览侧栏上下文分组。
      if (target.activityRail) {
        return undefined;
      }

      if (target.direction === 'center') {
        return undefined;
      }

      if (target.sidebarBottom) {
        const bottomGroupId = target.sidebarBottom === 'left'
          ? LEFT_SIDEBAR_BOTTOM_GROUP_ID
          : RIGHT_SIDEBAR_BOTTOM_GROUP_ID;
        const previewRoot = ensureSidebarBottomContainer(
          cloneNode(root.value),
          target.sidebarBottom
        );

        return updateGroupById(previewRoot, bottomGroupId, (group) => ({
          ...group,
          tabs: [cloneTab(movingTab)],
          activeTabId: movingTab.id,
          previewGhost: true
        }));
      }

      const previewRoot = cloneNode(root.value);
      const previewGroup = activityContext
        ? remapNodeIds(activityContext.node, `preview-activity-${dragState.tabId}`)
        : buildPanelGroup(sourceGroup, cloneTab(movingTab), true);

      const previewTargetGroup = findGroupById(root.value, target.groupId);
      const splitBuilder = previewTargetGroup
        && (previewTargetGroup.role === 'left-sidebar' || previewTargetGroup.role === 'right-sidebar')
        ? splitNodeWithNestedNode
        : splitNodeWithNewNode;

      return splitBuilder(
        previewRoot,
        target.targetNodeId,
        target.direction,
        previewGroup,
        buildSplitId(true, `${target.targetNodeId}-${target.direction}-${dragState.tabId}`),
        'preview'
      );
    }

    let nextRoot = root.value;
    const isSidebarGroup = sourceGroup.role === 'left-sidebar'
      || sourceGroup.role === 'right-sidebar';
    const shouldRetainEditorHost = (
      isGroupInCenterWorkspace(sourceGroup.id)
      && countCenterWorkspaceEditorGroups() <= 1
    );

    if (activityContext) {
      nextRoot = removeNodeByIdPreservingParent(root.value, activityContext.node.id);
    } else if (sourceGroup.role === 'editor' && sourceGroup.tabs.length === 1) {
      nextRoot = shouldRetainEditorHost
        ? removeTabFromGroup(
          root.value,
          dragState.sourceGroupId,
          dragState.tabId,
          buildEditorHostReplacementTab()
        )
        : removeGroupById(root.value, dragState.sourceGroupId);
    } else if (sourceGroup.role === 'editor') {
      nextRoot = removeTabFromGroup(
        root.value,
        dragState.sourceGroupId,
        dragState.tabId
      );
    } else if (sourceGroup.role === 'bottom' && sourceGroup.tabs.length === 1) {
      nextRoot = removeGroupById(root.value, dragState.sourceGroupId);
    } else if (isSidebarGroup && sourceGroup.tabs.length === 1) {
      nextRoot = isRootSidebarGroupId(sourceGroup.id)
        ? removeActivityRailTab(root.value, dragState.sourceGroupId, dragState.tabId)
        : removeGroupById(root.value, dragState.sourceGroupId);
    } else {
      nextRoot = removeTabFromGroup(
        root.value,
        dragState.sourceGroupId,
        dragState.tabId
      );
    }

    if (target.activityRail) {
      nextRoot = removeTabFromSidebarLanes(nextRoot, dragState.tabId);
    }

    const tabToInsert = cloneTab(movingTab);
    const targetGroup = findGroupById(root.value, target.groupId);

    if (target.sidebarBottom) {
      const bottomGroupId = target.sidebarBottom === 'left'
        ? LEFT_SIDEBAR_BOTTOM_GROUP_ID
        : RIGHT_SIDEBAR_BOTTOM_GROUP_ID;
      let bottomRoot = ensureSidebarBottomContainer(nextRoot, target.sidebarBottom);
      const bottomGroup = findGroupById(bottomRoot, bottomGroupId);

      if (!bottomGroup) {
        return collapseEmptySidebarBottoms(bottomRoot);
      }

      if (activityContext) {
        const insertedTabIds = new Set<string>();
        for (const contextTab of collectNodeTabs(activityContext.node)) {
          if (insertedTabIds.has(contextTab.id)) {
            continue;
          }

          insertedTabIds.add(contextTab.id);
          bottomRoot = insertTabIntoGroup(
            bottomRoot,
            bottomGroup.id,
            {
              ...contextTab,
              ...withSidebarDockTarget(contextTab, 'context')
            }
          );
        }
      } else {
        bottomRoot = insertTabIntoGroup(
          bottomRoot,
          bottomGroup.id,
          {
            ...tabToInsert,
            ...withSidebarDockTarget(tabToInsert, 'context')
          }
        );
      }

      return collapseEmptySidebarBottoms(bottomRoot);
    }

    if (target.direction === 'center') {
      if (target.activityRail) {
        if (activityContext) {
          return appendNodeToSplit(
            nextRoot,
            target.activityRail.position === 'left' ? LEFT_SIDEBAR_TOP_ID : RIGHT_SIDEBAR_TOP_ID,
            remapNodeIds(activityContext.node, `activity-${dragState.tabId}`)
          );
        }

        const nextGroup = {
          ...buildPanelGroup(sourceGroup, tabToInsert),
          role: target.activityRail.position === 'left' ? 'left-sidebar' : 'right-sidebar'
        } satisfies DockingThreeGroupNode;

        nextGroup.tabs = nextGroup.tabs.map((tab) => ({
          ...tab,
          sidebarDockTarget: 'activity-rail'
        }));

        return appendActivityRailGroup(
          nextRoot,
          target.activityRail.position,
          nextGroup
        );
      }

      const nextInsertionIndex = normalizeCenterInsertionIndex(
        sourceGroup,
        dragState.tabId,
        target.groupId,
        target.insertionIndex
      );

      if (activityContext) {
        const targetSidebarPosition = resolveSidebarLaneForGroup(target.groupId);
        const targetSidebarSlot = targetSidebarPosition
          ? findSidebarSlotForGroup(root.value, targetSidebarPosition, target.groupId)
          : undefined;

        if (targetSidebarSlot === 'bottom' && targetGroup) {
          const insertedTabIds = new Set<string>();
          let bottomRoot = nextRoot;
          for (const contextTab of collectNodeTabs(activityContext.node)) {
            if (insertedTabIds.has(contextTab.id)) {
              continue;
            }

            insertedTabIds.add(contextTab.id);
            bottomRoot = insertTabIntoGroup(
              bottomRoot,
              targetGroup.id,
              {
                ...contextTab,
                ...withSidebarDockTarget(contextTab, 'context')
              }
            );
          }

          return bottomRoot;
        }

        const contextNode = updateNodeTabs(activityContext.node, (tab) =>
          tab.id === dragState.tabId
            ? withSidebarDockTarget(tab, 'context')
            : tab
        );
        return splitNodeWithNestedNode(
          nextRoot,
          target.groupId,
          'bottom',
          remapNodeIds(contextNode, `activity-${dragState.tabId}`),
          buildSplitId(false, `activity-context-${dragState.tabId}`)
        );
      }

      return insertTabIntoGroup(
        nextRoot,
        target.groupId,
        {
          ...tabToInsert,
          ...withSidebarDockTarget(tabToInsert, 'context')
        },
        nextInsertionIndex
      );
    }

    if (activityContext) {
      const contextNode = updateNodeTabs(activityContext.node, (tab) =>
        tab.id === dragState.tabId
          ? withSidebarDockTarget(tab, 'context')
          : tab
      );
      const isSidebarContextTarget = targetGroup?.role === 'left-sidebar'
        || targetGroup?.role === 'right-sidebar';
      const splitBuilder = isSidebarContextTarget
        ? splitNodeWithNestedNode
        : splitNodeWithNewNode;
      return splitBuilder(
        nextRoot,
        target.targetNodeId,
        target.direction,
        remapNodeIds(contextNode, `activity-${dragState.tabId}`),
        buildSplitId(preview, `${target.targetNodeId}-${target.direction}-${dragState.tabId}`),
        preview ? 'preview' : 'balanced'
      );
    }
    // Any plugin leaving the activity rail becomes a workspace context panel.
    // Marking it explicitly keeps it out of the rail and lets the target panel
    // render the shared icon toolbar, including single-item edge docks.
    const panelTab = withSidebarDockTarget(tabToInsert, 'context');
    const nextGroup = buildPanelGroup(sourceGroup, panelTab, preview);

    const isSidebarContextTarget = targetGroup?.role === 'left-sidebar'
      || targetGroup?.role === 'right-sidebar';
    const splitBuilder = isSidebarContextTarget
      ? splitNodeWithNestedGroup
      : splitNodeWithNewGroup;
    nextRoot = splitBuilder(
      nextRoot,
      target.targetNodeId,
      target.direction,
      nextGroup,
      buildSplitId(preview, `${target.targetNodeId}-${target.direction}-${tabToInsert.id}`),
      preview ? 'preview' : 'balanced'
    );

    return nextRoot;
  }

  function commitActiveDrag(): void {
    const dragState = activeTabDrag.value;
    const target = dragState?.target;
    const sourceGroup = dragState
      ? findGroupById(root.value, dragState.sourceGroupId)
      : undefined;

    if (!dragState || !target || !sourceGroup) {
      return;
    }

    const nextRoot = buildDraggedLayout(target);

    if (!nextRoot) {
      return;
    }

    const sourcePosition = resolveSidebarLaneForGroup(sourceGroup.id);
    root.value = collapseEmptySidebarBottoms(nextRoot);

    const shouldCloseSourceSidebar = (
      sourcePosition
      && !hasSidebarTab(nextRoot, sourcePosition)
    );

    if (shouldCloseSourceSidebar) {
      setSidebarOpen(sourcePosition, false);
    }

    if (target.activityRail) {
      setSidebarOpen(target.activityRail.position, true);
      const targetGroup = findSidebarGroupWithTab(
        nextRoot,
        target.activityRail.position,
        dragState.tabId
      );
      setActiveTab(targetGroup?.id ?? target.groupId, dragState.tabId);
      return;
    }

    if (target.direction === 'center') {
      focusGroup(target.groupId);
      return;
    }

    if (sourceGroup.role === 'editor') {
      focusedGroupId.value = `editor-group-${editorGroupSequence.value}`;
      activeEditorGroupId.value = `editor-group-${editorGroupSequence.value}`;
      return;
    }

    if (sourceGroup.role === 'bottom') {
      const nextEditorGroup = findFirstEditorGroup(nextRoot);
      if (nextEditorGroup) {
        focusedGroupId.value = nextEditorGroup.id;
        activeEditorGroupId.value = nextEditorGroup.id;
      }
      return;
    }

    const nextEditorGroup = findFirstEditorGroup(nextRoot);

    focusedGroupId.value = `${sourceGroup.role}-group-${panelGroupSequence.value}`;

    if (nextEditorGroup) {
      activeEditorGroupId.value = nextEditorGroup.id;
    }
  }

  function handlePointerUp(): void {
    if (activeTabDrag.value) {
      commitActiveDrag();
    }

    // A pointer sequence that never crossed the drag threshold is a normal
    // click. Let the originating tab/rail click handler perform activation or
    // toggle the sidebar; activating here would reopen a closed rail before the
    // click handler runs and immediately close it again.
    pendingTabDrag.value = undefined;
    activeTabDrag.value = undefined;
  }

  function cancelDrag(): void {
    pendingTabDrag.value = undefined;
    activeTabDrag.value = undefined;
    externalFileDrag.value = undefined;
  }

  function setSplitSizes(splitId: string, nextSizes: readonly number[]): void {
    root.value = updateSplitById(root.value, splitId, (split) => ({
      ...split,
      sizes: [...nextSizes]
    }));
  }

  function resizeSplitPair(
    splitId: string,
    leftIndex: number,
    rightIndex: number,
    deltaRatio: number,
    baselineLeftSize?: number,
    baselineRightSize?: number
  ): void {
    const split = findSplitById(root.value, splitId);

    if (!split) {
      return;
    }

    const nextSizes = [...split.sizes];
    const leftSize = baselineLeftSize ?? nextSizes[leftIndex]!;
    const rightSize = baselineRightSize ?? nextSizes[rightIndex]!;
    const pairTotal = leftSize + rightSize;
    const sidebarResizeTarget = resolveRootSidebarResizeTarget(splitId, leftIndex, rightIndex);
    const minimumSize = resolveMinimumSplitSize(pairTotal);
    const nextSidebarSize = sidebarResizeTarget === 'left'
      ? leftSize + deltaRatio
      : sidebarResizeTarget === 'right'
        ? rightSize - deltaRatio
        : undefined;

    if (sidebarResizeTarget && nextSidebarSize !== undefined) {
      if (nextSidebarSize <= minimumSize) {
        setSidebarOpen(sidebarResizeTarget, false);
        return;
      }

      setSidebarOpen(sidebarResizeTarget, true);
    }

    const nextLeft = clampRatio(leftSize + deltaRatio, pairTotal);
    const nextRight = pairTotal - nextLeft;

    nextSizes[leftIndex] = nextLeft;
    nextSizes[rightIndex] = nextRight;

    setSplitSizes(splitId, nextSizes);
  }

  function findSplitById(
    node: DockingThreeNode,
    splitId: string
  ): DockingThreeSplitNode | undefined {
    if (node.type === 'group') {
      return undefined;
    }

    if (node.id === splitId) {
      return node;
    }

    for (const child of node.children) {
      const match = findSplitById(child, splitId);

      if (match) {
        return match;
      }
    }

    return undefined;
  }

  function clampRatio(value: number, total: number): number {
    const minimum = resolveMinimumSplitSize(total);
    return Math.max(minimum, Math.min(total - minimum, value));
  }

  /**
   * 计算当前分割对允许保留的最小尺寸，供常规限位与侧边栏自动收起共用。
   */
  function resolveMinimumSplitSize(total: number): number {
    return Math.min(MIN_RESIZE_RATIO, total / 2);
  }

  const isDragging = computed(() => Boolean(activeTabDrag.value || externalFileDrag.value));

  const externalPreviewRoot = computed(() => {
    const fileDrag = externalFileDrag.value;
    if (!fileDrag?.target || fileDrag.target.direction === 'center') return undefined;
    const previewRoot = cloneNode(root.value);
    const previewGroup = buildEditorGroup(buildExternalDragTab(fileDrag), true);
    return splitNodeWithNewGroup(
      previewRoot,
      fileDrag.target.targetNodeId,
      fileDrag.target.direction,
      previewGroup,
      buildSplitId(true, `external-${fileDrag.tabId}`),
      'preview'
    );
  });

  /** 返回外部文件拖拽命中编辑器中心时的覆盖预览区域。 */
  const externalCenterPreview = computed(() => {
    const fileDrag = externalFileDrag.value;
    const target = fileDrag?.target;

    if (!fileDrag || !target || target.direction !== 'center') {
      return undefined;
    }

    const bounds = groupBounds.value[target.groupId];
    if (!bounds) {
      return undefined;
    }

    const bodyTop = Math.min(bounds.bottom, bounds.top + GROUP_HEADER_DROP_HEIGHT);
    return {
      ...bounds,
      top: bodyTop,
      height: Math.max(0, bounds.bottom - bodyTop),
      title: fileDrag.title
    };
  });

  const sidebarCenterPreview = computed(() => {
    const drag = activeTabDrag.value;
    const target = drag?.target;

    if (!drag || !target || target.direction !== 'center' || target.activityRail) {
      return undefined;
    }

    const targetGroup = findGroupById(root.value, target.groupId);
    if (
      !targetGroup
      || (targetGroup.role !== 'left-sidebar' && targetGroup.role !== 'right-sidebar')
      || targetGroup.tabs.length > 1
    ) {
      return undefined;
    }

    const bounds = groupBounds.value[target.groupId];
    const tab = findTabById(root.value, drag.sourceGroupId, drag.tabId);
    if (!bounds || !tab) {
      return undefined;
    }

    const sidebarPosition = resolveSidebarLaneForGroup(target.groupId);
    const sidebarSlot = sidebarPosition
      ? findSidebarSlotForGroup(root.value, sidebarPosition, target.groupId)
      : undefined;
    // The bottom fixed sidebar owns its toolbar; a center-drop preview covers
    // only the panel body that would receive the tab content.
    const bodyTop = sidebarSlot === 'bottom'
      ? Math.min(bounds.bottom, bounds.top + GROUP_HEADER_DROP_HEIGHT)
      : bounds.top;

    return {
      ...bounds,
      top: bodyTop,
      height: Math.max(0, bounds.bottom - bodyTop),
      title: tab.title
    };
  });

  const previewRoot = computed(() => {
    const target = activeTabDrag.value?.target;

    if (target) return buildDraggedLayout(target, true);
    return externalPreviewRoot.value;
  });

  const activityRailPreview = computed<DockingThreeActivityRailPreview | undefined>(() =>
    activeTabDrag.value?.target?.activityRail
  );

  const isFileDragging = computed(() => Boolean(externalFileDrag.value));

  const dragAvatar = computed(() => {
    const dragState = activeTabDrag.value;

    if (dragState) {
      const tab = findTabById(root.value, dragState.sourceGroupId, dragState.tabId);
      const group = findGroupById(root.value, dragState.sourceGroupId);
      if (!tab || !group) return undefined;
      return {
        title: tab.title,
        left: dragState.pointerX,
        top: dragState.pointerY
      };
    }

    const fileDrag = externalFileDrag.value;
    return fileDrag
      ? { title: fileDrag.title, left: fileDrag.pointerX, top: fileDrag.pointerY }
      : undefined;
  });

  /** 返回当前活动编辑器标签对应的文档类型名称。 */
  const activeDocumentTypeLabel = computed(() => {
    const focusedGroup = findGroupById(root.value, focusedGroupId.value);
    const activeGroup = focusedGroup?.role === 'editor'
      ? focusedGroup
      : findGroupById(root.value, activeEditorGroupId.value);
    const activeTab = activeGroup?.tabs.find((tab) => tab.id === activeGroup.activeTabId);

    return resolveDocumentTypeLabel(activeTab);
  });

  /** 返回当前活动的文本编辑器标签摘要，供工作台级路径导航使用。 */
  const activeEditorTab = computed(() => {
    const activeGroup = findGroupById(root.value, activeEditorGroupId.value);
    const activeTab = activeGroup?.tabs.find((tab) => tab.id === activeGroup.activeTabId);

    return activeTab?.kind === 'editor'
      ? {
          id: activeTab.id,
          title: activeTab.title,
          filePath: activeTab.filePath,
          relativePath: activeTab.relativePath,
          temporary: activeTab.temporary
        }
      : undefined;
  });

  /** 返回当前活动编辑器标签关联的文件路径，供工作区插件定位文件。 */
  const activeWorkspaceFilePath = computed(() => {
    const activeGroup = findGroupById(root.value, activeEditorGroupId.value);
    const activeTab = activeGroup?.tabs.find((tab) => tab.id === activeGroup.activeTabId);
    return activeTab?.relativePath ?? activeTab?.filePath;
  });

  const dropIndicator = computed(() => {
    const target = activeTabDrag.value?.target ?? externalFileDrag.value?.target;
    if (!target || target.direction !== 'center' || target.activityRail) {
      return undefined;
    }

    const slots = groupCenterDropSlots.value[target.groupId];

    if (!slots || slots.length === 0) {
      return undefined;
    }

    const targetIndex = Math.max(0, Math.min(slots.length - 1, target.insertionIndex ?? 0));

    return slots[targetIndex];
  });

  /** 将当前窗口布局重置为仅包含中央标签组的专用窗口。 */
  function configureTabWindow(): void {
    isTabWindow.value = true;
    root.value = buildEditorOnlyDockingTree(initialWelcomeTab);
    tabActivationHistory.value = {};
    activeEditorGroupId.value = DEFAULT_EDITOR_GROUP_ID;
    focusedGroupId.value = DEFAULT_EDITOR_GROUP_ID;
    leftSidebarOpen.value = false;
    rightSidebarOpen.value = false;
  }

  return {
    root,
    editorDocuments,
    editorSelections,
    recentWorkspaceFiles,
    pendingEditorNavigation,
    notePropertiesVisibility,
    pendingNotePropertiesMenu,
    previewRoot,
    activityRailPreview,
    externalCenterPreview,
    sidebarCenterPreview,
    dragAvatar,
    isDragging,
    isFileDragging,
    dropIndicator,
    ensureEditorDocument,
    setEditorDocumentValue,
    getEditorDocumentBaseline,
    getEditorDocumentBaselineByFilePath,
    isEditorDocumentDirty,
    setEditorSelection,
    setNotePropertiesVisibility,
    requestNotePropertiesMenu,
    isPathNavigationVisible,
    setPathNavigationVisibility,
    updateEditorDocumentByFilePath,
    updateEditorDocumentBaselineByFilePath,
    syncWorkspaceWidth,
    leftSidebarOpen,
    rightSidebarOpen,
    leftSidebarRailSections,
    rightSidebarRailSections,
    activeLeftSidebarPanelId,
    activeRightSidebarPanelId,
    activeEditorGroupId,
    focusedGroupId,
    activeEditorTab,
    activeDocumentTypeLabel,
    activeWorkspaceFilePath,
    activeTabDrag,
    isGroupVisible,
    setGroupBoundsEntry,
    clearGroupBoundsEntry,
    setGroupCenterDropSlotsEntry,
    clearGroupCenterDropSlotsEntry,
    setActivityRailBounds,
    clearActivityRailBounds,
    handleSidebarRailSelect,
    toggleSidebar,
    focusGroup,
    focusEditorGroup,
    setActiveTab,
    clearRecentWorkspaceFiles,
    createEditorTabInGroup,
    openTextFileAtPosition,
    openWorkspaceFile,
    configureTabWindow,
    openPluginView,
    openSettingsTab,
    closePluginView,
    closePluginViews,
    createWelcomeTabInGroup,
    replaceWelcomeTabWithEditor,
    closeTab,
    renameTab,
    updateWebViewerTabMetadata,
    updateWorkspaceFilePath,
    closeWorkspaceFileTabs,
    closeWorkspaceFileTabsByPath,
    closeAllEditorGroups,
    closeOtherTabs,
    closeAllTabs,
    closeTabsToLeft,
    closeTabsToRight,
    splitTab,
    beginPendingTabDrag,
    clearPendingDrag,
    handlePointerMove,
    handlePointerUp,
    cancelDrag,
    startExternalFileDrag,
    updateExternalFileDrag,
    completeExternalFileDrag,
    cancelExternalFileDrag,
    hydrateExternalFileTab,
    discardExternalFileTab,
    resizeSplitPair
  };
});
