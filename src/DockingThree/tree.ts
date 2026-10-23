/**
 * 文件说明：提供 DockingThree 布局树的节点创建、查找、插入、移除与分裂等纯函数。
 */
import {
  CENTER_COLUMN_NODE_ID,
  DEFAULT_EDITOR_GROUP_ID,
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
  leftSidebarPanels,
  rightSidebarPanels
} from '@/DockingThree/definitions';
import type {
  DockingThreeDropDirection,
  DockingThreeGroupNode,
  DockingThreeNode,
  DockingThreeSidebarPanelDefinition,
  DockingThreeSplitNode,
  DockingThreeTab
} from '@/DockingThree/types';
import type { PluginViewContributionSummary } from '../../plugin/sdk';

function cloneTab(tab: DockingThreeTab): DockingThreeTab {
  return { ...tab };
}

export const ROOT_DEFAULT_SIDEBAR_SIZE = 244;
const ROOT_DEFAULT_CENTER_SIZE = 1;
const INSERTED_HORIZONTAL_GROUP_SIZE_RATIO = 0.3;
const INSERTED_VERTICAL_GROUP_SIZE_RATIO = 0.24;
const ROOT_SPLIT_ID = 'dock-split-root';

type DockingThreeSplitSizeMode = 'balanced' | 'preview';

function getInsertedGroupSizeRatio(
  direction: Exclude<DockingThreeDropDirection, 'center'>
): number {
  return direction === 'left' || direction === 'right'
    ? INSERTED_HORIZONTAL_GROUP_SIZE_RATIO
    : INSERTED_VERTICAL_GROUP_SIZE_RATIO;
}

function containsSidebarRole(node: DockingThreeNode): boolean {
  if (node.type === 'group') {
    return node.role === 'left-sidebar' || node.role === 'right-sidebar';
  }

  return node.children.some((child) => containsSidebarRole(child));
}

function shouldPreserveSplitChildSize(
  splitId: string,
  splitAxis: DockingThreeSplitNode['axis'],
  node: DockingThreeNode
): boolean {
  return splitId === ROOT_SPLIT_ID
    && splitAxis === 'horizontal'
    && containsSidebarRole(node);
}

function buildBalancedSplitSizes(
  splitId: string,
  splitAxis: DockingThreeSplitNode['axis'],
  children: readonly DockingThreeNode[],
  previousChildren: readonly DockingThreeNode[],
  previousSizes: readonly number[]
): number[] {
  if (children.length === 0) {
    return [];
  }

  const sizeById = new Map(
    previousChildren.map((child, index) => [child.id, previousSizes[index] ?? 1] as const)
  );
  const totalSize = previousSizes.reduce((sum, size) => sum + size, 0) || children.length;
  const nextSizes = children.map((child) => sizeById.get(child.id) ?? 1);
  const flexibleIndexes = children.flatMap((child, index) =>
    shouldPreserveSplitChildSize(splitId, splitAxis, child) ? [] : [index]
  );

  if (flexibleIndexes.length === 0) {
    return nextSizes;
  }

  const fixedTotal = children.reduce((sum, child, index) => {
    if (!shouldPreserveSplitChildSize(splitId, splitAxis, child)) {
      return sum;
    }

    return sum + nextSizes[index]!;
  }, 0);
  const flexibleTotal = totalSize - fixedTotal;
  const balancedFlexibleSize = (
    flexibleTotal > 0 ? flexibleTotal : flexibleIndexes.length
  ) / flexibleIndexes.length;

  return children.map((child, index) =>
    shouldPreserveSplitChildSize(splitId, splitAxis, child)
      ? nextSizes[index]!
      : balancedFlexibleSize
  );
}

export function cloneNode(node: DockingThreeNode): DockingThreeNode {
  if (node.type === 'group') {
    return {
      ...node,
      tabs: node.tabs.map(cloneTab)
    };
  }

  return {
    ...node,
    sizes: [...node.sizes],
    children: node.children.map(cloneNode)
  };
}

