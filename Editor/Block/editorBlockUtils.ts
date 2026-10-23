/**
 * 文件说明：提供块级 Widget 的视觉状态解析与 DOM 状态同步工具。
 */
import type { EditorBlockVisualState } from '@editor/Block/editorBlockTypes';
import { EDITOR_BLOCK_ROOT_CLASS } from '@editor/Block/editorBlockSpacing';

/** 所有块级右上角操作栏共用的稳定类名。 */
export const EDITOR_BLOCK_ACTIONS_CLASS = 'cm-editor-block__actions';

/** 创建统一承载块级右上角图标按钮的操作栏。 */
export function createEditorBlockActionsElement(): HTMLDivElement {
  const actions = document.createElement('div');
  actions.className = EDITOR_BLOCK_ACTIONS_CLASS;
  return actions;
}

/**
 * 根据块的选择与编辑状态解析唯一视觉状态。
 */
export function resolveEditorBlockVisualState(
  selected: boolean,
  editing: boolean
): EditorBlockVisualState {
  if (editing) {
    return 'editing';
  }

  return selected ? 'selected' : 'default';
}

/**
 * 将块的通用视觉状态同步到根 DOM 数据属性。
 */
export function applyEditorBlockVisualState(
  dom: HTMLElement,
  selected: boolean,
  editing: boolean
): void {
  dom.classList.add(EDITOR_BLOCK_ROOT_CLASS);
  dom.dataset.editorBlockState = resolveEditorBlockVisualState(selected, editing);
}
