/**
 * 文件说明：定义 Markdown 表格右键菜单及行列二级菜单项。
 */

export type TableContextMenuActionId =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'move-row-up'
  | 'move-row-down'
  | 'copy-row'
  | 'delete-row'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'move-column-left'
  | 'move-column-right'
  | 'align-top'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'copy-column'
  | 'delete-column'
  | 'sort-ascending'
  | 'sort-descending';

export interface TableContextMenuDivider {
  readonly kind: 'divider';
  readonly id: string;
}

export interface TableContextMenuAction {
  readonly kind: 'item';
  readonly id: string;
  readonly label: string;
  readonly actionId: TableContextMenuActionId;
}

export interface TableContextMenuSubmenu {
  readonly kind: 'submenu';
  readonly id: string;
  readonly label: string;
  readonly children: readonly (TableContextMenuAction | TableContextMenuDivider)[];
}

/** 复用项目颜色选择器，作用范围由行列手柄决定。 */
export interface TableContextMenuHighlight {
  readonly kind: 'highlight';
  readonly id: string;
  readonly label: string;
}

export type TableContextMenuEntry =
  | TableContextMenuDivider
  | TableContextMenuAction
  | TableContextMenuSubmenu
  | TableContextMenuHighlight;

/** 行操作按移动、新增、复制、删除分组，供手柄菜单和单元格子菜单复用。 */
const rowMenuItems: readonly (TableContextMenuAction | TableContextMenuDivider)[] = [
  { kind: 'item', id: 'move-row-up', label: '向上移动行', actionId: 'move-row-up' },
  { kind: 'item', id: 'move-row-down', label: '向下移动行', actionId: 'move-row-down' },
  { kind: 'divider', id: 'divider-row-move' },
  { kind: 'item', id: 'insert-row-above', label: '上方新增行', actionId: 'insert-row-above' },
  { kind: 'item', id: 'insert-row-below', label: '下方新增行', actionId: 'insert-row-below' },
  { kind: 'divider', id: 'divider-row-insert' },
  { kind: 'item', id: 'copy-row', label: '复制行', actionId: 'copy-row' },
  { kind: 'divider', id: 'divider-row-copy' },
  { kind: 'item', id: 'delete-row', label: '删除行', actionId: 'delete-row' }
];

/** 单元格菜单的行操作入口。 */
const rowSubmenu: TableContextMenuSubmenu = {
  kind: 'submenu',
  id: 'row',
  label: '行',
  children: rowMenuItems
};

/** 列手柄专属操作。 */
const columnSubmenu: TableContextMenuSubmenu = {
  kind: 'submenu',
  id: 'column',
  label: '列',
  children: [
    { kind: 'item', id: 'insert-column-left', label: '左侧新增列', actionId: 'insert-column-left' },
    { kind: 'item', id: 'insert-column-right', label: '右侧新增列', actionId: 'insert-column-right' },
    { kind: 'divider', id: 'divider-column-insert' },
    { kind: 'item', id: 'move-column-left', label: '向左移动列', actionId: 'move-column-left' },
    { kind: 'item', id: 'move-column-right', label: '向右移动列', actionId: 'move-column-right' },
    { kind: 'divider', id: 'divider-column-move' },
    { kind: 'item', id: 'align-top', label: '顶部对齐', actionId: 'align-top' },
    { kind: 'item', id: 'align-left', label: '左对齐', actionId: 'align-left' },
    { kind: 'item', id: 'align-center', label: '居中对齐', actionId: 'align-center' },
    { kind: 'item', id: 'align-right', label: '右对齐', actionId: 'align-right' },
    { kind: 'divider', id: 'divider-column-align' },
    { kind: 'item', id: 'copy-column', label: '复制列', actionId: 'copy-column' },
    { kind: 'item', id: 'delete-column', label: '删除列', actionId: 'delete-column' }
  ]
};

/** 列菜单及单元格菜单共用的高亮与排序操作。 */
const sharedTableMenuItems: readonly TableContextMenuEntry[] = [
  { kind: 'highlight', id: 'column-highlight', label: '高亮' },
  { kind: 'divider', id: 'divider-sort' },
  { kind: 'item', id: 'sort-ascending', label: '按列升序（A-Z）', actionId: 'sort-ascending' },
  { kind: 'item', id: 'sort-descending', label: '按列降序（Z-A）', actionId: 'sort-descending' }
];

/** 行手柄直接提供整行操作，不包含列操作和排序。 */
export const tableRowContextMenuItems: readonly TableContextMenuEntry[] = [
  { kind: 'highlight', id: 'row-highlight', label: '高亮' },
  { kind: 'divider', id: 'divider-row-highlight' },
  ...rowMenuItems
];

/** 列手柄菜单的配置中不包含行操作。 */
export const tableColumnContextMenuItems: readonly TableContextMenuEntry[] = [columnSubmenu, ...sharedTableMenuItems];

/** 正文单元格基础菜单保留行列操作入口。 */
export const tableCellContextMenuItems: readonly TableContextMenuEntry[] = [rowSubmenu, columnSubmenu, ...sharedTableMenuItems];