export function createEditorTab(id: string, title = '新标签页'): DockingThreeTab {
  return {
    id,
    title,
    kind: 'editor',
    label: title,
    closable: true
  };
}

/**
 * 创建默认欢迎页标签，作为工作台首次打开时的入口页。
 */
export function createWelcomeTab(id: string, title = '启动页'): DockingThreeTab {
  return {
    id,
    title,
    kind: 'welcome',
    label: title,
    closable: true
  };
}

/** 创建工作台设置标签，供主窗口内的设置入口复用。 */
export function createSettingsTab(
  id: string,
  title = '设置',
  settingsNavigationId?: string
): DockingThreeTab {
  return {
    id,
    title,
    kind: 'settings',
    label: title,
    closable: true,
    ...(settingsNavigationId ? { settingsNavigationId } : {})
  };
}

/** 创建由插件视图贡献驱动的停靠标签。 */
export function createPluginTab(
  id: string,
  pluginId: string,
  view: PluginViewContributionSummary,
  viewInstanceId: string,
  viewInitialUrl?: string
): DockingThreeTab {
  return {
    id,
    title: view.title,
    kind: 'plugin',
    label: `${view.title} (${pluginId})`,
    closable: true,
    pluginId,
    viewType: view.type,
    viewCapabilities: view.capabilities,
    viewIconUrl: view.iconUrl,
    viewInstanceId,
    ...(viewInitialUrl ? { viewInitialUrl } : {})
  };
}

/** Creates a dockable panel owned by the host application rather than a plugin. */
export function createHostPanelTab(
  id: string,
  title: string,
  label: string,
  icon: Pick<DockingThreeSidebarPanelDefinition, 'iconClass' | 'iconUrl'>
): DockingThreeTab {
  return {
    id,
    title,
    kind: 'host-panel',
    label,
    closable: false,
    hostPanelId: id,
    ...(icon.iconUrl ? { hostPanelIconUrl: icon.iconUrl } : {}),
    ...(icon.iconClass ? { hostPanelIconClass: icon.iconClass } : {}),
    sidebarDockTarget: 'activity-rail'
  };
}

/** 创建由工作区媒体文件驱动的停靠标签。 */
export function createMediaTab(
  id: string,
  filePath: string,
  title: string,
  mediaMimeType: string
): DockingThreeTab {
  return {
    id,
    title,
    kind: 'media',
    label: title,
    closable: true,
    filePath,
    mediaMimeType
  };
}

function createSidebarTabs(
  panels: ReadonlyArray<{
    id: string;
    title: string;
    label: string;
    iconUrl?: string;
    iconClass?: string;
  }>
): DockingThreeTab[] {
  return panels.map((panel) => createHostPanelTab(
    panel.id,
    panel.title,
    panel.label,
    panel
  ));
}

function createSidebarContainer(
  id: string,
  child: DockingThreeGroupNode
): DockingThreeSplitNode {
  return {
    id,
    type: 'split',
    axis: 'vertical',
    sizes: [1],
    children: [child]
  };
}

function createSidebarLane(
  id: string,
  top: DockingThreeSplitNode,
  bottom?: DockingThreeSplitNode
): DockingThreeSplitNode {
  const children = (bottom ? [top, bottom] : [top]).map(cloneNode);

  return {
    id,
    type: 'split',
    axis: 'vertical',
    sizes: bottom ? [2, 1] : [1],
    children
  };
}

function isSidebarSlotId(nodeId: string): boolean {
  return nodeId === LEFT_SIDEBAR_TOP_ID
    || nodeId === LEFT_SIDEBAR_BOTTOM_ID
    || nodeId === RIGHT_SIDEBAR_TOP_ID
    || nodeId === RIGHT_SIDEBAR_BOTTOM_ID;
}

