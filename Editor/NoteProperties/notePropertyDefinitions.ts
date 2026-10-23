/**
 * 文件说明：集中声明编辑器笔记属性菜单支持的基础属性，避免视图内硬编码选项。
 */

/** 笔记属性键；基础属性之外也允许用户使用自定义名称。 */
export type NotePropertyKey = string;

/** 笔记属性菜单和属性行使用的稳定展示定义。 */
export interface NotePropertyDefinition {
  readonly key: NotePropertyKey;
  readonly label: string;
}

/** 默认笔记属性按菜单展示顺序统一声明。 */
export const NOTE_PROPERTY_DEFINITIONS: readonly NotePropertyDefinition[] = [
  { key: 'aliases', label: 'aliases' },
  { key: 'cssclasses', label: 'cssclasses' },
  { key: 'tags', label: 'tags' }
] as const;

/** 规范化用户输入的属性名称。 */
export function normalizeNotePropertyName(value: string): string {
  return value.trim();
}

/** 校验属性名称，拒绝空名称、换行和对象原型保留名称。 */
export function isValidNotePropertyName(value: string): boolean {
  const normalizedValue = normalizeNotePropertyName(value);
  return Boolean(normalizedValue)
    && !/[\r\n]/u.test(normalizedValue)
    && !['__proto__', 'constructor', 'prototype'].includes(normalizedValue);
}
