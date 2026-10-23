/**
 * 文件说明：定义图片块右键菜单的静态展示项，暂不绑定具体操作。
 */

export interface ImageBlockContextMenuDivider {
  readonly kind: 'divider';
  readonly id: string;
}

export interface ImageBlockContextMenuItem {
  readonly kind: 'item';
  readonly id: string;
  readonly label: string;
}

export type ImageBlockContextMenuEntry =
  | ImageBlockContextMenuDivider
  | ImageBlockContextMenuItem;

/** 图片块右键菜单展示项。 */
export const imageBlockContextMenuItems: readonly ImageBlockContextMenuEntry[] = [
  { kind: 'item', id: 'copy-image', label: '复制图片' },
  { kind: 'item', id: 'replace-image', label: '替换图片' },
  { kind: 'divider', id: 'divider-copy' },
  { kind: 'item', id: 'open-new-tab', label: '在新标签页中打开' },
  { kind: 'item', id: 'open-new-group', label: '在新标签组中打开' },
  { kind: 'item', id: 'open-new-window', label: '在新窗口中打开' },
  { kind: 'divider', id: 'divider-open' },
  { kind: 'item', id: 'rename-image', label: '重命名' },
  { kind: 'item', id: 'move-image', label: '移动文件到...' },
  { kind: 'item', id: 'favorite-image', label: '收藏' },
  { kind: 'item', id: 'copy-image-path', label: '复制路径' },
  { kind: 'divider', id: 'divider-file' },
  { kind: 'item', id: 'open-with-default-app', label: '默认应用打开' },
  { kind: 'item', id: 'show-in-explorer', label: '在系统资源管理器中打开' },
  { kind: 'item', id: 'show-current-file', label: '在文件列表中显示' },
  { kind: 'divider', id: 'divider-delete' },
  { kind: 'item', id: 'delete-image', label: '删除图片' }
];