function createEmptySidebarContainer(nodeId: string): DockingThreeSplitNode {
  const isLeft = nodeId === LEFT_SIDEBAR_TOP_ID || nodeId === LEFT_SIDEBAR_BOTTOM_ID;
  const isTop = nodeId === LEFT_SIDEBAR_TOP_ID || nodeId === RIGHT_SIDEBAR_TOP_ID;
  const groupId = isTop
    ? (isLeft ? LEFT_SIDEBAR_GROUP_ID : RIGHT_SIDEBAR_GROUP_ID)
    : (isLeft ? LEFT_SIDEBAR_BOTTOM_GROUP_ID : RIGHT_SIDEBAR_BOTTOM_GROUP_ID);

  return createSidebarContainer(
    nodeId,
    createWorkbenchGroupWithTabs(
      groupId,
      isLeft ? 'left-sidebar' : 'right-sidebar',
      []
    )
  );
}

function resolveGroupHeader(): DockingThreeGroupNode['header'] {
  return 'tabs';
}

function createWorkbenchGroupWithTabs(
  id: string,
  role: DockingThreeGroupNode['role'],
  tabs: readonly DockingThreeTab[],
  activeTabId = tabs[0]?.id,
  previewGhost = false
): DockingThreeGroupNode {
  const nextTabs = tabs.map(cloneTab);
  const nextActiveTabId = nextTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : nextTabs[0]?.id ?? '';

  return {
    id,
    type: 'group',
    role,
    header: resolveGroupHeader(),
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    previewGhost
  };
}

export function createWorkbenchGroup(
  id: string,
  role: DockingThreeGroupNode['role'],
  tab: DockingThreeTab,
  previewGhost = false
): DockingThreeGroupNode {
  return createWorkbenchGroupWithTabs(id, role, [tab], tab.id, previewGhost);
}

export function createEditorGroup(
  id: string,
  tab: DockingThreeTab,
  previewGhost = false
): DockingThreeGroupNode {
  return createWorkbenchGroup(id, 'editor', tab, previewGhost);
}

export function buildInitialDockingTree(
  editorTab: DockingThreeTab
): DockingThreeNode {
  const leftSidebarTabs = createSidebarTabs(leftSidebarPanels);
  const rightSidebarTabs = createSidebarTabs(rightSidebarPanels);
  const leftSidebarRootGroup = createWorkbenchGroupWithTabs(
    LEFT_SIDEBAR_GROUP_ID,
    'left-sidebar',
    leftSidebarTabs
  );
  const rightSidebarRootGroup = createWorkbenchGroupWithTabs(
    RIGHT_SIDEBAR_GROUP_ID,
    'right-sidebar',
    rightSidebarTabs
  );

  return {
    id: 'dock-split-root',
    type: 'split',
    axis: 'horizontal',
    sizes: [ROOT_DEFAULT_SIDEBAR_SIZE, ROOT_DEFAULT_CENTER_SIZE, ROOT_DEFAULT_SIDEBAR_SIZE],
    children: [
      {
        id: LEFT_SIDEBAR_LANE_ID,
        type: 'split',
        axis: 'vertical',
        sizes: [1],
        children: [
          createSidebarContainer(LEFT_SIDEBAR_TOP_ID, leftSidebarRootGroup)
        ]
      },
      {
        id: CENTER_COLUMN_NODE_ID,
        type: 'split',
        axis: 'vertical',
        sizes: [1],
        children: [
          createEditorGroup(DEFAULT_EDITOR_GROUP_ID, editorTab)
        ]
      },
      {
        id: RIGHT_SIDEBAR_LANE_ID,
        type: 'split',
        axis: 'vertical',
        sizes: [1],
        children: [
          createSidebarContainer(RIGHT_SIDEBAR_TOP_ID, rightSidebarRootGroup)
        ]
      }
    ]
  };
}

/** 构造专用标签窗口使用的单一中央编辑器组。 */
export function buildEditorOnlyDockingTree(editorTab: DockingThreeTab): DockingThreeNode {
  return createEditorGroup(DEFAULT_EDITOR_GROUP_ID, editorTab);
}

