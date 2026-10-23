/**
 * 文件说明：封装块级源码替换装饰、选区命中与文档位置跟踪等通用状态逻辑。
 */
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type WidgetType } from '@codemirror/view';

import type { EditorBlockSourceRange } from '@editor/Block/editorBlockTypes';

/**
 * 创建覆盖完整源码行的官方块级替换装饰。
 */
export function createEditorBlockDecoration(
  state: EditorState,
  sourceRange: EditorBlockSourceRange,
  widget: WidgetType
): Range<Decoration> {
  const sourceLine = state.doc.lineAt(sourceRange.from);
  const replacementTo = sourceLine.to < state.doc.length
    ? sourceLine.to + 1
    : sourceLine.to;

  return Decoration.replace({
    widget,
    block: true,
    inclusiveStart: true,
    inclusiveEnd: false
  }).range(sourceLine.from, replacementTo);
}

/**
 * 创建覆盖完整多行源码范围的官方块级替换装饰。
 */
export function createEditorMultiLineBlockDecoration(
  sourceRange: EditorBlockSourceRange,
  widget: WidgetType
): Range<Decoration> {
  return Decoration.replace({
    widget,
    block: true,
    inclusiveStart: true,
    inclusiveEnd: false
  }).range(sourceRange.from, sourceRange.to);
}

/** 将已渲染单行块的行首位置转换为统一源码范围。 */
export function resolveRenderedEditorBlockLineRanges(
  state: EditorState,
  renderedLineFroms: readonly number[]
): readonly EditorBlockSourceRange[] {
  return renderedLineFroms.map((lineFrom) => {
    const line = state.doc.lineAt(lineFrom);
    return { from: line.from, to: line.to };
  });
}

/**
 * 判断当前选区是否接触指定块源码范围。
 */
export function doesSelectionTouchEditorBlock(
  state: EditorState,
  sourceRange: EditorBlockSourceRange
): boolean {
  return state.selection.ranges.some((selectionRange) => (
    selectionRange.from <= sourceRange.to
    && selectionRange.to >= sourceRange.from
  ));
}

/**
 * 校验被跟踪的块行是否仍与当前选区相交。
 */
export function resolveTrackedEditorBlockLineFrom(
  state: EditorState,
  trackedPosition: number
): number | null {
  if (trackedPosition < 0 || trackedPosition > state.doc.length) {
    return null;
  }

  const line = state.doc.lineAt(trackedPosition);

  return state.selection.ranges.some((selectionRange) => (
    selectionRange.from <= line.to
    && selectionRange.to >= line.from
  ))
    ? line.from
    : null;
}
