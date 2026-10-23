/**
 * 文件说明：确保文档末尾的图片、视频等块级 Widget 后始终保留一条真实可编辑空行。
 */
import { EditorSelection, type EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

interface EditorBlockTrailingLineState {
  readonly renderedLineFroms: readonly number[];
}

/**
 * 创建块级 Widget 尾部空行扩展，让 CodeMirror 原生活动行与光标装饰能够正常挂载。
 */
export function createEditorBlockTrailingLineExtension(
  resolveBlockState: (state: EditorState) => EditorBlockTrailingLineState
) {
  let pendingDocumentLength: number | null = null;

  return EditorView.updateListener.of((update) => {
    const state = update.state;
    const documentLength = state.doc.length;
    const renderedLineFroms = resolveBlockState(state).renderedLineFroms;
    const lastRenderedLineFrom = renderedLineFroms.length > 0
      ? renderedLineFroms[renderedLineFroms.length - 1]
      : undefined;

    if (
      lastRenderedLineFrom === undefined
      || state.doc.lineAt(lastRenderedLineFrom).number !== state.doc.lines
      || pendingDocumentLength === documentLength
    ) {
      return;
    }

    pendingDocumentLength = documentLength;
    queueMicrotask(() => {
      if (update.view.state.doc.length !== documentLength) {
        pendingDocumentLength = null;
        return;
      }

      const moveSelectionToTrailingLine = update.view.state.selection.main.head === documentLength;

      update.view.dispatch({
        changes: {
          from: documentLength,
          insert: '\n'
        },
        selection: moveSelectionToTrailingLine
          ? EditorSelection.cursor(documentLength + 1)
          : undefined,
        userEvent: 'input'
      });
      pendingDocumentLength = null;
    });
  });
}