export function findGroupById(
  node: DockingThreeNode,
  groupId: string
): DockingThreeGroupNode | undefined {
  if (node.type === 'group') {
    return node.id === groupId ? node : undefined;
  }

  for (const child of node.children) {
    const match = findGroupById(child, groupId);

    if (match) {
      return match;
    }
  }

  return undefined;
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

export function findFirstEditorGroup(node: DockingThreeNode): DockingThreeGroupNode | undefined {
  if (node.type === 'group') {
    return node.role === 'editor' ? node : undefined;
  }

  for (const child of node.children) {
    const match = findFirstEditorGroup(child);

    if (match) {
      return match;
    }
  }

  return undefined;
}

export function findTabById(
  node: DockingThreeNode,
  groupId: string,
  tabId: string
): DockingThreeTab | undefined {
  const group = findGroupById(node, groupId);

  return group?.tabs.find((tab) => tab.id === tabId);
}

export function findNodePathById(
  node: DockingThreeNode,
  nodeId: string
): DockingThreeNode[] | undefined {
  if (node.id === nodeId) {
    return [node];
  }

  if (node.type === 'group') {
    return undefined;
  }

  for (const child of node.children) {
    const childPath = findNodePathById(child, nodeId);

    if (childPath) {
      return [node, ...childPath];
    }
  }

  return undefined;
}

export function updateGroupById(
  node: DockingThreeNode,
  groupId: string,
  updater: (group: DockingThreeGroupNode) => DockingThreeGroupNode
): DockingThreeNode {
  if (node.type === 'group') {
    return node.id === groupId ? updater(node) : cloneNode(node);
  }

  return {
    ...node,
    sizes: [...node.sizes],
    children: node.children.map((child) => updateGroupById(child, groupId, updater))
  };
}

export function updateSplitById(
  node: DockingThreeNode,
  splitId: string,
  updater: (split: DockingThreeSplitNode) => DockingThreeSplitNode
): DockingThreeNode {
  if (node.type === 'group') {
    return cloneNode(node);
  }

  if (node.id === splitId) {
    return updater(node);
  }

  return {
    ...node,
    sizes: [...node.sizes],
    children: node.children.map((child) => updateSplitById(child, splitId, updater))
  };
}

export function removeTabFromGroup(
  node: DockingThreeNode,
  groupId: string,
  tabId: string,
  replacementTab?: DockingThreeTab
): DockingThreeNode {
  return updateGroupById(node, groupId, (group) => {
    const remainingTabs = group.tabs
      .filter((tab) => tab.id !== tabId)
      .map(cloneTab);

    if (remainingTabs.length === 0 && replacementTab) {
      return {
        ...group,
        tabs: [cloneTab(replacementTab)],
        activeTabId: replacementTab.id
      };
    }

    if (remainingTabs.length === 0) {
      return {
        ...group,
        tabs: group.tabs.map(cloneTab)
      };
    }

    const removedTabIndex = group.tabs.findIndex((tab) => tab.id === tabId);
    const previousTabIndex = Math.max(0, removedTabIndex - 1);
    const nextActiveTabId = group.activeTabId === tabId
      ? remainingTabs[previousTabIndex]?.id ?? remainingTabs[0]!.id
      : remainingTabs.some((tab) => tab.id === group.activeTabId)
        ? group.activeTabId
        : remainingTabs[0]!.id;

    return {
      ...group,
      tabs: remainingTabs,
      activeTabId: nextActiveTabId
    };
  });
}

export function insertTabIntoGroup(
  node: DockingThreeNode,
  groupId: string,
  tab: DockingThreeTab,
  insertionIndex?: number
): DockingThreeNode {
  return updateGroupById(node, groupId, (group) => {
    const nextTabs = group.tabs.map(cloneTab);
    const nextIndex = insertionIndex === undefined
      ? nextTabs.length
      : Math.max(0, Math.min(nextTabs.length, insertionIndex));

    nextTabs.splice(nextIndex, 0, cloneTab(tab));

    return {
      ...group,
      tabs: nextTabs,
      activeTabId: tab.id
    };
  });
}

export function setGroupActiveTab(
  node: DockingThreeNode,
  groupId: string,
  tabId: string
): DockingThreeNode {
  return updateGroupById(node, groupId, (group) => ({
    ...group,
    activeTabId: group.tabs.some((tab) => tab.id === tabId) ? tabId : group.activeTabId
  }));
}

export function removeGroupById(
  node: DockingThreeNode,
  groupId: string
): DockingThreeNode {
  const nextNode = removeNodeById(node, groupId);

  return nextNode ?? cloneNode(node);
}

/** Remove any subtree while preserving the caller's surrounding split shape. */
export function removeNodeByIdPreservingParent(
  node: DockingThreeNode,
  nodeId: string
): DockingThreeNode {
  const nextNode = removeNodeByIdKeepingSidebarLanes(node, nodeId);

  // The public helper is used for moving a subtree, so the root itself must
  // remain available even when a malformed target would otherwise remove it.
  return nextNode ?? cloneNode(node);
}

/**
 * Remove a subtree while retaining the stable left/right sidebar lane nodes.
 *
 * Activity-rail contexts can be the only child of a lane. The generic removal
 * helper correctly reports an empty branch as `undefined`, but that would make
 * the whole lane disappear and callers could then reinsert the moved subtree
 * without removing its source, producing duplicate activity items.
 */
function removeNodeByIdKeepingSidebarLanes(
  node: DockingThreeNode,
  nodeId: string
): DockingThreeNode | undefined {
  if (node.id === nodeId) {
    if (
      node.type === 'split'
      && (node.id === LEFT_SIDEBAR_LANE_ID || node.id === RIGHT_SIDEBAR_LANE_ID)
    ) {
      return createEmptySidebarLane(node.id);
    }

    if (node.type === 'split' && isSidebarSlotId(node.id)) {
      return createEmptySidebarContainer(node.id);
    }

    return undefined;
  }

  if (node.type === 'group') {
    return cloneNode(node);
  }

  const nextChildren: DockingThreeNode[] = [];
  let removed = false;

  for (const child of node.children) {
    const childContainsTarget = containsNodeId(child, nodeId);
    const nextChild = removeNodeByIdKeepingSidebarLanes(child, nodeId);

    if (nextChild) {
      nextChildren.push(nextChild);
      removed ||= childContainsTarget;
    } else {
      removed = true;
    }
  }

  if (!removed) {
    return {
      ...node,
      sizes: [...node.sizes],
      children: nextChildren
    };
  }

  if (nextChildren.length === 0) {
    if (isSidebarSlotId(node.id)) {
      return createEmptySidebarContainer(node.id);
    }

    if (node.id === LEFT_SIDEBAR_LANE_ID || node.id === RIGHT_SIDEBAR_LANE_ID) {
      return createEmptySidebarLane(node.id);
    }

    return undefined;
  }

  if (
    nextChildren.length === 1
    && node.id !== CENTER_COLUMN_NODE_ID
    && node.id !== LEFT_SIDEBAR_LANE_ID
    && node.id !== RIGHT_SIDEBAR_LANE_ID
    && !isSidebarSlotId(node.id)
  ) {
    return nextChildren[0]!;
  }

  return {
    ...node,
    sizes: buildBalancedSplitSizes(
      node.id,
      node.axis,
      nextChildren,
      node.children,
      node.sizes
    ),
    children: nextChildren
  };
}

function containsNodeId(node: DockingThreeNode, nodeId: string): boolean {
  if (node.id === nodeId) {
    return true;
  }

  return node.type === 'split' && node.children.some((child) => containsNodeId(child, nodeId));
}

function createEmptySidebarLane(laneId: string): DockingThreeSplitNode {
  const isLeft = laneId === LEFT_SIDEBAR_LANE_ID;
  return createSidebarLane(
    laneId,
    createEmptySidebarContainer(isLeft ? LEFT_SIDEBAR_TOP_ID : RIGHT_SIDEBAR_TOP_ID)
  );
}

function sidebarLaneIds(position: 'left' | 'right'): {
  laneId: string;
  topId: string;
  bottomId: string;
  bottomGroupId: string;
} {
  return position === 'left'
    ? {
      laneId: LEFT_SIDEBAR_LANE_ID,
      topId: LEFT_SIDEBAR_TOP_ID,
      bottomId: LEFT_SIDEBAR_BOTTOM_ID,
      bottomGroupId: LEFT_SIDEBAR_BOTTOM_GROUP_ID
    }
    : {
      laneId: RIGHT_SIDEBAR_LANE_ID,
      topId: RIGHT_SIDEBAR_TOP_ID,
      bottomId: RIGHT_SIDEBAR_BOTTOM_ID,
      bottomGroupId: RIGHT_SIDEBAR_BOTTOM_GROUP_ID
    };
}

function nodeContainsTabs(node: DockingThreeNode): boolean {
  if (node.type === 'group') {
    return node.tabs.length > 0;
  }

  return node.children.some(nodeContainsTabs);
}

function normalizeSidebarLaneChildren(
  laneId: string,
  children: readonly DockingThreeNode[]
): { children: DockingThreeNode[]; sizes: number[] } {
  const position = laneId === LEFT_SIDEBAR_LANE_ID ? 'left' : 'right';
  const { bottomId } = sidebarLaneIds(position);
  const bottomNode = children.find((child) => child.id === bottomId);

  if (!bottomNode || nodeContainsTabs(bottomNode)) {
    return {
      children: children.map(cloneNode),
      sizes: children.length === 1 ? [1] : [2, 1]
    };
  }

  return {
    children: children.filter((child) => child.id !== bottomId).map(cloneNode),
    sizes: [1]
  };
}

/** Ensure a sidebar lane has its fixed bottom container before a bottom drop. */
export function ensureSidebarBottomContainer(
  node: DockingThreeNode,
  position: 'left' | 'right'
): DockingThreeNode {
  const ids = sidebarLaneIds(position);
  const lane = findNodePathById(node, ids.laneId)?.at(-1);

  if (!lane || lane.type !== 'split' || lane.children.some((child) => child.id === ids.bottomId)) {
    return cloneNode(node);
  }

  const topNode = lane.children.find((child) => child.id === ids.topId);
  if (!topNode || topNode.type !== 'split') {
    return cloneNode(node);
  }

  const bottomNode = createSidebarContainer(
    ids.bottomId,
    createWorkbenchGroupWithTabs(ids.bottomGroupId, position === 'left' ? 'left-sidebar' : 'right-sidebar', [])
  );

  return updateSplitById(node, ids.laneId, (currentLane) => createSidebarLane(
    currentLane.id,
    topNode,
    bottomNode
  ));
}

/** Collapse an empty bottom container so the sidebar returns to one full-height panel. */
export function collapseEmptySidebarBottomContainer(
  node: DockingThreeNode,
  position: 'left' | 'right'
): DockingThreeNode {
  const ids = sidebarLaneIds(position);
  const lane = findNodePathById(node, ids.laneId)?.at(-1);

  if (!lane || lane.type !== 'split') {
    return cloneNode(node);
  }

  const normalized = normalizeSidebarLaneChildren(lane.id, lane.children);
  if (normalized.children.length === lane.children.length) {
    return cloneNode(node);
  }

  return updateSplitById(node, ids.laneId, (currentLane) => ({
    ...currentLane,
    children: normalized.children,
    sizes: normalized.sizes
  }));
}

export function splitNodeWithNewGroup(
  node: DockingThreeNode,
  targetNodeId: string,
  direction: Exclude<DockingThreeDropDirection, 'center'>,
  newGroup: DockingThreeGroupNode,
  splitId: string,
  sizeMode: DockingThreeSplitSizeMode = 'balanced'
): DockingThreeNode {
  return splitNodeWithNewNode(node, targetNodeId, direction, newGroup, splitId, sizeMode);
}

export function splitNodeWithNewNode(
  node: DockingThreeNode,
  targetNodeId: string,
  direction: Exclude<DockingThreeDropDirection, 'center'>,
  newNode: DockingThreeNode,
  splitId: string,
  sizeMode: DockingThreeSplitSizeMode = 'balanced'
): DockingThreeNode {
  const targetPath = findNodePathById(node, targetNodeId);

  if (!targetPath) {
    return cloneNode(node);
  }

  const insertionAxis = direction === 'left' || direction === 'right'
    ? 'horizontal'
    : 'vertical';
  const targetNode = targetPath[targetPath.length - 1]!;
  const parentNode = targetPath[targetPath.length - 2];

  if (parentNode?.type === 'split' && parentNode.axis === insertionAxis) {
    return updateSplitById(node, parentNode.id, (split) =>
      insertGroupIntoSplit(split, targetNode.id, direction, newNode, sizeMode)
    );
  }

  const insertBefore = direction === 'left' || direction === 'top';
  const insertedGroup = cloneNode(newNode);
  const wrappedTargetNode = cloneNode(targetNode);
  const nextChildren = insertBefore
    ? [insertedGroup, wrappedTargetNode]
    : [wrappedTargetNode, insertedGroup];
  const nextSizes = sizeMode === 'preview'
    ? insertBefore
      ? [getInsertedGroupSizeRatio(direction), 1 - getInsertedGroupSizeRatio(direction)]
      : [1 - getInsertedGroupSizeRatio(direction), getInsertedGroupSizeRatio(direction)]
    : nextChildren.map(() => 1);

  return replaceNodeById(node, targetNode.id, {
    id: splitId,
    type: 'split',
    axis: insertionAxis,
    sizes: nextSizes,
    children: nextChildren
  });
}

/** Create a child split for a specific context instead of flattening the new group into its parent split. */
export function splitNodeWithNestedGroup(
  node: DockingThreeNode,
  targetNodeId: string,
  direction: Exclude<DockingThreeDropDirection, 'center'>,
  newGroup: DockingThreeGroupNode,
  splitId: string,
  sizeMode: DockingThreeSplitSizeMode = 'balanced'
): DockingThreeNode {
  return splitNodeWithNestedNode(node, targetNodeId, direction, newGroup, splitId, sizeMode);
}

export function splitNodeWithNestedNode(
  node: DockingThreeNode,
  targetNodeId: string,
  direction: Exclude<DockingThreeDropDirection, 'center'>,
  newNode: DockingThreeNode,
  splitId: string,
  sizeMode: DockingThreeSplitSizeMode = 'balanced'
): DockingThreeNode {
  const targetNode = findNodePathById(node, targetNodeId)?.at(-1);

  if (!targetNode) {
    return cloneNode(node);
  }

  const insertBefore = direction === 'left' || direction === 'top';
  const insertedGroup = cloneNode(newNode);
  const wrappedTargetNode = cloneNode(targetNode);
  const nextChildren = insertBefore
    ? [insertedGroup, wrappedTargetNode]
    : [wrappedTargetNode, insertedGroup];
  const nextSizes = sizeMode === 'preview'
    ? insertBefore
      ? [getInsertedGroupSizeRatio(direction), 1 - getInsertedGroupSizeRatio(direction)]
      : [1 - getInsertedGroupSizeRatio(direction), getInsertedGroupSizeRatio(direction)]
    : [1, 1];

  return replaceNodeById(node, targetNodeId, {
    id: splitId,
    type: 'split',
    axis: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
    sizes: nextSizes,
    children: nextChildren
  });
}

/** Append a new group to an existing split without using one of its child groups as the docking target. */
export function appendGroupToSplit(
  node: DockingThreeNode,
  splitId: string,
  newGroup: DockingThreeGroupNode
): DockingThreeNode {
  return appendNodeToSplit(node, splitId, newGroup);
}

export function appendNodeToSplit(
  node: DockingThreeNode,
  splitId: string,
  newNode: DockingThreeNode
): DockingThreeNode {
  const split = findSplitById(node, splitId);

  if (!split) {
    return cloneNode(node);
  }

  const nextChildren = [...split.children.map(cloneNode), cloneNode(newNode)];

  return updateSplitById(node, splitId, (currentSplit) => ({
    ...currentSplit,
    sizes: buildBalancedSplitSizes(
      currentSplit.id,
      currentSplit.axis,
      nextChildren,
      currentSplit.children,
      currentSplit.sizes
    ),
    children: nextChildren
  }));
}

function insertGroupIntoSplit(
  split: DockingThreeSplitNode,
  childNodeId: string,
  direction: Exclude<DockingThreeDropDirection, 'center'>,
  newNode: DockingThreeNode,
  sizeMode: DockingThreeSplitSizeMode
): DockingThreeSplitNode {
  const childIndex = split.children.findIndex((child) => child.id === childNodeId);

  if (childIndex === -1) {
    return {
      ...split,
      sizes: [...split.sizes],
      children: split.children.map(cloneNode)
    };
  }

  const insertBefore = direction === 'left' || direction === 'top';
  const insertedGroup = cloneNode(newNode);
  const nextChildren = split.children.map(cloneNode);
  const insertIndex = insertBefore ? childIndex : childIndex + 1;
  const nextSizes = [...split.sizes];

  nextChildren.splice(insertIndex, 0, insertedGroup);

  if (sizeMode === 'preview') {
    const targetSize = nextSizes[childIndex] ?? 1;
    const insertedSize = targetSize * getInsertedGroupSizeRatio(direction);
    const remainingTargetSize = targetSize - insertedSize;

    nextSizes[childIndex] = remainingTargetSize;
    nextSizes.splice(insertIndex, 0, insertedSize);

    return {
      ...split,
      sizes: nextSizes,
      children: nextChildren
    };
  }

  return {
    ...split,
    sizes: buildBalancedSplitSizes(split.id, split.axis, nextChildren, split.children, split.sizes),
    children: nextChildren
  };
}

function replaceNodeById(
  node: DockingThreeNode,
  targetNodeId: string,
  replacementNode: DockingThreeNode
): DockingThreeNode {
  if (node.id === targetNodeId) {
    return replacementNode;
  }

  if (node.type === 'group') {
    return cloneNode(node);
  }

  return {
    ...node,
    sizes: [...node.sizes],
    children: node.children.map((child) => replaceNodeById(child, targetNodeId, replacementNode))
  };
}

function removeNodeById(
  node: DockingThreeNode,
  targetNodeId: string
): DockingThreeNode | undefined {
  if (node.type === 'group') {
    if (node.id !== targetNodeId) {
      return cloneNode(node);
    }

    if (
      node.id === LEFT_SIDEBAR_GROUP_ID
      || node.id === RIGHT_SIDEBAR_GROUP_ID
      || node.id === LEFT_SIDEBAR_BOTTOM_GROUP_ID
      || node.id === RIGHT_SIDEBAR_BOTTOM_GROUP_ID
    ) {
      return {
        ...node,
        tabs: [],
        activeTabId: ''
      };
    }

    return undefined;
  }

  const remainingChildren = node.children
    .map((child) => removeNodeById(child, targetNodeId))
    .filter((child): child is DockingThreeNode => Boolean(child));

  if (remainingChildren.length === 0) {
    if (isSidebarSlotId(node.id)) {
      return createEmptySidebarContainer(node.id);
    }

    if (node.id === LEFT_SIDEBAR_LANE_ID || node.id === RIGHT_SIDEBAR_LANE_ID) {
      return createEmptySidebarLane(node.id);
    }

    return undefined;
  }

  if (remainingChildren.length === node.children.length) {
    return {
      ...node,
      sizes: [...node.sizes],
      children: remainingChildren
    };
  }

  // Keep the root sidebar lanes as stable top-level contexts. Collapsing a
  // lane when its last child is removed loses the activity-rail ownership
  // boundary and causes the next drop to be interpreted as a sibling split.
  if (
    remainingChildren.length === 1
    && node.id !== CENTER_COLUMN_NODE_ID
    && node.id !== LEFT_SIDEBAR_LANE_ID
    && node.id !== RIGHT_SIDEBAR_LANE_ID
    && !isSidebarSlotId(node.id)
  ) {
    return remainingChildren[0]!;
  }

  return {
    ...node,
    sizes: buildBalancedSplitSizes(
      node.id,
      node.axis,
      remainingChildren,
      node.children,
      node.sizes
    ),
    children: remainingChildren
  };
}
