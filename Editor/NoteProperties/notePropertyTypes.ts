/**
 * 文件说明：集中声明笔记属性支持的值类型、菜单文案与基础属性默认类型。
 */
import type { NotePropertyKey } from './notePropertyDefinitions.ts';
import { createCurrentPropertyDate } from './notePropertyDateTime.ts';

/** 笔记属性编辑器支持的稳定值类型。 */
export type NotePropertyType =
  | 'alias'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'list'
  | 'number'
  | 'text';

/** 属性类型菜单使用的展示定义。 */
export interface NotePropertyTypeDefinition {
  readonly label: string;
  readonly value: NotePropertyType;
}

/** 属性类型二级菜单的固定展示顺序。 */
export const NOTE_PROPERTY_TYPE_DEFINITIONS: readonly NotePropertyTypeDefinition[] = [
  { value: 'checkbox', label: '复选框' },
  { value: 'date', label: '日期' },
  { value: 'datetime', label: '日期 & 时间' },
  { value: 'list', label: '列表' },
  { value: 'number', label: '数字' },
  { value: 'text', label: '文本' }
] as const;

/** 当前会话中基础属性首次出现时使用的默认类型。 */
export const DEFAULT_NOTE_PROPERTY_TYPES: Readonly<Partial<Record<NotePropertyKey, NotePropertyType>>> = {
  aliases: 'list',
  cssclasses: 'list',
  tags: 'list'
};

const NOTE_PROPERTY_NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/** 判断未知值是否为受支持的属性类型。 */
export function isNotePropertyType(value: unknown): value is NotePropertyType {
  return value === 'alias'
    || NOTE_PROPERTY_TYPE_DEFINITIONS.some(definition => definition.value === value);
}

/** 过滤数字属性输入，只保留一个前置符号、小数点和数字。 */
export function sanitizeNotePropertyNumberInput(value: string): string {
  let sanitizedValue = '';
  let hasDecimalPoint = false;

  for (const character of value) {
    if (/\d/u.test(character)) {
      sanitizedValue += character;
      continue;
    }

    if ((character === '+' || character === '-') && sanitizedValue.length === 0) {
      sanitizedValue = character;
      continue;
    }

    if (character === '.' && !hasDecimalPoint) {
      sanitizedValue += character;
      hasDecimalPoint = true;
    }
  }

  return sanitizedValue;
}

/** 校验并规范化可提交的数字属性值。 */
export function normalizeNotePropertyNumber(value: string): string | undefined {
  const normalizedValue = value.trim();
  if (!NOTE_PROPERTY_NUMBER_PATTERN.test(normalizedValue)) {
    return undefined;
  }

  // 全程保留字符串，避免超长整数丢失精度或被改写为科学计数法。
  const sign = normalizedValue.startsWith('-') ? '-' : '';
  const unsignedValue = normalizedValue.replace(/^[+-]/u, '');
  const [integerPart, fractionPart] = unsignedValue.split('.');
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/u, '') || '0';
  const normalizedFraction = fractionPart?.replace(/0+$/u, '');

  if (!normalizedFraction) {
    return `${sign}${normalizedInteger}`;
  }

  return `${sign}${normalizedInteger}.${normalizedFraction}`;
}

/** 将属性现有值转换为目标类型的初始数据。 */
export function convertNotePropertyValues(
  type: NotePropertyType,
  values: readonly string[]
): readonly string[] {
  if (type === 'list' || type === 'number') {
    return [];
  }

  if (type === 'text') {
    return values.length > 0 ? [values.join('\n')] : [];
  }

  if (type === 'date') {
    const today = createCurrentPropertyDate('date');
    return values.length > 0 ? values.map(() => today) : [today];
  }

  if (type === 'datetime') {
    const now = createCurrentPropertyDate('datetime');
    return values.length > 0 ? values.map(() => now) : [now];
  }

  return values;
}
