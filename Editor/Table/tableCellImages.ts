/** 文件说明：定义单元格图片菜单与附件元数据，独立保存图片、旋转、尺寸和布局。 */
import type { ImageBlockContextMenuEntry, ImageBlockContextMenuItem } from '../ImageBlock/imageBlockContextMenu';

export const TABLE_CELL_IMAGE_DEFAULT_SIZE = 30;
export const TABLE_CELL_IMAGE_MAX_SIZE = 200;

export interface TableCellImageLayout {
  readonly alignment: 'top' | 'bottom' | 'left' | 'right' | 'center';
  readonly position: 'left' | 'top' | 'right' | 'bottom';
}

interface TableCellImageLayoutOption extends ImageBlockContextMenuItem {
  readonly layout: Partial<TableCellImageLayout>;
}

interface TableCellImageLayoutSubmenu {
  readonly kind: 'submenu';
  readonly id: string;
  readonly label: string;
  readonly children: readonly TableCellImageLayoutOption[];
}

const horizontalImageAlignmentItems: readonly TableCellImageLayoutOption[] = [
  { kind: 'item', id: 'image-align-left', label: '左对齐', layout: { alignment: 'left' } },
  { kind: 'item', id: 'image-align-right', label: '右对齐', layout: { alignment: 'right' } },
  { kind: 'item', id: 'image-align-center', label: '居中对齐', layout: { alignment: 'center' } }
];

/** 随 Markdown 单元格保存的图片附件。 */
export interface TableCellImage {
  readonly source: string;
  readonly title: string;
  readonly rotation?: number;
  readonly width?: number;
  readonly height?: number;
  readonly alignment?: TableCellImageLayout['alignment'];
  readonly position?: TableCellImageLayout['position'];
}

/** 单元格图片专属菜单；分割线区分图片变换与文件操作。 */
export const tableCellImageContextMenuItems: readonly (ImageBlockContextMenuEntry | TableCellImageLayoutSubmenu)[] = [
  { kind: 'item', id: 'preview-image', label: '预览' },
  { kind: 'item', id: 'rotate-counterclockwise', label: '逆时针旋转' },
  { kind: 'item', id: 'rotate-clockwise', label: '顺时针旋转' },
  { kind: 'divider', id: 'divider-image-size' },
  { kind: 'item', id: 'image-size', label: '尺寸' },
  { kind: 'submenu', id: 'image-alignment', label: '对齐方式', children: [
    { kind: 'item', id: 'image-align-top', label: '顶部对齐', layout: { alignment: 'top' } },
    { kind: 'item', id: 'image-align-bottom', label: '底部对齐', layout: { alignment: 'bottom' } },
    { kind: 'item', id: 'image-align-center', label: '居中对齐', layout: { alignment: 'center' } }
  ] },
  { kind: 'submenu', id: 'image-position', label: '移动到', children: [
    { kind: 'item', id: 'image-position-left', label: '左', layout: { position: 'left' } },
    { kind: 'item', id: 'image-position-top', label: '上', layout: { position: 'top' } },
    { kind: 'item', id: 'image-position-right', label: '右', layout: { position: 'right' } },
    { kind: 'item', id: 'image-position-bottom', label: '下', layout: { position: 'bottom' } }
  ] },
  { kind: 'divider', id: 'divider-image-replace' },
  { kind: 'item', id: 'replace-image', label: '替换图片' },
  { kind: 'divider', id: 'divider-image-transform' },
  { kind: 'item', id: 'open-with-default-app', label: '默认应用打开' },
  { kind: 'item', id: 'show-in-explorer', label: '在资源管理器中打开' },
  { kind: 'item', id: 'delete-image', label: '删除图片' }
];

/** 图片在上下方时使用横向对齐菜单，左右两侧使用纵向对齐菜单。 */
export function getTableCellImageContextMenuItems(position: TableCellImageLayout['position'] = 'left') {
  if (position !== 'top' && position !== 'bottom') return tableCellImageContextMenuItems;
  return tableCellImageContextMenuItems.map(item => item.kind === 'submenu' && item.id === 'image-alignment'
    ? { ...item, children: horizontalImageAlignmentItems } : item);
}

/** 按位置统一对齐轴；切换轴时起点、终点、居中的含义保持一致，并兼容旧附件。 */
export function resolveTableCellImageLayout(image: Pick<TableCellImage, 'position' | 'alignment'>): TableCellImageLayout {
  const position = image.position === 'top' || image.position === 'right' || image.position === 'bottom'
    ? image.position : 'left';
  const horizontal = position === 'top' || position === 'bottom';
  const alignment = image.alignment === 'top' || image.alignment === 'left' ? (horizontal ? 'left' : 'top')
    : image.alignment === 'bottom' || image.alignment === 'right' ? (horizontal ? 'right' : 'bottom') : 'center';
  return { position, alignment };
}

/** 从菜单声明取得布局变更，避免菜单、勾选状态和操作处理分别维护映射。 */
export function resolveTableCellImageLayoutAction(action: string): Partial<TableCellImageLayout> | undefined {
  return [...horizontalImageAlignmentItems,
    ...tableCellImageContextMenuItems.flatMap(item => item.kind === 'submenu' ? item.children : [])]
    .find(item => item.id === action)?.layout;
}

/** 尺寸编辑仅接受上限以内的有限正数。 */
export function isTableCellImageDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    && value <= TABLE_CELL_IMAGE_MAX_SIZE;
}

/** 旧附件采用默认尺寸，历史超大尺寸按单元格上限收敛。 */
export function resolveTableCellImageSize(image: Pick<TableCellImage, 'width' | 'height'>): { width: number; height: number } {
  const normalize = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, TABLE_CELL_IMAGE_MAX_SIZE) : TABLE_CELL_IMAGE_DEFAULT_SIZE;
  return { width: normalize(image.width), height: normalize(image.height) };
}

const TABLE_CELL_IMAGES_SUFFIX = /<!--wstudio-table-images:([^\r\n]*?)-->$/;

/** 从单元格的内部附件数据中恢复图片，忽略损坏或缺少路径的数据。 */
export function readTableCellImages(value: string): TableCellImage[] {
  const encoded = TABLE_CELL_IMAGES_SUFFIX.exec(value)?.[1];
  if (!encoded) return [];
  try {
    const images: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!Array.isArray(images)) return [];
    return images.filter((image: unknown): image is TableCellImage => (
      typeof image === 'object' && image !== null
      && 'source' in image && typeof image.source === 'string'
      && image.source.trim().length > 0 && image.source !== 'undefined'
      && 'title' in image && typeof image.title === 'string'
    )).map(image => ({
      source: image.source,
      title: image.title,
      ...resolveTableCellImageLayout(image),
      ...(typeof image.rotation === 'number' && Number.isFinite(image.rotation) && image.rotation % 90 === 0
        ? { rotation: ((image.rotation % 360) + 360) % 360 } : {}),
      ...resolveTableCellImageSize(image)
    }));
  } catch {
    return [];
  }
}

/** 文字编辑只读取正文，不暴露图片附件存储格式。 */
export function stripTableCellImages(value: string): string {
  return value.replace(TABLE_CELL_IMAGES_SUFFIX, '');
}

/** 将图片附件保存为单元格内部元数据，编码后不会干扰表格管道和换行。 */
export function writeTableCellImages(value: string, images: readonly TableCellImage[]): string {
  const text = stripTableCellImages(value);
  return images.length === 0 ? text
    : `${text}<!--wstudio-table-images:${encodeURIComponent(JSON.stringify(images))}-->`;
}
