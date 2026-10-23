/**
 * 文件说明：提供从块下一行行首恢复并进入上方块源码的共享 CodeMirror 导航扩展。
 */
import { type EditorState, type Extension, Prec } from '@codemirror/state';
import { type Command, type EditorView, keymap } from '@codemirror/view';

import type { EditorBlockSourceRange } from '@editor/Block/editorBlockTypes';

/** 块扩展恢复源码时需要执行的编辑态切换。 */
export type RevealEditorBlockSource = (
  view: EditorView,
  sourceRange: EditorBlockSourceRange
) => void;

/** 查找紧邻当前行上方的已渲染块源码范围。 */
function resolvePreviousEditorBlockSource(
  state: EditorState,
  sourceRanges: readonly EditorBlockSourceRange[]
): EditorBlockSourceRange | null {
  const selection = state.selection;

  if (selection.ranges.length !== 1 || !selection.main.empty) {
    return null;
  }

  const currentLine = state.doc.lineAt(selection.main.head);

  if (selection.main.head !== currentLine.from || currentLine.number === 1) {
    return null;
  }

  const previousLineNumber = currentLine.number - 1;

  return sourceRanges.find((sourceRange) => (
    state.doc.lineAt(sourceRange.to).number === previousLineNumber
  )) ?? null;
}

/** 查找当前编辑块之前紧邻的已渲染块源码范围。 */
function resolveSourceBeforeCurrentBlock(
  state: EditorState,
  currentSourceRange: EditorBlockSourceRange,
  sourceRanges: readonly EditorBlockSourceRange[]
): EditorBlockSourceRange | null {
  const previousLineNumber = state.doc.lineAt(currentSourceRange.from).number - 1;

  return sourceRanges.find((sourceRange) => (
    sourceRange !== currentSourceRange
    && state.doc.lineAt(sourceRange.to).number === previousLineNumber
  )) ?? null;
}

/** 执行块源码恢复并消费当前键盘命令。 */
function revealEditorBlockSource(
  view: EditorView,
  sourceRange: EditorBlockSourceRange | null,
  revealSource: RevealEditorBlockSource
): boolean {
  if (sourceRange === null) {
    return false;
  }

  revealSource(view, sourceRange);
  view.focus();
  return true;
}

/** 创建从块下一行退格进入紧邻上方块源码的命令。 */
function createRevealPreviousEditorBlockOnBackspaceCommand(
  resolveSourceRanges: (state: EditorState) => readonly EditorBlockSourceRange[],
  revealSource: RevealEditorBlockSource
): Command {
  return (view) => {
    return revealEditorBlockSource(
      view,
      resolvePreviousEditorBlockSource(view.state, resolveSourceRanges(view.state)),
      revealSource
    );
  };
}

/** 创建优先在当前源码视觉行内移动、越界后进入上一块源码的向上导航命令。 */
function createRevealPreviousEditorBlockOnArrowUpCommand(
  resolveSourceRanges: (state: EditorState) => readonly EditorBlockSourceRange[],
  revealSource: RevealEditorBlockSource
): Command {
  return (view) => {
    const sourceRanges = resolveSourceRanges(view.state);
    const selection = view.state.selection;

    if (selection.ranges.length !== 1 || !selection.main.empty) {
      return false;
    }

    const currentSourceRange = sourceRanges.find((sourceRange) => (
      sourceRange.from <= selection.main.head
      && selection.main.head <= sourceRange.to
    ));

    if (currentSourceRange === undefined) {
      return revealEditorBlockSource(
        view,
        resolvePreviousEditorBlockSource(view.state, sourceRanges),
        revealSource
      );
    }

    const nativeTarget = view.moveVertically(selection.main, false);

    if (
      currentSourceRange.from <= nativeTarget.head
      && nativeTarget.head <= currentSourceRange.to
    ) {
      return false;
    }

    return revealEditorBlockSource(
      view,
      resolveSourceBeforeCurrentBlock(view.state, currentSourceRange, sourceRanges),
      revealSource
    );
  };
}

/** 创建高优先级块导航扩展，统一保护退格并修正向上进入块的目标。 */
export function createEditorBlockNavigationExtension(
  resolveSourceRanges: (state: EditorState) => readonly EditorBlockSourceRange[],
  revealSource: RevealEditorBlockSource
): Extension {
  const revealPreviousSourceOnArrowUp = createRevealPreviousEditorBlockOnArrowUpCommand(
    resolveSourceRanges,
    revealSource
  );
  const revealPreviousSourceOnBackspace = createRevealPreviousEditorBlockOnBackspaceCommand(
    resolveSourceRanges,
    revealSource
  );

  return Prec.highest(keymap.of([
    { key: 'ArrowUp', run: revealPreviousSourceOnArrowUp },
    { key: 'Backspace', run: revealPreviousSourceOnBackspace }
  ]));
}
