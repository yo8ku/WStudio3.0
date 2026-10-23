/**
 * 文件说明：定义主编辑器与内嵌编辑器共用的 CodeMirror 文本选区主题。
 */
import { EditorView } from '@codemirror/view';

/** 使用工作台主题变量统一编辑器在聚焦与失焦时的实际文本选区背景。 */
export const editorSelectionTheme = EditorView.theme({
  '&.cm-editor:not(.cm-editor-inline-chat-context-active) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'transparent !important'
  },
  '&.cm-editor.cm-editor-inline-chat-context-active > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--workbench-editor-selection) !important'
  },
  '&.cm-editor.cm-editor-inline-chat-context-active.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--workbench-editor-selection) !important'
  },
  '&.cm-editor .cm-line::selection, &.cm-editor .cm-line *::selection': {
    backgroundColor: 'var(--workbench-editor-selection) !important'
  }
});
