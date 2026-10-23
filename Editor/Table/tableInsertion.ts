/**
 * 文件说明：负责生成指定尺寸的 Markdown 表格，并插入到 CodeMirror 当前选区。
 */
import { EditorSelection, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { EMPTY_TABLE_CELL_PLACEHOLDER } from '@editor/Table/tableConstants';
import { requestEditorTableCellFocus } from '@editor/Table/editorTableExtension';

/** 生成指定列数的 Markdown 表格行。 */
function createTableRow(columnCount: number, value: string): string {
  return `| ${Array.from({ length: columnCount }, () => value).join(' | ')} |`;
}

/** 生成包含表头在内的指定行列 Markdown 表格源码。 */
export function createMarkdownTableSource(rowCount: number, columnCount: number): string {
  const header = createTableRow(columnCount, EMPTY_TABLE_CELL_PLACEHOLDER);
  const delimiter = createTableRow(columnCount, '---');
  const dataRows = Array.from(
    { length: Math.max(0, rowCount - 1) },
    () => createTableRow(columnCount, EMPTY_TABLE_CELL_PLACEHOLDER)
  );
  return [header, delimiter, ...dataRows].join('\n');
}

/** 判断插入位置前后需要补充的块级空行。 */
function resolveTableBlockSpacing(view: EditorView, from: number, to: number): {
  readonly prefix: string;
  readonly suffix: string;
} {
  const before = view.state.sliceDoc(0, from);
  const after = view.state.sliceDoc(to);
  const prefix = from === 0 || before.endsWith('\n\n')
    ? ''
    : before.endsWith('\n') ? '\n' : '\n\n';
  const suffix = to === view.state.doc.length
    ? '\n'
    : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  return { prefix, suffix };
}

/** 在当前主选区插入表格，并请求渲染后聚焦首个表头单元格。 */
export function insertMarkdownTable(view: EditorView, rowCount: number, columnCount: number): void {
  insertMarkdownTableSource(view, createMarkdownTableSource(rowCount, columnCount));
}

/** 统一插入表格源码，补齐块间空行并在渲染后聚焦首个表头单元格。 */
export function insertMarkdownTableSource(
  view: EditorView,
  tableSource: string,
  range: { readonly from: number; readonly to: number } = view.state.selection.main,
  annotations?: TransactionSpec['annotations']
): void {
  const spacing = resolveTableBlockSpacing(view, range.from, range.to);
  const tableFrom = range.from + spacing.prefix.length;

  requestEditorTableCellFocus(view, tableFrom, 'first-cell');
  view.dispatch({
    changes: {
      from: range.from,
      to: range.to,
      insert: `${spacing.prefix}${tableSource}${spacing.suffix}`
    },
    selection: EditorSelection.cursor(tableFrom),
    annotations,
    userEvent: 'input.table'
  });
}
