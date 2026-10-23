/** Defines the structured entries accepted by the shared workbench menu component. */
export interface WsMenuDividerItem {
  readonly type: 'separator';
  readonly id: string;
}

export interface WsMenuActionItem {
  readonly type: 'action';
  readonly id: string;
  readonly label: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly children?: readonly WsMenuActionItem[];
}

export type WsMenuItem = WsMenuDividerItem | WsMenuActionItem;
