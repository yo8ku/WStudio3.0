/**
 * 文件说明：提供笔记属性日期与日期时间值的格式转换、分段定位和合法性校验。
 */

/** 笔记属性日期输入模式。 */
export type NotePropertyDateMode = 'date' | 'datetime';

/** 日期输入中可独立编辑的分段。 */
export type NotePropertyDateSegment = 'year' | 'month' | 'day' | 'hour' | 'minute';

/** 编辑态与展示态共用的日期分隔符。 */
export const NOTE_PROPERTY_DATE_SEPARATOR = '\u202f/\u202f';

/** 编辑态与展示态共用的日期时间间距。 */
export const NOTE_PROPERTY_DATE_TIME_GAP = '  ';

/** 固定格式内各日期分段的字符范围。 */
const DATE_SEGMENT_RANGES: Readonly<Record<NotePropertyDateSegment, { start: number; end: number }>> = {
  year: { start: 0, end: 4 },
  month: { start: 7, end: 9 },
  day: { start: 12, end: 14 },
  hour: { start: 16, end: 18 },
  minute: { start: 19, end: 21 }
};

/** 返回指定模式允许编辑的日期分段。 */
export function getDateSegments(mode: NotePropertyDateMode): readonly NotePropertyDateSegment[] {
  return mode === 'datetime'
    ? ['year', 'month', 'day', 'hour', 'minute']
    : ['year', 'month', 'day'];
}

/** 返回指定分段在固定编辑格式中的字符范围。 */
export function getDateSegmentRange(segment: NotePropertyDateSegment): { start: number; end: number } {
  return DATE_SEGMENT_RANGES[segment];
}

/** 将属性值转换为固定宽度的编辑态格式。 */
export function toEditablePropertyDate(value: string | undefined, mode: NotePropertyDateMode): string {
  const pattern = mode === 'datetime'
    ? /^(\d{4})[/-](\d{2})[/-](\d{2})(?:\s+|T)(\d{2}):(\d{2})(?::\d{2})?$/u
    : /^(\d{4})[/-](\d{2})[/-](\d{2})(?:(?:\s+|T)\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?)?$/u;
  const match = pattern.exec((value ?? '').trim());
  if (!match) return value ?? '';

  const date = [match[1], match[2], match[3]].join(NOTE_PROPERTY_DATE_SEPARATOR);
  return mode === 'datetime'
    ? `${date}${NOTE_PROPERTY_DATE_TIME_GAP}${match[4]}:${match[5]}`
    : date;
}

/** 将编辑态值转换为属性持久化格式。 */
export function toPropertyDateDraft(value: string): string {
  return value
    .replace(/T(?=\d{1,2}:\d{1,2})/u, ' ')
    .replace(/\s*\/\s*/gu, '/')
    .replace(/\s*:\s*/gu, ':')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** 将属性值转换为日期选择器使用的值，无效值回退到本地当前时间。 */
export function toPickerDateValue(value: string | undefined, mode: NotePropertyDateMode): string {
  const normalized = normalizePropertyDate(value ?? '', mode);
  if (!normalized) return createCurrentPropertyDate(mode).replace(/\//gu, '-');

  return normalized.replace(/\//gu, '-');
}

/** 将日期选择器返回值转换为属性持久化格式。 */
export function fromPickerDateValue(value: unknown, mode: NotePropertyDateMode): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatPropertyDate(value, mode);
  }
  if (typeof value !== 'string') return undefined;

  return normalizePropertyDate(value.replace(/-/gu, '/'), mode);
}

/** 返回本地当前日期或日期时间。 */
export function createCurrentPropertyDate(mode: NotePropertyDateMode): string {
  return formatPropertyDate(new Date(), mode);
}

/** 验证并规范化属性日期值。 */
export function normalizePropertyDate(value: string, mode: NotePropertyDateMode): string | undefined {
  const draft = toPropertyDateDraft(value);
  const pattern = mode === 'datetime'
    ? /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/u
    : /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+\d{1,2}(?::\d{1,2}(?::\d{1,2})?)?)?$/u;
  const match = pattern.exec(draft);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  if (hour > 23 || minute > 59) return undefined;

  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return undefined;

  return formatPropertyDate(date, mode);
}

/** 判断值是否保持固定宽度编辑结构和基础范围。 */
export function isEditablePropertyDate(value: string, mode: NotePropertyDateMode): boolean {
  const pattern = mode === 'datetime'
    ? /^(\d{4}) \/ (\d{2}) \/ (\d{2})  (\d{2}):(\d{2})$/u
    : /^(\d{4}) \/ (\d{2}) \/ (\d{2})$/u;
  const match = pattern.exec(value);
  if (!match) return false;

  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  return month >= 1 && month <= 12
    && day >= 1 && day <= 31
    && hour <= 23
    && minute <= 59;
}

/** 将 Date 格式化为属性值。 */
function formatPropertyDate(date: Date, mode: NotePropertyDateMode): string {
  const dateValue = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('/');
  if (mode === 'date') return dateValue;

  return `${dateValue} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
