/**
 * 文件说明：声明 DockingThree 自定义停靠布局引擎使用的节点、标签与命中区域类型。
 */
export type DockingThreeAxis = 'horizontal' | 'vertical';
export type DockingThreeDropDirection = 'left' | 'right' | 'top' | 'bottom' | 'center';
export type DockingThreeGroupRole = 'left-sidebar' | 'editor' | 'right-sidebar' | 'bottom';
export type DockingThreeSidebarPosition = 'left' | 'right';
export type DockingThreeSidebarDockTarget = 'activity-rail' | 'context';
export type DockingThreeTabKind = 'editor' | 'media' | 'welcome' | 'placeholder' | 'plugin' | 'host-panel' | 'settings';

export interface DockingThreeTab {
  id: string;
  title: string;
  kind: DockingThreeTabKind;
  label: string;
  closable: boolean;
  initialValue?: string;
  filePath?: string;
  /** 仓库根目录相对路径，用于文件列表定位。 */
  relativePath?: string;
  /** 外部文件打开请求创建的临时标签，不参与工作区文件保存。 */
  temporary?: boolean;
  mediaMimeType?: string;
  pluginId?: string;
  viewType?: string;
  viewCapabilities?: readonly string[];
  /** Plugin-provided icon URLs remain external resources and are rendered as images. */
  viewIconUrl?: string;
  viewInstanceId?: string;
  viewInitialUrl?: string;
  /** 原生网页图标，缺失或加载失败时使用插件声明图标。 */
  webViewerFaviconUrl?: string;
  /** Host-owned dockable panel identity and icon metadata. */
  hostPanelId?: string;
  hostPanelIconUrl?: string;
  hostPanelIconClass?: string;
  settingsNavigationId?: string;
  /** Side-panel plugins keep their original docking target so rail entries do not represent context tabs. */
  sidebarDockTarget?: DockingThreeSidebarDockTarget;
}

export interface DockingThreeGroupNode {
  id: string;
  type: 'group';
  role: DockingThreeGroupRole;
  header: 'hidden' | 'tabs';
  tabs: DockingThreeTab[];
  activeTabId: string;
  docked?: boolean;
  previewGhost?: boolean;
}

export interface DockingThreeSplitNode {
  id: string;
  type: 'split';
  axis: DockingThreeAxis;
  children: DockingThreeNode[];
  sizes: number[];
}

export type DockingThreeNode = DockingThreeGroupNode | DockingThreeSplitNode;

export interface DockingThreeDropTarget {
  groupId: string;
  targetNodeId: string;
  direction: DockingThreeDropDirection;
  insertionIndex?: number;
  activityRail?: DockingThreeActivityRailPreview;
  /** A lower fixed sidebar container that is created only when this target is committed. */
  sidebarBottom?: DockingThreeSidebarPosition;
}

export interface DockingThreeGroupBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DockingThreeIndicatorBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockingThreeActivityRailBounds {
  position: DockingThreeSidebarPosition;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  itemBounds: DockingThreeIndicatorBounds[];
}

export interface DockingThreeActivityRailPreview {
  position: DockingThreeSidebarPosition;
  insertionIndex: number;
}

export interface DockingThreeSidebarPanelDefinition {
  id: string;
  title: string;
  label: string;
  iconUrl?: string;
  iconClass?: string;
  action?: DockingThreeRailAction;
}

export type DockingThreeRailAction = 'open-settings';

export interface DockingThreeIconRailSection {
  id: string;
  tabs: readonly DockingThreeSidebarPanelDefinition[];
}
