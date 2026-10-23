import type {
  DockingThreeIconRailSection,
  DockingThreeSidebarPanelDefinition,
  DockingThreeSidebarPosition
} from '@/DockingThree/types';
export const LEFT_SIDEBAR_GROUP_ID = 'left-sidebar-group';
export const RIGHT_SIDEBAR_GROUP_ID = 'right-sidebar-group';
export const LEFT_SIDEBAR_LANE_ID = 'left-sidebar-lane';
export const RIGHT_SIDEBAR_LANE_ID = 'right-sidebar-lane';
export const LEFT_SIDEBAR_TOP_ID = 'left-sidebar-top';
export const LEFT_SIDEBAR_BOTTOM_ID = 'left-sidebar-bottom';
export const RIGHT_SIDEBAR_TOP_ID = 'right-sidebar-top';
export const RIGHT_SIDEBAR_BOTTOM_ID = 'right-sidebar-bottom';
export const LEFT_SIDEBAR_BOTTOM_GROUP_ID = 'left-sidebar-bottom-group';
export const RIGHT_SIDEBAR_BOTTOM_GROUP_ID = 'right-sidebar-bottom-group';
export const CENTER_COLUMN_NODE_ID = 'dock-split-center';
export const DEFAULT_EDITOR_GROUP_ID = 'editor-group-1';
export const DEFAULT_LEFT_SIDEBAR_PANEL_ID = 'left-sidebar-panel';
export const DEFAULT_RIGHT_SIDEBAR_PANEL_ID = 'right-sidebar-tags';

/** 左侧边栏不再预置占位面板，真实插件视图会在运行时动态加入。 */
export const leftSidebarPanels: readonly DockingThreeSidebarPanelDefinition[] = [];

/** 右侧边栏不再预置“上下文”和“历史”占位标签，真实插件视图运行时加入。 */
export const rightSidebarPanels: readonly DockingThreeSidebarPanelDefinition[] = [
  {
    id: 'right-sidebar-tags',
    title: '标签',
    label: '标签',
    iconClass: 'icon icon-tags'
  }
];

export const rightSidebarRailSections: readonly DockingThreeIconRailSection[] = [
  {
    id: 'right-rail',
    tabs: rightSidebarPanels
  }
] as const;

export function getSidebarPanelDefinition(
  position: DockingThreeSidebarPosition,
  panelId: string
): DockingThreeSidebarPanelDefinition | undefined {
  const panels = position === 'left' ? leftSidebarPanels : rightSidebarPanels;

  return panels.find((panel) => panel.id === panelId);
}
