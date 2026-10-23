/**
 * 文件说明：提供编辑器块级内容起始间距的通用类名构建工具。
 */

export const EDITOR_BLOCK_START_CLASS = 'cm-editor-block--start';
export const EDITOR_BLOCK_END_CLASS = 'cm-editor-block--end';
export const EDITOR_BLOCK_ROOT_CLASS = 'cm-editor-block';

/** 根据块起止状态组合唯一的编辑器块级间距类名。 */
export function createEditorBlockClassName(
  classNames: readonly string[],
  isBlockStart: boolean,
  isBlockEnd = false
): string {
  return [
    EDITOR_BLOCK_ROOT_CLASS,
    ...classNames,
    ...(isBlockStart ? [EDITOR_BLOCK_START_CLASS] : []),
    ...(isBlockEnd ? [EDITOR_BLOCK_END_CLASS] : [])
  ].join(' ');
}
