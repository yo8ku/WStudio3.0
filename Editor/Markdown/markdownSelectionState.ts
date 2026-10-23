/** 文件说明：提供 Markdown 行源码装饰共用的选区行判定。 */

interface MarkdownSelectionRange {
  readonly empty: boolean;
  readonly from: number;
  readonly to: number;
  readonly head: number;
}

interface MarkdownSelectionView {
  readonly state: {
    readonly readOnly?: boolean;
    readonly selection: {
      readonly ranges: readonly MarkdownSelectionRange[];
    };
    readonly doc: {
      lineAt(position: number): { readonly from: number; readonly to: number };
    };
  };
}

/** 光标位于该行或选区与该行相交时，立即切换到源码编辑态。 */
export function isSelectionOnDocumentLine(
  view: MarkdownSelectionView,
  lineFrom: number
): boolean {
  const line = view.state.doc.lineAt(lineFrom);

  return view.state.readOnly !== true && view.state.selection.ranges.some((range) => (
    range.empty
      ? view.state.doc.lineAt(range.head).from === lineFrom
      : range.from < line.to && range.to > line.from
  ));
}
