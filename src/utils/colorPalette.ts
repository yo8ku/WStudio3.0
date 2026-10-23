/**
 * 文件说明：提供项目自定义色板的预设颜色、HEX 标准化及 RGB 转换。
 */

/** RGB 颜色通道。 */
export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

/** 自定义项目颜色首次打开时使用的默认值。 */
export const DEFAULT_CUSTOM_PROJECT_COLOR = '#C084FC';

/** 自定义项目色板中按两行展示的二十种常用颜色。 */
export const CUSTOM_PROJECT_COLOR_SWATCHES: string[][] = [
  [
    '#E2855C', '#9CA459', '#58A86C', '#24A19E', '#448EC5',
    '#4670F0', '#9757E0', '#C04F9F', '#F5F5F5', '#BDBDBD'
  ],
  [
    '#8D6E63', '#A1887F', '#90A4AE', '#78909C', '#CFD8DC',
    '#FAFAFA', '#EEEEEE', '#D6D6D6', '#9E9E9E', '#616161'
  ]
];

/** 色板关闭后记录最终颜色，去重并保留最多一屏历史。 */
export function recordColorHistory(colors: readonly string[], color: string): string[] {
  const normalized = normalizeHexColor(color);
  const limit = CUSTOM_PROJECT_COLOR_SWATCHES.flat().length;
  if (!normalized || colors.includes(normalized)) return colors.slice(0, limit);
  return [normalized, ...colors].slice(0, limit);
}

/** 将颜色通道限制为 0 至 255 的整数。 */
function clampColorChannel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** 标准化 HEX，保留透明通道；完全不透明时使用六位格式以兼容已有颜色。 */
export function normalizeHexColor(value: string): string | undefined {
  const normalized = value.trim().toUpperCase();
  if (!/^#(?:[0-9A-F]{3,4}|[0-9A-F]{6}|[0-9A-F]{8})$/.test(normalized)) return undefined;
  const expanded = normalized.length <= 5
    ? `#${[...normalized.slice(1)].map(channel => channel.repeat(2)).join('')}` : normalized;
  return expanded.length === 9 && expanded.endsWith('FF') ? expanded.slice(0, 7) : expanded;
}

/** 将 HEX 颜色转换为 RGB 通道。 */
export function hexToRgbColor(value: string): RgbColor {
  const normalized = normalizeHexColor(value) ?? DEFAULT_CUSTOM_PROJECT_COLOR;
  return {
    red: Number.parseInt(normalized.slice(1, 3), 16),
    green: Number.parseInt(normalized.slice(3, 5), 16),
    blue: Number.parseInt(normalized.slice(5, 7), 16)
  };
}

/** 将 RGB 通道转换为六位大写 HEX 颜色。 */
export function rgbToHexColor(color: RgbColor): string {
  const channels = [color.red, color.green, color.blue]
    .map(channel => clampColorChannel(channel).toString(16).padStart(2, '0'));
  return `#${channels.join('').toUpperCase()}`;
}
