/**
 * 文件说明：渲染和编辑 Markdown 表格，支持行列菜单、背景高亮与拖拽。
 */
import { ensureSyntaxTree, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { isolateHistory, standardKeymap } from '@codemirror/commands';
import { completionStatus } from '@codemirror/autocomplete';
import { EditorState, Facet, Prec, type Range, StateEffect, StateField } from '@codemirror/state';
import {
  type BlockInfo,
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  GutterMarker,
  keymap,
  lineNumberWidgetMarker,
  type ViewUpdate,
  ViewPlugin,
  WidgetType
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { parser, Strikethrough, Table, type MarkdownExtension } from '@lezer/markdown';
import { createApp, type App as VueApp } from 'vue';
import WorkbenchHorizontalScrollbar from '@/components/scrollbar/WorkbenchHorizontalScrollbar.vue';
import { normalizeHexColor } from '@/utils/colorPalette';
import { resolveMediaSourceUrl } from '@/api/media';

const dragHorizontalIcon = '<span class="icon icon-drag-horizontal"></span>';
const dragVerticalIcon = '<span class="icon icon-drag-vertical"></span>';
const addIcon = '<span class="icon icon-add"></span>';
import { applyEditorBlockVisualState } from '@editor/Block/editorBlockUtils';
import {
  markdownInlineFormattingExtension,
  markdownInlineFormattingTheme
} from '@editor/Markdown/markdownInlineFormattingExtension';
import { markdownHighlightExtension } from '@editor/Markdown/markdownHighlightExtension';
import {
  createSanitizedEditorHtmlFragment,
  sanitizeEditorHtmlSource
} from '@editor/HtmlBlock/editorHtmlRenderer';
import { editorHtmlSourceHighlightExtension } from '@editor/HtmlBlock/editorHtmlSourceHighlightExtension';
import {
  editorHtmlHighlightStyle,
  editorHtmlLanguageSupport
} from '@editor/HtmlBlock/editorHtmlSyntaxHighlight';
import { EMPTY_TABLE_CELL_PLACEHOLDER } from '@editor/Table/tableConstants';
import type { TableContextMenuActionId } from '@editor/Table/tableColumnContextMenu';
import { readTableCellImages, resolveTableCellImageSize, stripTableCellImages, writeTableCellImages, type TableCellImage } from './tableCellImages';

const pendingTableCellFocus = new WeakMap<
  EditorView,
  { readonly tableFrom: number; readonly target: 'first-cell' | 'new-row' | 'new-column' }
>();
const tableCellEditorViews = new WeakMap<HTMLElement, EditorView>();
const tableCellEditingFinishers = new WeakMap<HTMLElement, () => void>();
/** 为单元格图片提供与当前 Markdown 文件一致的相对路径上下文。 */
const editorTableCurrentFilePath = Facet.define<() => string | undefined, () => string | undefined>({
  combine: (values) => values[0] ?? (() => undefined)
});

/** 根据当前获得焦点的单元格编辑器同步表格编辑态。 */
function syncTableCellEditingState(view: EditorView): void {
  const hasFocusedCellEditor = Array.from(
    view.dom.querySelectorAll<HTMLElement>('.cm-editor-table__editor')
  ).some((editorHost) => tableCellEditorViews.get(editorHost)?.hasFocus === true);
  view.dom.classList.toggle('cm-table-cell-editing', hasFocusedCellEditor);
}

/** 使用工作台主题色绘制单元格内嵌编辑器的独立选区。 */
const editorTableCellSelectionTheme = EditorView.theme({
  '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--workbench-editor-selection) !important'
  }
});

/** 根据右键事件目标解析当前单元格的内嵌编辑器实例。 */
export function resolveEditorTableCellView(target: Node): EditorView | null {
  const targetElement = target instanceof Element ? target : target.parentElement;
  const editorHost = targetElement?.closest<HTMLElement>('.cm-editor-table__editor');
  return editorHost ? tableCellEditorViews.get(editorHost) ?? null : null;
}

/** 在修改表格结构前同步结束当前表格中的单元格编辑。 */
function finishActiveTableCellEditing(view: EditorView, tableFrom: number): void {
  const editorHost = view.dom.querySelector<HTMLElement>(
    `.cm-editor-table[data-table-from="${tableFrom}"] .cm-editor-table__editor`
  );
  if (!editorHost) return;
  tableCellEditingFinishers.get(editorHost)?.();
}

/** 根据源码起点获取当前表格 Widget 中最新的单元格节点。 */
function resolveCurrentTableCellElement(
  view: EditorView,
  cellFrom: number
): HTMLTableCellElement | null {
  return view.dom.querySelector<HTMLTableCellElement>(
    `.cm-editor-table [data-table-cell-from="${cellFrom}"]`
  );
}

/** 请求表格 Widget 更新后聚焦指定单元格。 */
export function requestEditorTableCellFocus(
  view: EditorView,
  tableFrom: number,
  target: 'first-cell' | 'new-row' | 'new-column'
): void {
  pendingTableCellFocus.set(view, { tableFrom, target });
}

interface TableCell {
  readonly from: number;
  readonly to: number;
  readonly value: string;
}

/** 行列背景元数据只读取单元格开头的内部注释，不影响用户正文。 */
const TABLE_BACKGROUND_PREFIX_PATTERN = /^(?:<!--wstudio-table-(?:column|row)-background:#[0-9a-f]{6}(?:[0-9a-f]{2})?-->)+/i;

/** 读取表头保存的列背景颜色。 */
function resolveTableColumnBackground(value: string): string | null {
  return /<!--wstudio-table-column-background:(#[0-9a-f]{6}(?:[0-9a-f]{2})?)-->/i
    .exec(TABLE_BACKGROUND_PREFIX_PATTERN.exec(value)?.[0] ?? '')?.[1]?.toUpperCase() ?? null;
}

/** 读取数据行首单元格保存的行背景颜色。 */
function resolveTableRowBackground(values: readonly string[]): string | null {
  for (const value of values) {
    const color = /<!--wstudio-table-row-background:(#[0-9a-f]{6}(?:[0-9a-f]{2})?)-->/i
      .exec(TABLE_BACKGROUND_PREFIX_PATTERN.exec(value)?.[0] ?? '')?.[1];
    if (color) return color.toUpperCase();
  }
  return null;
}

/** 将行列颜色与正文合并为唯一的元数据前缀。 */
function formatTableCellBackground(value: string, column: string | null, row: string | null): string {
  const content = value.replace(TABLE_BACKGROUND_PREFIX_PATTERN, '') || EMPTY_TABLE_CELL_PLACEHOLDER;
  return `${column ? `<!--wstudio-table-column-background:${column}-->` : ''}${row ? `<!--wstudio-table-row-background:${row}-->` : ''}${content}`;
}

/** 将行颜色归位到首单元格，避免列移动、复制或删除带走行颜色。 */
function formatTableRowBackground(values: readonly string[], color = resolveTableRowBackground(values)): string[] {
  return values.map((value, index) => formatTableCellBackground(
    value, resolveTableColumnBackground(value), index === 0 ? color : null
  ));
}

/** 将内部空单元格占位符和背景元数据转换为界面可编辑内容。 */
function resolveTableCellDisplayValue(value: string): string {
  return stripTableCellImages(value).replace(TABLE_BACKGROUND_PREFIX_PATTERN, '').split(EMPTY_TABLE_CELL_PLACEHOLDER).join('');
}

/** 判断单元格是否包含文字或独立图片，避免图片单元格被当作新增占位行列。 */
function hasTableCellContent(value: string): boolean {
  return resolveTableCellDisplayValue(value) !== '' || readTableCellImages(value).length > 0;
}

/** HTML 换行标签的共享正则源码。 */
const TABLE_LINE_BREAK_SOURCE = '<br\\s*\\/?>';

/** 判断完整 token 是否为 HTML 换行标签。 */
const TABLE_LINE_BREAK_PATTERN = new RegExp(`^${TABLE_LINE_BREAK_SOURCE}$`, 'i');

/** 匹配表格支持的 Markdown 行内 token 与 HTML 换行标签。 */
const TABLE_INLINE_TOKEN_PATTERN = new RegExp(
  '(`[^`\\r\\n]+`|\\*\\*[^*\\r\\n]+\\*\\*|\\*[^*\\r\\n]+\\*|' + TABLE_LINE_BREAK_SOURCE + ')',
  'gi'
);

interface TableInlineToken {
  readonly index: number;
  readonly text: string;
  readonly image?: { readonly source: string; readonly alt: string; readonly title: string };
}

/** 使用 Markdown 语法树识别图片，避免括号、标题和代码中的图片写法被正则截断。 */
function collectTableInlineTokens(source: string): TableInlineToken[] {
  const images: TableInlineToken[] = [];
  if (source.includes('![')) parser.parse(source).iterate({
    enter(cursor) {
      if (cursor.name !== 'Image') return;
      const url = cursor.node.getChild('URL');
      if (!url) return false;
      const title = cursor.node.getChild('LinkTitle');
      const labelEnd = source.lastIndexOf(']', url.from);
      images.push({
        index: cursor.from,
        text: source.slice(cursor.from, cursor.to),
        image: {
          source: source.slice(url.from, url.to),
          alt: source.slice(cursor.from + 2, labelEnd),
          title: title ? source.slice(title.from + 1, title.to - 1) : ''
        }
      });
      return false;
    }
  });
  const tokens: TableInlineToken[] = [...images];
  for (const match of source.matchAll(TABLE_INLINE_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (images.some((image) => index < image.index + image.text.length
      && index + match[0].length > image.index)) continue;
    tokens.push({ index, text: match[0] });
  }
  return tokens.sort((left, right) => left.index - right.index);
}

/** 判断表格行内 token 是否为换行标签。 */
function isTableLineBreakToken(token: string): boolean {
  return TABLE_LINE_BREAK_PATTERN.test(token);
}

/** 单元格源码转换后的编辑内容与光标位置。 */
interface TableCellEditingContent {
  readonly editingValue: string;
  readonly editingOffset: number | null;
}

/** 按渲染 token 规则转换换行标签，并同步换算源码光标偏移。 */
function resolveTableCellEditingContent(
  value: string,
  sourceOffset?: number | null
): TableCellEditingContent {
  const displayValue = resolveTableCellDisplayValue(value);
  const boundedOffset = sourceOffset === null || sourceOffset === undefined
    ? null
    : Math.max(0, Math.min(displayValue.length, sourceOffset));
  const editingParts: string[] = [];
  let sourceCursor = 0;
  let editingCursor = 0;
  let editingOffset: number | null = boundedOffset === 0 ? 0 : null;

  for (const match of collectTableInlineTokens(displayValue)) {
    const matchIndex = match.index;
    const token = match.text;
    const matchEnd = matchIndex + token.length;
    const plainText = displayValue.slice(sourceCursor, matchIndex);

    if (boundedOffset !== null && editingOffset === null && boundedOffset <= matchIndex) {
      editingOffset = editingCursor + boundedOffset - sourceCursor;
    }
    editingParts.push(plainText);
    editingCursor += plainText.length;

    if (isTableLineBreakToken(token)) {
      editingParts.push('\n');
      if (boundedOffset !== null && editingOffset === null && boundedOffset <= matchEnd) {
        editingOffset = editingCursor + (boundedOffset === matchIndex ? 0 : 1);
      }
      editingCursor += 1;
    } else {
      editingParts.push(token);
      if (boundedOffset !== null && editingOffset === null && boundedOffset <= matchEnd) {
        editingOffset = editingCursor + boundedOffset - matchIndex;
      }
      editingCursor += token.length;
    }
    sourceCursor = matchEnd;
  }

  const trailingText = displayValue.slice(sourceCursor);
  editingParts.push(trailingText);
  if (boundedOffset !== null && editingOffset === null) {
    editingOffset = editingCursor + boundedOffset - sourceCursor;
  }

  return { editingValue: editingParts.join(''), editingOffset };
}

/** 将内嵌编辑器中的真实换行序列化为单行表格源码。 */
function serializeTableCellEditingValue(value: string): string {
  return value.replace(/\r\n?|\n/g, '<br>');
}

/** 将支持的 Markdown 内联标记移除后生成列排序文本。 */
function resolveTableCellSortValue(value: string): string {
  return resolveTableCellDisplayValue(value)
    .replace(/`([^`\r\n]*)`/g, '$1')
    .replace(/\*\*([^*\r\n]*)\*\*/g, '$1')
    .replace(/\*([^*\r\n]*)\*/g, '$1')
    .trim();
}

interface TableBlock {
  readonly from: number;
  readonly to: number;
  readonly headers: readonly TableCell[];
  readonly rows: readonly (readonly TableCell[])[];
  readonly alignments: readonly ('left' | 'center' | 'right')[];
}

/** 显示与表格顶部对齐的真实文档行号。 */
class EditorTableLineNumberMarker extends GutterMarker {
  /** 创建表格行号标记。 */
  public constructor(private readonly lineNumber: number) {
    super();
  }

  /** 比较行号，避免内容未变化时重建标记。 */
  public override eq(marker: GutterMarker): boolean {
    return marker instanceof EditorTableLineNumberMarker
      && marker.lineNumber === this.lineNumber;
  }

  /** 创建表格专用行号节点。 */
  public override toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'cm-editor-table-line-number';
    element.textContent = String(this.lineNumber);
    return element;
  }
}

/** 创建包含列顺序、单元格内容和对齐方式的表格比较标识。 */
function createTableBlockFingerprint(block: TableBlock): string {
  return JSON.stringify({
    headers: block.headers.map((cell) => cell.value),
    rows: block.rows.map((row) => row.map((cell) => cell.value)),
    alignments: block.alignments
  });
}

/** 将表格分隔行解析为列对齐方式。 */
function parseAlignments(state: EditorState, header: SyntaxNode): TableBlock['alignments'] {
  const headerLine = state.doc.lineAt(header.from);
  const delimiterCells = state.doc.line(headerLine.number + 1).text
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

  return delimiterCells.map((cell) => (
    cell.startsWith(':') && cell.endsWith(':')
      ? 'center'
      : cell.endsWith(':') ? 'right' : 'left'
  ));
}

/** 将分隔符之间的源码范围规范化为可编辑单元格。 */
function createTableCellSource(
  state: EditorState,
  sourceFrom: number,
  sourceTo: number
): TableCell {
  const source = state.sliceDoc(sourceFrom, sourceTo);
  const leadingWhitespace = source.length - source.trimStart().length;
  const trailingWhitespace = source.length - source.trimEnd().length;
  const from = sourceFrom + leadingWhitespace;
  const to = Math.max(from, sourceTo - trailingWhitespace);
  return {
    from,
    to,
    value: state.sliceDoc(from, to)
  };
}

/** 判断表格行是否显式包含至少一个管道分隔符。 */
function hasTableDelimiter(row: SyntaxNode): boolean {
  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') return true;
  }
  return false;
}

/** 读取表格行节点中的单元格源码范围，兼容省略左右外侧管道的写法。 */
function collectCells(state: EditorState, row: SyntaxNode): TableCell[] {
  const delimiters: SyntaxNode[] = [];

  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableDelimiter') {
      delimiters.push(child);
    }
  }

  if (delimiters.length === 0) {
    return [createTableCellSource(state, row.from, row.to)];
  }

  const leadingDelimiter = delimiters[0]?.from === row.from;
  const trailingDelimiter = delimiters[delimiters.length - 1]?.to === row.to;
  const cells: TableCell[] = [];
  let cellFrom = leadingDelimiter ? delimiters[0]?.to ?? row.from : row.from;

  for (let index = leadingDelimiter ? 1 : 0; index < delimiters.length; index += 1) {
    const delimiter = delimiters[index];
    if (!delimiter) continue;
    cells.push(createTableCellSource(state, cellFrom, delimiter.from));
    cellFrom = delimiter.to;
  }

  if (!trailingDelimiter) {
    cells.push(createTableCellSource(state, cellFrom, row.to));
  }
  return cells;
}

/** 从 Lezer Table 语法树收集可由表格控件稳定编辑的显式管道表格范围。 */
function collectTableBlocks(state: EditorState): TableBlock[] {
  // 仅在短时间预算内同步解析，避免表格扫描阻塞编辑器首屏。
  const tree = ensureSyntaxTree(state, state.doc.length, 80) ?? syntaxTree(state);
  const blocks: TableBlock[] = [];

  tree.iterate({
    enter(cursor) {
      if (cursor.name !== 'Table') {
        return;
      }

      const table = cursor.node;
      const header = table.getChild('TableHeader');

      if (!header) {
        return false;
      }

      const headerCells = collectCells(state, header);
      const delimiterLine = state.doc.line(state.doc.lineAt(header.from).number + 1);
      const rows: TableCell[][] = [];
      let renderedTo = delimiterLine.to;

      // Lezer 会把紧随表格的无管道文本识别成单列表格行，此处保留其普通文本形态。
      for (let child = header.nextSibling; child; child = child.nextSibling) {
        if (child.name === 'TableRow') {
          if (!hasTableDelimiter(child)) break;
          rows.push(collectCells(state, child));
          renderedTo = child.to;
        }
      }

      blocks.push({
        from: table.from,
        to: renderedTo,
        headers: headerCells,
        rows,
        alignments: parseAlignments(state, header)
      });
      return false;
    }
  });

  return blocks;
}

/** 获取右键列当前保存的背景颜色。 */
export function getEditorTableColumnBackground(
  view: EditorView,
  tableFrom: number,
  columnIndex: number
): string | null {
  const header = collectTableBlocks(view.state).find((block) => block.from === tableFrom)?.headers[columnIndex];
  return header ? resolveTableColumnBackground(header.value) : null;
}

/** 通过表头元数据设置或清除整列背景，新增数据行也继承该颜色。 */
export function setEditorTableColumnBackground(
  view: EditorView,
  tableFrom: number,
  columnIndex: number,
  color: string | null
): void {
  if (view.state.readOnly) return;
  const normalized = color === null ? null : normalizeHexColor(color);
  if (normalized === undefined) return;
  finishActiveTableCellEditing(view, tableFrom);
  const header = collectTableBlocks(view.state).find((block) => block.from === tableFrom)?.headers[columnIndex];
  if (!header) return;
  const source = formatTableCellBackground(header.value, normalized, resolveTableRowBackground([header.value]));
  if (source === header.value) return;
  view.dispatch({
    changes: { from: header.from, to: header.to, insert: source },
    userEvent: 'input.table-column-background'
  });
}

/** 获取数据行保存的背景色。 */
export function getEditorTableRowBackground(view: EditorView, tableFrom: number, rowIndex: number): string | null {
  const row = collectTableBlocks(view.state).find((block) => block.from === tableFrom)?.rows[rowIndex];
  return row ? resolveTableRowBackground(row.map((cell) => cell.value)) : null;
}

/** 设置或清除整行背景，颜色随首单元格元数据保存。 */
export function setEditorTableRowBackground(
  view: EditorView, tableFrom: number, rowIndex: number, color: string | null
): void {
  if (view.state.readOnly) return;
  const normalized = color === null ? null : normalizeHexColor(color);
  if (normalized === undefined) return;
  finishActiveTableCellEditing(view, tableFrom);
  const row = collectTableBlocks(view.state).find((block) => block.from === tableFrom)?.rows[rowIndex];
  if (!row) return;
  const values = formatTableRowBackground(row.map((cell) => cell.value), normalized);
  const changes = row.flatMap((cell, index) => cell.value === values[index]
    ? [] : [{ from: cell.from, to: cell.to, insert: values[index] ?? '' }]);
  if (changes.length) view.dispatch({ changes, userEvent: 'input.table-row-background' });
}

/** 获取表格块 Widget 实际替换的文档终点，包含存在的末尾换行符。 */
function getTableReplacementTo(state: EditorState, block: TableBlock): number {
  return block.to < state.doc.length ? block.to + 1 : block.to;
}

/** 将焦点交回表格前后的主文档，文档首尾缺少落点时补充真实空行。 */
function exitEditorTable(view: EditorView, block: TableBlock, forward: boolean): void {
  const boundaryLine = view.state.doc.lineAt(forward ? block.to : block.from);
  const needsLine = forward
    ? boundaryLine.number === view.state.doc.lines
    : boundaryLine.number === 1;
  const boundary = forward ? boundaryLine.to : boundaryLine.from;
  const position = forward ? boundary + 1 : Math.max(0, boundary - 1);
  view.dispatch({
    changes: needsLine ? { from: boundary, insert: '\n' } : undefined,
    selection: { anchor: position },
    scrollIntoView: true,
    userEvent: needsLine ? 'input.table-exit' : 'select.table-exit'
  });
  view.focus();
}

/** 为表格后的真实空行提供光标定位宽度，不写入 Markdown 文档。 */
class EditorTableTrailingLineWidget extends WidgetType {
  /** 创建由 CodeMirror 管理且不截获指针的无语义空格节点。 */
  public override toDOM(): HTMLElement {
    const placeholder = document.createElement('span');
    placeholder.className = 'cm-editor-table__trailing-line-widget';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.style.pointerEvents = 'none';
    placeholder.textContent = ' ';
    return placeholder;
  }

  /** 复用同类型 Widget 的现有 DOM。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorTableTrailingLineWidget;
  }

  /** 让 CodeMirror 处理空格节点上的指针与输入事件。 */
  public override ignoreEvent(): boolean {
    return false;
  }
}

/** 将外部粘贴表格中的真实空单元格规范化为内部不可见占位符。 */
function normalizeEmptyTableCells(view: EditorView): boolean {
  const emptyCells = collectTableBlocks(view.state).flatMap((block) => [
    ...block.headers,
    ...block.rows.flat()
  ]).filter((cell) => cell.value === '' && cell.from === cell.to);
  if (emptyCells.length === 0) return false;
  view.dispatch({
    changes: emptyCells.map((cell) => ({
      from: cell.from,
      to: cell.to,
      insert: EMPTY_TABLE_CELL_PLACEHOLDER
    })),
    userEvent: 'input.table-empty-normalize'
  });
  return true;
}

/** 将图片、粗体、代码、斜体和换行 Markdown 追加为安全 DOM。 */
function appendInlineMarkdown(container: HTMLElement, source: string, view: EditorView): void {
  const displaySource = resolveTableCellDisplayValue(source);
  let sourceOffset = 0;

  for (const match of collectTableInlineTokens(displaySource)) {
    const matchIndex = match.index;
    container.append(document.createTextNode(displaySource.slice(sourceOffset, matchIndex)));

    const token = match.text;
    if (match.image) {
      const image = document.createElement('img');
      image.className = 'cm-editor-table__image';
      image.alt = match.image.alt;
      image.title = match.image.title;
      image.draggable = false;
      image.src = resolveMediaSourceUrl(match.image.source, view.state.facet(editorTableCurrentFilePath)());
      container.append(image);
      sourceOffset = matchIndex + token.length;
      continue;
    }
    if (isTableLineBreakToken(token)) {
      container.append(document.createElement('br'));
      sourceOffset = matchIndex + token.length;
      continue;
    }

    const element = document.createElement(
      token.startsWith('`') ? 'code' : token.startsWith('**') ? 'strong' : 'em'
    );
    const delimiterLength = token.startsWith('**') ? 2 : 1;
    element.textContent = token.slice(delimiterLength, -delimiterLength);
    container.append(element);
    sourceOffset = matchIndex + token.length;
  }

  container.append(document.createTextNode(displaySource.slice(sourceOffset)));
}

/** 将单元格渲染文本偏移换算为包含 Markdown 标记的源码偏移。 */
function resolveTableCellSourceOffset(source: string, renderedOffset: number): number {
  const displaySource = resolveTableCellDisplayValue(source);
  let sourceOffset = 0;
  let displayOffset = 0;

  for (const match of collectTableInlineTokens(displaySource)) {
    const matchIndex = match.index;
    const plainLength = matchIndex - sourceOffset;

    if (renderedOffset <= displayOffset + plainLength) {
      return sourceOffset + renderedOffset - displayOffset;
    }

    sourceOffset = matchIndex;
    displayOffset += plainLength;
    const token = match.text;
    if (match.image) {
      if (renderedOffset <= displayOffset + 1) return sourceOffset + token.length;
      sourceOffset += token.length;
      displayOffset += 1;
      continue;
    }
    if (isTableLineBreakToken(token)) {
      if (renderedOffset <= displayOffset + 1) {
        return sourceOffset + token.length;
      }
      sourceOffset += token.length;
      displayOffset += 1;
      continue;
    }

    const delimiterLength = token.startsWith('**') ? 2 : 1;
    const contentLength = token.length - delimiterLength * 2;

    if (renderedOffset <= displayOffset + contentLength) {
      return sourceOffset + delimiterLength + renderedOffset - displayOffset;
    }

    sourceOffset += token.length;
    displayOffset += contentLength;
  }

  return Math.min(displaySource.length, sourceOffset + renderedOffset - displayOffset);
}

/** 计算 DOM 节点在表格渲染内容中占据的可定位长度。 */
function getTableRenderedNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.length ?? 0;
  }
  if (node instanceof HTMLBRElement || node instanceof HTMLImageElement) {
    return 1;
  }
  return Array.from(node.childNodes).reduce(
    (length, child) => length + getTableRenderedNodeLength(child),
    0
  );
}

/** 将浏览器 caret 的 DOM 位置换算为表格渲染内容偏移。 */
function getTableRenderedCaretOffset(root: Node, target: Node, targetOffset: number): number | null {
  if (root === target) {
    if (root.nodeType === Node.TEXT_NODE) {
      return Math.min(targetOffset, root.textContent?.length ?? 0);
    }
    return Array.from(root.childNodes)
      .slice(0, targetOffset)
      .reduce((length, child) => length + getTableRenderedNodeLength(child), 0);
  }

  let offset = 0;
  for (const child of Array.from(root.childNodes)) {
    const childOffset = getTableRenderedCaretOffset(child, target, targetOffset);
    if (childOffset !== null) {
      return offset + childOffset;
    }
    offset += getTableRenderedNodeLength(child);
  }
  return null;
}

/** 在替换渲染态 DOM 前解析鼠标点击对应的单元格源码位置。 */
function resolveTableCellPointerSourcePosition(
  cellElement: HTMLTableCellElement,
  source: string,
  clientX: number,
  clientY: number
): number | null {
  const content = cellElement.querySelector<HTMLElement>('.cm-editor-table__content');
  const caret = document.caretPositionFromPoint?.(clientX, clientY);

  if (!content || !caret || !content.contains(caret.offsetNode)) return null;
  if (content.dataset.tableContentMode === 'html') return 0;

  const renderedOffset = getTableRenderedCaretOffset(content, caret.offsetNode, caret.offset);
  return renderedOffset === null ? null : resolveTableCellSourceOffset(source, renderedOffset);
}

/** 在单元格进入编辑态后恢复点击前的编辑器滚动位置。 */
function preserveTableEditingScroll(view: EditorView, scrollLeft: number, scrollTop: number): void {
  const restoreScroll = (): void => {
    view.scrollDOM.scrollLeft = scrollLeft;
    view.scrollDOM.scrollTop = scrollTop;
  };
  restoreScroll();
  requestAnimationFrame(() => {
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  });
}

/** 提交单元格变更到 CodeMirror 文档。 */
function commitCell(view: EditorView, cell: TableCell, value: string): void {
  const sourceValue = formatTableCellBackground(
    writeTableCellImages(value, readTableCellImages(cell.value)),
    resolveTableColumnBackground(cell.value), resolveTableRowBackground([cell.value])
  );
  if (sourceValue === cell.value) {
    return;
  }

  view.dispatch({
    changes: { from: cell.from, to: cell.to, insert: sourceValue },
    userEvent: 'input.table'
  });
}

/** 将列对齐方式转换为规范化 Markdown 分隔单元格。 */
function formatAlignment(alignment: TableBlock['alignments'][number]): string {
  if (alignment === 'center') {
    return ':---:';
  }

  return alignment === 'right' ? '---:' : '---';
}

/** 按目标顺序生成规范化 Markdown 表格源码。 */
function formatReorderedTable(block: TableBlock, columnOrder: readonly number[]): string {
  const formatRow = (cells: readonly TableCell[]) => (
    `| ${columnOrder.map((index) => cells[index]?.value ?? '').join(' | ')} |`
  );
  const headerLine = formatRow(block.headers);
  const delimiterLine = `| ${columnOrder
    .map((index) => formatAlignment(block.alignments[index] ?? 'left'))
    .join(' | ')} |`;
  const rowLines = block.rows.map((row) => `| ${formatTableRowBackground(
    columnOrder.map((index) => row[index]?.value ?? ''), resolveTableRowBackground(row.map((cell) => cell.value))
  ).join(' | ')} |`);

  return [headerLine, delimiterLine, ...rowLines].join('\n');
}

/** 重新生成 Markdown 表格文本并应用新的数据行顺序。 */
function formatReorderedRows(block: TableBlock, rowOrder: readonly number[]): string {
  const formatRow = (cells: readonly TableCell[]) => `| ${cells.map((cell) => cell.value).join(' | ')} |`;
  const headerLine = formatRow(block.headers);
  const separatorLine = `| ${block.alignments.map((alignment) => alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : '---').join(' | ')} |`;
  return [headerLine, separatorLine, ...rowOrder.map((index) => formatRow(block.rows[index] ?? []))].join('\n');
}

/** 将值矩阵格式化为规范化 Markdown 表格源码。 */
function formatTableValues(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  alignments: TableBlock['alignments']
): string {
  const formatRow = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [
    formatRow(headers),
    `| ${alignments.map(formatAlignment).join(' | ')} |`,
    ...rows.map(formatRow)
  ].join('\n');
}

/** 执行行列拖拽手柄右键菜单动作并写回 Markdown。 */
export function executeTableContextAction(
  view: EditorView,
  tableFrom: number,
  rowIndex: number | null,
  columnIndex: number,
  actionId: TableContextMenuActionId
): void {
  const block = collectTableBlocks(view.state).find((tableBlock) => tableBlock.from === tableFrom);
  if (!block || columnIndex < 0 || columnIndex >= block.headers.length) return;

  const headers = block.headers.map((cell) => cell.value);
  const rows = block.rows.map((row) => row.map((cell) => cell.value));
  const rowBackgrounds = new Map(rows.map((row) => [row, resolveTableRowBackground(row)]));
  const alignments = [...block.alignments];
  const insertColumn = (targetIndex: number): void => {
    headers.splice(targetIndex, 0, EMPTY_TABLE_CELL_PLACEHOLDER);
    alignments.splice(targetIndex, 0, 'left');
    rows.forEach((row) => row.splice(targetIndex, 0, EMPTY_TABLE_CELL_PLACEHOLDER));
  };
  const insertRow = (targetIndex: number): void => {
    rows.splice(targetIndex, 0, headers.map(() => EMPTY_TABLE_CELL_PLACEHOLDER));
  };

  switch (actionId) {
    case 'align-top':
      // 单元格外层已顶部对齐；同步左右图文的内部布局，并保留上下排版图片的横向对齐。
      for (const values of [headers, ...rows]) {
        const value = values[columnIndex] ?? '';
        const images = readTableCellImages(value);
        if (images.length === 0) continue;
        values[columnIndex] = writeTableCellImages(value, images.map(image => (
          image.position === 'top' || image.position === 'bottom' ? image : { ...image, alignment: 'top' }
        )));
      }
      break;
    case 'insert-row-above':
      if (rowIndex === null) return;
      insertRow(rowIndex);
      break;
    case 'insert-row-below':
      if (rowIndex === null) return;
      insertRow(rowIndex + 1);
      break;
    case 'move-row-up':
      if (rowIndex === null || rowIndex <= 0) return;
      [rows[rowIndex - 1], rows[rowIndex]] = [rows[rowIndex] ?? [], rows[rowIndex - 1] ?? []];
      break;
    case 'move-row-down':
      if (rowIndex === null || rowIndex >= rows.length - 1) return;
      [rows[rowIndex], rows[rowIndex + 1]] = [rows[rowIndex + 1] ?? [], rows[rowIndex] ?? []];
      break;
    case 'copy-row':
      if (rowIndex === null) return;
      rows.splice(rowIndex + 1, 0, [...(rows[rowIndex] ?? [])]);
      break;
    case 'delete-row':
      if (rowIndex === null) return;
      rows.splice(rowIndex, 1);
      break;
    case 'sort-ascending':
    case 'sort-descending': {
      const direction = actionId === 'sort-ascending' ? 1 : -1;
      const collator = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: 'base'
      });
      rows.sort((left, right) => {
        const leftValue = resolveTableCellSortValue(left[columnIndex] ?? '');
        const rightValue = resolveTableCellSortValue(right[columnIndex] ?? '');
        if (leftValue === '') return rightValue === '' ? 0 : 1;
        if (rightValue === '') return -1;
        return direction * collator.compare(leftValue, rightValue);
      });
      break;
    }
    case 'insert-column-left':
      insertColumn(columnIndex);
      break;
    case 'insert-column-right':
      insertColumn(columnIndex + 1);
      break;
    case 'move-column-left':
      if (columnIndex <= 0) return;
      [headers[columnIndex - 1], headers[columnIndex]] = [headers[columnIndex] ?? '', headers[columnIndex - 1] ?? ''];
      [alignments[columnIndex - 1], alignments[columnIndex]] = [alignments[columnIndex] ?? 'left', alignments[columnIndex - 1] ?? 'left'];
      rows.forEach((row) => {
        [row[columnIndex - 1], row[columnIndex]] = [row[columnIndex] ?? '', row[columnIndex - 1] ?? ''];
      });
      break;
    case 'move-column-right':
      if (columnIndex >= headers.length - 1) return;
      [headers[columnIndex], headers[columnIndex + 1]] = [headers[columnIndex + 1] ?? '', headers[columnIndex] ?? ''];
      [alignments[columnIndex], alignments[columnIndex + 1]] = [alignments[columnIndex + 1] ?? 'left', alignments[columnIndex] ?? 'left'];
      rows.forEach((row) => {
        [row[columnIndex], row[columnIndex + 1]] = [row[columnIndex + 1] ?? '', row[columnIndex] ?? ''];
      });
      break;
    case 'align-left':
    case 'align-center':
    case 'align-right':
      alignments[columnIndex] = actionId === 'align-center'
        ? 'center'
        : actionId === 'align-right' ? 'right' : 'left';
      break;
    case 'copy-column':
      headers.splice(columnIndex + 1, 0, headers[columnIndex] ?? '');
      alignments.splice(columnIndex + 1, 0, alignments[columnIndex] ?? 'left');
      rows.forEach((row) => row.splice(columnIndex + 1, 0, row[columnIndex] ?? ''));
      break;
    case 'delete-column':
      if (headers.length <= 1) return;
      headers.splice(columnIndex, 1);
      alignments.splice(columnIndex, 1);
      rows.forEach((row) => row.splice(columnIndex, 1));
      break;
  }

  view.dispatch({
    changes: {
      from: block.from,
      to: block.to,
      insert: formatTableValues(headers, rows.map((row) => formatTableRowBackground(
        row, rowBackgrounds.get(row) ?? resolveTableRowBackground(row)
      )), alignments)
    },
    userEvent: 'input.table-column-menu'
  });
}

/** 移动 Markdown 表格中的数据行。 */
function moveTableRow(view: EditorView, block: TableBlock, sourceIndex: number, targetIndex: number): void {
  const rowOrder = block.rows.map((_, index) => index);
  const [movedRow] = rowOrder.splice(sourceIndex, 1);
  const normalizedTargetIndex = targetIndex > sourceIndex ? targetIndex - 1 : targetIndex;
  rowOrder.splice(normalizedTargetIndex, 0, movedRow);
  if (rowOrder.every((index, position) => index === position)) {
    return;
  }
  view.dispatch({
    changes: { from: block.from, to: block.to, insert: formatReorderedRows(block, rowOrder) },
    userEvent: 'input.table-row-move'
  });
}

/** 在 Markdown 表格末尾追加一个空数据行。 */
function addTableRow(
  view: EditorView,
  block: TableBlock,
  scrollSnapshot: ReturnType<EditorView['scrollSnapshot']>
): void {
  const formatRow = (cells: readonly TableCell[]) => `| ${cells.map((cell) => cell.value).join(' | ')} |`;
  const headerLine = formatRow(block.headers);
  const separatorLine = `| ${block.alignments.map(formatAlignment).join(' | ')} |`;
  const rowLines = block.rows.map(formatRow);
  const emptyRow = `| ${block.headers.map(() => EMPTY_TABLE_CELL_PLACEHOLDER).join(' | ')} |`;
  const changes = view.state.changes({
    from: block.from,
    to: block.to,
    insert: [headerLine, separatorLine, ...rowLines, emptyRow].join('\n')
  });
  const mappedScrollSnapshot = scrollSnapshot.map(changes);
  requestEditorTableCellFocus(view, block.from, 'new-row');
  view.dispatch({
    changes,
    effects: mappedScrollSnapshot ? [mappedScrollSnapshot] : [],
    userEvent: 'input.table-row-add'
  });
}

/** 在 Markdown 表格右侧追加一个空列。 */
function addTableColumn(
  view: EditorView,
  block: TableBlock,
  scrollSnapshot: ReturnType<EditorView['scrollSnapshot']>
): void {
  const headerLine = view.state.doc.lineAt(block.headers[0]?.from ?? block.from);
  const separatorLine = view.state.doc.line(headerLine.number + 1);
  const dataLines = block.rows.map((row) => view.state.doc.lineAt(row[0]?.from ?? block.from));
  const appendCell = (lineText: string, value: string): string => (
    lineText.trimEnd().endsWith('|') ? ` ${value} |` : ` | ${value} |`
  );
  const changes = view.state.changes([
    { from: headerLine.to, insert: appendCell(headerLine.text, EMPTY_TABLE_CELL_PLACEHOLDER) },
    { from: separatorLine.to, insert: appendCell(separatorLine.text, formatAlignment('left')) },
    ...dataLines.map((line) => ({
      from: line.to,
      insert: appendCell(line.text, EMPTY_TABLE_CELL_PLACEHOLDER)
    }))
  ]);
  const mappedScrollSnapshot = scrollSnapshot.map(changes);
  requestEditorTableCellFocus(view, block.from, 'new-column');
  view.dispatch({
    changes,
    effects: mappedScrollSnapshot ? [mappedScrollSnapshot] : [],
    userEvent: 'input.table-column-add'
  });
}

/** 将拖拽列移动到目标列并写回 Markdown 源码。 */
function moveTableColumn(
  view: EditorView,
  block: TableBlock,
  sourceIndex: number,
  targetInsertionIndex: number
): void {
  const columnOrder = block.headers.map((_, index) => index);
  const [movedColumn] = columnOrder.splice(sourceIndex, 1);
  const normalizedTargetIndex = targetInsertionIndex > sourceIndex
    ? targetInsertionIndex - 1
    : targetInsertionIndex;

  if (normalizedTargetIndex === sourceIndex) {
    return;
  }

  columnOrder.splice(normalizedTargetIndex, 0, movedColumn);
  view.dispatch({
    changes: {
      from: block.from,
      to: block.to,
      insert: formatReorderedTable(block, columnOrder)
    },
    userEvent: 'input.table-column-move'
  });
}

/** 清理表格中的所有列拖拽视觉状态。 */
function clearColumnDragState(table: HTMLTableElement): void {
  table.querySelectorAll<HTMLElement>('[data-column-drag-state]').forEach((cell) => {
    delete cell.dataset.columnDragState;
  });
  const tableBlock = table.closest<HTMLElement>('.cm-editor-table-block');
  if (tableBlock) {
    delete tableBlock.dataset.columnDropActive;
    tableBlock.style.removeProperty('--cm-editor-table-drop-line-x');
    delete tableBlock.dataset.rowDropActive;
    tableBlock.style.removeProperty('--cm-editor-table-drop-line-y');
  }
  delete table.dataset.rowDragSourceIndex;
  table.querySelectorAll<HTMLElement>('[data-row-drag-state]').forEach((row) => delete row.dataset.rowDragState);
}

/** 在列拖拽期间直接隐藏编辑器空行兜底光标。 */
function setTableDragCaretState(view: EditorView, hidden: boolean): void {
  view.dom.classList.toggle('cm-table-column-dragging', hidden);
  view.dom.querySelectorAll<HTMLElement>('.cm-dropCursor').forEach((cursor) => {
    cursor.style.display = hidden ? 'none' : '';
  });
}

/** 将拖拽视觉状态同步到指定整列。 */
function setColumnDragState(
  table: HTMLTableElement,
  columnIndex: number
): void {
  Array.from(table.rows).forEach((row) => {
    const cell = row.cells.item(columnIndex);

    if (cell) {
      cell.dataset.columnDragState = 'source';
    }
  });
}

/** 区分行手柄、列手柄和正文单元格，单元格菜单不产生行列框选。 */
export interface EditorTableContextTarget {
  readonly tableFrom: number;
  readonly rowIndex: number | null;
  readonly columnIndex: number;
  readonly axis: 'row' | 'column' | 'cell';
}

/** 图片菜单命中项由编辑器状态管理，不写入单元格附件或撤销历史。 */
export const setTableImageContextTargetEffect = StateEffect.define<{
  readonly cellFrom: number;
  readonly imageIndex: number;
} | null>();
const tableImageContextTargetField = StateField.define<{
  readonly cellFrom: number;
  readonly imageIndex: number;
} | null>({
  create: () => null,
  update(target, transaction) {
    if (transaction.docChanged) target = null;
    for (const effect of transaction.effects) {
      if (effect.is(setTableImageContextTargetEffect)) target = effect.value;
    }
    return target;
  }
});

/** 将菜单命中状态投影到当前图片 DOM，重建表格时同步恢复或清除。 */
const tableImageContextHighlightExtension = ViewPlugin.fromClass(class {
  public update(update: { readonly view: EditorView }): void {
    const target = update.view.state.field(tableImageContextTargetField);
    for (const image of update.view.dom.querySelectorAll<HTMLImageElement>('img[data-table-cell-image]')) {
      const cell = image.closest<HTMLElement>('[data-table-cell-from]');
      const active = target !== null && Number(cell?.dataset.tableCellFrom) === target.cellFrom
        && Number(image.dataset.tableCellImage) === target.imageIndex;
      if (active) image.dataset.imageContextState = 'active';
      else delete image.dataset.imageContextState;
    }
  }
});

/** 按手柄方向同步菜单框选和手柄可见状态。 */
export function setTableContextHighlight(view: EditorView, target: EditorTableContextTarget, active: boolean): void {
  if (target.axis === 'cell') return;
  const table = view.dom.querySelector<HTMLTableElement>(
    `.cm-editor-table[data-table-from="${target.tableFrom}"]`
  );
  if (!table) return;
  if (target.axis === 'row' && target.rowIndex !== null) {
    const row = table.tBodies[0]?.rows.item(target.rowIndex);
    if (row) {
      if (active) row.dataset.rowContextState = 'active';
      else delete row.dataset.rowContextState;
    }
    return;
  }
  Array.from(table.rows).forEach((row) => {
    const cell = row.cells.item(target.columnIndex);
    if (!cell) return;
    if (active) {
      cell.dataset.columnContextState = 'active';
    } else {
      delete cell.dataset.columnContextState;
    }
  });
}

/** 在表格块上设置贯穿整表高度的列插入占位线。 */
function setColumnDropIndicator(
  table: HTMLTableElement,
  headerCell: HTMLTableCellElement,
  position: 'before' | 'after'
): void {
  const tableBlock = table.closest<HTMLElement>('.cm-editor-table-block');
  if (!tableBlock) {
    return;
  }

  const blockRect = tableBlock.getBoundingClientRect();
  const cellRect = headerCell.getBoundingClientRect();
  const boundaryX = position === 'before' ? cellRect.left : cellRect.right;
  tableBlock.dataset.columnDropActive = 'true';
  tableBlock.style.setProperty('--cm-editor-table-drop-line-x', `${boundaryX - blockRect.left}px`);
}

/** 设置表格数据行的源行状态。 */
function setRowDragState(table: HTMLTableElement, rowIndex: number): void {
  const row = table.tBodies[0]?.rows.item(rowIndex);
  if (row) {
    row.dataset.rowDragState = 'source';
  }
}

/** 设置贯穿表格宽度的行插入占位线。 */
function setRowDropIndicator(table: HTMLTableElement, row: HTMLTableRowElement, position: 'before' | 'after'): void {
  const tableBlock = table.closest<HTMLElement>('.cm-editor-table-block');
  if (!tableBlock) return;
  const blockRect = tableBlock.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const boundaryY = position === 'before' ? rowRect.top : rowRect.bottom;
  tableBlock.dataset.rowDropActive = 'true';
  tableBlock.style.setProperty('--cm-editor-table-drop-line-y', `${boundaryY - blockRect.top}px`);
}

/** 替换单元格内容时保留已有的列、行拖拽手柄。 */
function replaceTableCellContent(cellElement: HTMLTableCellElement, content: HTMLElement): void {
  const dragHandles = Array.from(cellElement.querySelectorAll<HTMLElement>(
    ':scope > .cm-editor-table__drag-handle, :scope > .cm-editor-table__row-drag-handle'
  ));
  cellElement.replaceChildren(content, ...dragHandles);
}

/** 将单元格恢复为 Markdown 内联渲染态。 */
function renderCellContent(
  cellElement: HTMLTableCellElement,
  cell: TableCell,
  view: EditorView
): void {
  const content = document.createElement('div');
  const displayValue = resolveTableCellDisplayValue(cell.value);
  const sanitizedHtml = sanitizeEditorHtmlSource(displayValue);

  content.className = 'cm-editor-table__content';
  if (sanitizedHtml !== null) {
    const htmlFragment = createSanitizedEditorHtmlFragment(sanitizedHtml);
    if (htmlFragment.querySelector(':not(br)') !== null) {
      content.dataset.tableContentMode = 'html';
      content.append(htmlFragment);
    } else {
      appendInlineMarkdown(content, cell.value, view);
    }
  } else {
    appendInlineMarkdown(content, cell.value, view);
  }
  replaceTableCellContent(cellElement, createTableCellLayout(content, cell.value, view));
}

/** 预览与编辑共用附件布局，图片相对正文的位置和对齐由文档元数据决定。 */
function createTableCellLayout(content: HTMLElement, value: string, view: EditorView): HTMLElement {
  const image = readTableCellImages(value)[0];
  if (!image) return content;
  const layout = document.createElement('div');
  const media = document.createElement('div');
  layout.className = 'cm-editor-table__media-layout';
  layout.dataset.imagePosition = image.position ?? 'left';
  layout.dataset.imageAlignment = image.alignment ?? 'center';
  media.className = 'cm-editor-table__media';
  appendTableCellImages(media, value, view);
  layout.append(media, content);
  return layout;
}

/** 单元格图片作为独立附件 DOM 展示，在文字编辑时继续保留预览。 */
function appendTableCellImages(container: HTMLElement, value: string, view: EditorView): void {
  for (const [index, attachment] of readTableCellImages(value).entries()) {
    const frame = document.createElement('div');
    frame.className = 'cm-editor-table__image-frame';
    const image = document.createElement('img');
    image.className = 'cm-editor-table__image';
    image.dataset.tableCellImage = String(index);
    image.alt = attachment.title;
    image.title = attachment.title;
    image.draggable = false;
    /** 宽高直接控制图片，外框仅为旋转后的真实占用尺寸预留布局空间。 */
    const updateImageGeometry = (): void => {
      const { width, height } = resolveTableCellImageSize(attachment);
      const rotation = attachment.rotation ?? 0;
      const quarterTurn = rotation % 180 !== 0;
      const displayWidth = quarterTurn ? height : width;
      const displayHeight = quarterTurn ? width : height;
      frame.style.width = `${displayWidth}px`;
      frame.style.height = `${displayHeight}px`;
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      image.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
      view.requestMeasure();
    };
    image.addEventListener('load', updateImageGeometry);
    image.src = resolveMediaSourceUrl(attachment.source, view.state.facet(editorTableCurrentFilePath)());
    frame.append(image);
    container.append(frame);
    updateImageGeometry();
  }
}

/** 将单元格切换为复用 Markdown 行内格式规则的 CodeMirror 编辑态。 */
function editCell(
  cellElement: HTMLTableCellElement,
  cell: TableCell,
  view: EditorView,
  initialPosition?: number | null
): EditorView | null {
  const existingEditorHost = cellElement.querySelector<HTMLElement>('.cm-editor-table__editor');
  if (existingEditorHost) {
    return tableCellEditorViews.get(existingEditorHost) ?? null;
  }

  const editorHost = document.createElement('section');
  const originalSourceValue = cell.value;
  const initialEditingContent = resolveTableCellEditingContent(cell.value, initialPosition);
  const initialEditingValue = initialEditingContent.editingValue;
  const initialEditingPosition = initialEditingContent.editingOffset;
  let cellEditor: EditorView | null = null;
  let isFinishing = false;

  /** 结束单元格编辑并将单行源码同步回主文档。 */
  const finishEditing = (sourceValue: string): void => {
    if (isFinishing) return;
    isFinishing = true;
    tableCellEditorViews.delete(editorHost);
    tableCellEditingFinishers.delete(editorHost);
    cellEditor?.destroy();
    cellEditor = null;
    renderCellContent(cellElement, {
      ...cell, value: writeTableCellImages(sourceValue, readTableCellImages(cell.value))
    }, view);
    commitCell(view, cell, sourceValue);
    syncTableCellEditingState(view);
    view.requestMeasure();
  };

  /** 将内嵌编辑器值序列化后结束编辑。 */
  const commitEditingValue = (editingValue: string): void => {
    finishEditing(serializeTableCellEditingValue(editingValue));
  };

  /** 到达边界时提交内容，进入相邻单元格或退出到主文档。 */
  const navigateCell = (
    activeCellEditor: EditorView,
    direction: 'left' | 'right' | 'up' | 'down'
  ): boolean => {
    const { selection, doc } = activeCellEditor.state;
    if (selection.ranges.length !== 1 || !selection.main.empty) return false;
    const forward = direction === 'right' || direction === 'down';
    const vertical = direction === 'up' || direction === 'down';
    const boundary = forward ? doc.length : 0;
    const lineBoundary = vertical
      ? activeCellEditor.moveToLineBoundary(selection.main, forward, true).head
      : selection.main.head;
    if (lineBoundary !== boundary) return false;

    const block = collectTableBlocks(view.state).find((candidate) => (
      cell.from >= candidate.from && cell.from <= candidate.to
    ));
    if (!block) return false;
    const rows = [block.headers, ...block.rows];
    const rowIndex = rows.findIndex((row) => row.some((candidate) => candidate.from === cell.from));
    const columnIndex = rows[rowIndex]?.findIndex((candidate) => candidate.from === cell.from) ?? -1;
    if (rowIndex < 0 || columnIndex < 0) return false;
    const targetRow = rowIndex + (vertical ? (forward ? 1 : -1) : 0);
    const targetColumn = columnIndex + (vertical ? 0 : (forward ? 1 : -1));
    const hasTargetCell = rows[targetRow]?.[targetColumn] !== undefined;

    const cursorCoords = vertical ? activeCellEditor.coordsAtPos(selection.main.head) : null;
    commitEditingValue(doc.toString());
    // 提交会改变后续单元格的源码偏移，按行列重新读取目标，避免复用旧范围。
    const updatedBlock = collectTableBlocks(view.state).find((candidate) => candidate.from === block.from);
    if (!updatedBlock) return true;
    if (!hasTargetCell) {
      exitEditorTable(view, updatedBlock, forward);
      return true;
    }
    const targetCell = [updatedBlock.headers, ...updatedBlock.rows][targetRow]?.[targetColumn];
    if (!targetCell) return true;
    const targetEditor = focusEditorTableCell(
      view,
      targetCell,
      forward ? 0 : resolveTableCellDisplayValue(targetCell.value).length
    );
    if (targetEditor && cursorCoords) {
      const targetCoords = targetEditor.coordsAtPos(forward ? 0 : targetEditor.state.doc.length);
      const position = targetCoords ? targetEditor.posAtCoords({
        x: cursorCoords.left,
        y: (targetCoords.top + targetCoords.bottom) / 2
      }) : null;
      if (position !== null) {
        targetEditor.dispatch({ selection: { anchor: position }, scrollIntoView: true });
      }
    }
    return true;
  };

  editorHost.className = 'cm-editor-table__editor';
  replaceTableCellContent(cellElement, createTableCellLayout(editorHost, cell.value, view));
  cellEditor = new EditorView({
    parent: editorHost,
    state: EditorState.create({
      doc: initialEditingValue,
      selection: { anchor: initialEditingPosition ?? 0 },
      extensions: [
        markdown({
          addKeymap: false,
          htmlTagLanguage: editorHtmlLanguageSupport,
          extensions: [Strikethrough, markdownHighlightExtension]
        }),
        markdownInlineFormattingExtension,
        markdownInlineFormattingTheme,
        editorHtmlSourceHighlightExtension,
        syntaxHighlighting(editorHtmlHighlightStyle),
        drawSelection(),
        editorTableCellSelectionTheme,
        // 普通方向键负责单元格切换和表格退出，Shift 选区仍交给标准命令。
        keymap.of([
          { key: 'ArrowLeft', run: (activeEditor) => navigateCell(activeEditor, 'left') },
          { key: 'ArrowRight', run: (activeEditor) => navigateCell(activeEditor, 'right') },
          { key: 'ArrowUp', run: (activeEditor) => navigateCell(activeEditor, 'up') },
          { key: 'ArrowDown', run: (activeEditor) => navigateCell(activeEditor, 'down') },
          ...standardKeymap
        ]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) view.requestMeasure();
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            if (event.key !== 'Escape') return false;
            finishEditing(originalSourceValue);
            return true;
          },
          blur(_event, activeCellEditor) {
            queueMicrotask(() => {
              if (!activeCellEditor.hasFocus) {
                commitEditingValue(activeCellEditor.state.doc.toString());
              }
            });
            return false;
          }
        })
      ]
    })
  });
  tableCellEditorViews.set(editorHost, cellEditor);
  tableCellEditingFinishers.set(editorHost, () => {
    commitEditingValue(cellEditor?.state.doc.toString() ?? initialEditingValue);
  });
  syncTableCellEditingState(view);
  cellEditor.focus();
  syncTableCellEditingState(view);
  requestAnimationFrame(() => {
    if (!cellEditor) return;
    if (!cellEditor.hasFocus) {
      cellEditor.focus();
    }
    syncTableCellEditingState(view);
  });
  view.requestMeasure();
  return cellEditor;
}

/** 更新主选区后重新解析单元格 DOM，并启动指定位置的内嵌编辑器。 */
function focusEditorTableCell(view: EditorView, cell: TableCell, sourceOffset: number): EditorView | null {
  if (!view.state.selection.main.empty || view.state.selection.main.head !== cell.from) {
    view.dispatch({
      selection: { anchor: cell.from },
      userEvent: 'select.table-cell'
    });
  }
  const cellElement = resolveCurrentTableCellElement(view, cell.from);
  return cellElement ? editCell(cellElement, cell, view, sourceOffset) : null;
}

/** 只允许向可编辑且尚无图片的单元格插入附件，查询不改变编辑状态。 */
export function canInsertEditorTableCellImage(view: EditorView, target: EditorTableContextTarget): boolean {
  if (view.state.readOnly || target.axis !== 'cell') return false;
  const block = collectTableBlocks(view.state).find(candidate => candidate.from === target.tableFrom);
  const cell = (target.rowIndex === null ? block?.headers : block?.rows[target.rowIndex])?.[target.columnIndex];
  return !!cell && readTableCellImages(cell.value).length === 0;
}

/** 通过单元格附件通道插入唯一图片并立即呈现，不写入文字编辑器。 */
export function insertEditorTableCellImage(view: EditorView, target: EditorTableContextTarget, image: TableCellImage): void {
  if (!canInsertEditorTableCellImage(view, target) || !image.source?.trim() || image.source === 'undefined') return;
  finishActiveTableCellEditing(view, target.tableFrom);
  const block = collectTableBlocks(view.state).find((candidate) => candidate.from === target.tableFrom);
  const cell = (target.rowIndex === null ? block?.headers : block?.rows[target.rowIndex])?.[target.columnIndex];
  if (!cell || readTableCellImages(cell.value).length > 0) return;
  const value = writeTableCellImages(cell.value, [image]);
  view.dispatch({
    changes: { from: cell.from, to: cell.to, insert: value },
    selection: { anchor: cell.from },
    userEvent: 'input.table-image'
  });
  view.focus();
}

/** 打开图片菜单前提交单元格文字，随后按图片索引读取最新附件。 */
export function getEditorTableCellImage(
  view: EditorView, target: EditorTableContextTarget, imageIndex: number
): TableCellImage | undefined {
  finishActiveTableCellEditing(view, target.tableFrom);
  const block = collectTableBlocks(view.state).find(candidate => candidate.from === target.tableFrom);
  const cell = (target.rowIndex === null ? block?.headers : block?.rows[target.rowIndex])?.[target.columnIndex];
  return cell ? readTableCellImages(cell.value)[imageIndex] : undefined;
}

/** 通过主文档事务更新或删除指定附件，保留正文、其他图片和背景，支持撤销。 */
export function updateEditorTableCellImage(
  view: EditorView, target: EditorTableContextTarget, imageIndex: number, image: TableCellImage | null
): void {
  if (view.state.readOnly) return;
  finishActiveTableCellEditing(view, target.tableFrom);
  const block = collectTableBlocks(view.state).find(candidate => candidate.from === target.tableFrom);
  const cell = (target.rowIndex === null ? block?.headers : block?.rows[target.rowIndex])?.[target.columnIndex];
  if (!cell) return;
  const images = readTableCellImages(cell.value);
  if (!images[imageIndex]) return;
  images.splice(imageIndex, 1, ...(image ? [image] : []));
  view.dispatch({
    changes: { from: cell.from, to: cell.to, insert: writeTableCellImages(cell.value, images) },
    selection: { anchor: cell.from },
    annotations: isolateHistory.of('full'),
    userEvent: 'input.table-image'
  });
  view.focus();
}

/** 将主编辑器光标切换到指定表格的最后一个单元格行尾。 */
function focusLastEditorTableCell(view: EditorView, block: TableBlock): boolean {
  const lastRow = block.rows[block.rows.length - 1];
  const targetCell = lastRow?.[lastRow.length - 1]
    ?? block.headers[block.headers.length - 1];
  if (!targetCell) return false;
  return focusEditorTableCell(
    view,
    targetCell,
    resolveTableCellDisplayValue(targetCell.value).length
  ) !== null;
}

/** 从表格块后边界进入最后一个单元格，保护尾随换行与 EOF 源码。 */
function enterPreviousEditorTable(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;

  const previousTable = collectTableBlocks(view.state).find((block) => (
    getTableReplacementTo(view.state, block) === selection.main.head
  ));

  return previousTable ? focusLastEditorTableCell(view, previousTable) : false;
}

/** 从表格上方的最后一个显示行向下进入首个表头单元格。 */
function enterNextEditorTable(view: EditorView): boolean {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const line = view.state.doc.lineAt(selection.main.head);
  if (view.moveToLineBoundary(selection.main, true, true).head !== line.to) return false;

  const nextTable = collectTableBlocks(view.state).find((block) => (
    view.state.doc.lineAt(block.from).from === line.to + 1
  ));
  const firstCell = nextTable?.headers[0];
  return firstCell ? focusEditorTableCell(view, firstCell, 0) !== null : false;
}

/** 创建原生表格单元格。 */
function createTableCell(
  tagName: 'th' | 'td',
  cell: TableCell,
  alignment: TableBlock['alignments'][number],
  view: EditorView,
  background: string | null
): HTMLTableCellElement {
  const cellElement = document.createElement(tagName);

  if (background) cellElement.style.backgroundColor = background;
  cellElement.dataset.tableAlignment = alignment;
  cellElement.dataset.tableCellFrom = String(cell.from);
  renderCellContent(cellElement, cell, view);
  cellElement.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (
      event.button !== 0
      || (target instanceof Element && target.closest('.cm-editor-table__editor'))
    ) {
      return;
    }
    const scrollLeft = view.scrollDOM.scrollLeft;
    const scrollTop = view.scrollDOM.scrollTop;
    const initialPosition = resolveTableCellPointerSourcePosition(
      cellElement,
      cell.value,
      event.clientX,
      event.clientY
    );
    event.preventDefault();
    event.stopPropagation();
    if (!view.state.selection.main.empty || view.state.selection.main.head !== cell.from) {
      view.dispatch({
        selection: { anchor: cell.from },
        userEvent: 'select.table-cell'
      });
    }
    queueMicrotask(() => {
      const currentCellElement = resolveCurrentTableCellElement(view, cell.from);
      if (!currentCellElement) return;
      editCell(currentCellElement, cell, view, initialPosition);
      syncTableCellEditingState(view);
      preserveTableEditingScroll(view, scrollLeft, scrollTop);
    });
  });
  return cellElement;
}

/** 创建表头列拖拽图标与列重排交互。 */
function createColumnDragHandle(
  headerCell: HTMLTableCellElement,
  block: TableBlock,
  columnIndex: number,
  view: EditorView
): HTMLElement {
  const handle = document.createElement('span');
  const resolveTable = () => headerCell.closest('table');
  let pointerId: number | null = null;
  let pointerDragActive = false;
  let pointerStartX = 0;
  let pointerStartY = 0;

  handle.className = 'cm-editor-table__drag-handle';
  handle.innerHTML = dragHorizontalIcon;
  handle.draggable = false;
  handle.setAttribute('aria-label', '拖动列');
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const table = resolveTable();
    event.preventDefault();
    event.stopPropagation();
    pointerId = event.pointerId;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    pointerDragActive = false;
    handle.setPointerCapture(event.pointerId);
    if (table) {
      clearColumnDragState(table);
      setColumnDragState(table, columnIndex);
      table.dataset.columnDragSourceIndex = String(columnIndex);
      setTableDragCaretState(view, true);
    }
  });
  handle.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId) return;
    if (!pointerDragActive && Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) < 4) return;
    pointerDragActive = true;
    const table = resolveTable();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableCellElement>('th');
    if (!table || !target || !table.contains(target)) return;
    const sourceIndex = Number(table.dataset.columnDragSourceIndex);
    const targetState = event.clientX < target.getBoundingClientRect().left + target.offsetWidth / 2
      ? 'drop-before'
      : 'drop-after';
    clearColumnDragState(table);
    if (Number.isInteger(sourceIndex)) setColumnDragState(table, sourceIndex);
    const boundaryIndex = target.cellIndex + (targetState === 'drop-after' ? 1 : 0);
    if (boundaryIndex !== sourceIndex && boundaryIndex !== sourceIndex + 1) {
      setColumnDropIndicator(table, target, targetState === 'drop-before' ? 'before' : 'after');
    }
  });
  handle.addEventListener('pointerup', (event) => {
    if (pointerId !== event.pointerId) return;
    const table = resolveTable();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableCellElement>('th');
    const sourceIndex = table ? Number(table.dataset.columnDragSourceIndex) : Number.NaN;
    if (pointerDragActive && table && target && table.contains(target) && Number.isInteger(sourceIndex)) {
      const targetInsertionIndex = target.cellIndex + (
        event.clientX >= target.getBoundingClientRect().left + target.offsetWidth / 2 ? 1 : 0
      );
      moveTableColumn(view, block, sourceIndex, targetInsertionIndex);
    }
    if (table) {
      clearColumnDragState(table);
      delete table.dataset.columnDragSourceIndex;
    }
    setTableDragCaretState(view, false);
    pointerId = null;
    pointerDragActive = false;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  });
  handle.addEventListener('pointercancel', () => {
    const table = resolveTable();
    if (table) {
      clearColumnDragState(table);
      delete table.dataset.columnDragSourceIndex;
    }
    setTableDragCaretState(view, false);
    pointerId = null;
    pointerDragActive = false;
  });

  return handle;
}

/** 创建数据行左侧拖拽手柄与行重排交互。 */
function createRowDragHandle(
  rowElement: HTMLTableRowElement,
  block: TableBlock,
  rowIndex: number,
  view: EditorView
): HTMLElement {
  const handle = document.createElement('span');
  const resolveTable = () => rowElement.closest('table');
  let pointerId: number | null = null;
  let pointerDragActive = false;
  let pointerStartX = 0;
  let pointerStartY = 0;

  handle.className = 'cm-editor-table__row-drag-handle';
  handle.innerHTML = dragVerticalIcon;
  handle.draggable = false;
  handle.setAttribute('aria-label', '拖动行');
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const table = resolveTable();
    event.preventDefault();
    event.stopPropagation();
    pointerId = event.pointerId;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    pointerDragActive = false;
    handle.setPointerCapture(event.pointerId);
    if (table) {
      clearColumnDragState(table);
      setRowDragState(table, rowIndex);
      table.dataset.rowDragSourceIndex = String(rowIndex);
      setTableDragCaretState(view, true);
    }
  });
  handle.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId) return;
    if (!pointerDragActive && Math.hypot(event.clientX - pointerStartX, event.clientY - pointerStartY) < 4) return;
    pointerDragActive = true;
    const table = resolveTable();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableRowElement>('tbody tr');
    if (!table || !target || !table.contains(target)) return;
    const sourceIndex = Number(table.dataset.rowDragSourceIndex);
    const targetState = event.clientY < target.getBoundingClientRect().top + target.offsetHeight / 2
      ? 'before'
      : 'after';
    clearColumnDragState(table);
    if (Number.isInteger(sourceIndex)) setRowDragState(table, sourceIndex);
    table.dataset.rowDragSourceIndex = String(sourceIndex);
    const targetIndex = Array.from(table.tBodies[0]?.rows ?? []).indexOf(target);
    const boundaryIndex = targetIndex + (targetState === 'after' ? 1 : 0);
    if (targetIndex >= 0 && boundaryIndex !== sourceIndex && boundaryIndex !== sourceIndex + 1) {
      setRowDropIndicator(table, target, targetState);
    }
  });
  handle.addEventListener('pointerup', (event) => {
    if (pointerId !== event.pointerId) return;
    const table = resolveTable();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableRowElement>('tbody tr');
    const sourceIndex = table ? Number(table.dataset.rowDragSourceIndex) : Number.NaN;
    if (pointerDragActive && table && target && table.contains(target) && Number.isInteger(sourceIndex)) {
      const targetIndex = Array.from(table.tBodies[0]?.rows ?? []).indexOf(target);
      const insertionIndex = targetIndex + (
        event.clientY >= target.getBoundingClientRect().top + target.offsetHeight / 2 ? 1 : 0
      );
      if (targetIndex >= 0) moveTableRow(view, block, sourceIndex, insertionIndex);
    }
    if (table) clearColumnDragState(table);
    setTableDragCaretState(view, false);
    pointerId = null;
    pointerDragActive = false;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  });
  handle.addEventListener('pointercancel', () => {
    const table = resolveTable();
    if (table) clearColumnDragState(table);
    setTableDragCaretState(view, false);
    pointerId = null;
    pointerDragActive = false;
  });
  return handle;
}

/** 创建表格新增行或新增列按钮。 */
function createTableAddButton(
  type: 'row' | 'column',
  block: TableBlock,
  view: EditorView
): HTMLButtonElement {
  const button = document.createElement('button');
  const label = type === 'row' ? '新增行' : '新增列';
  button.className = `cm-editor-table__add-button cm-editor-table__add-button--${type}`;
  button.type = 'button';
  button.innerHTML = addIcon;
  button.setAttribute('aria-label', label);
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    finishActiveTableCellEditing(view, block.from);
    const currentBlock = collectTableBlocks(view.state).find(
      (tableBlock) => tableBlock.from === block.from
    );
    if (!currentBlock) {
      return;
    }
    const scrollSnapshot = view.scrollSnapshot();
    if (type === 'row') {
      addTableRow(view, currentBlock, scrollSnapshot);
    } else {
      addTableColumn(view, currentBlock, scrollSnapshot);
    }
  });
  return button;
}

/** 原生 HTML 表格块 Widget。 */
class EditorTableWidget extends WidgetType {
  private resizeObserver: ResizeObserver | null = null;
  private measureFrame: number | null = null;
  private scrollbarApp: VueApp | null = null;
  private readonly fingerprint: string;

  /** 创建表格 Widget。 */
  public constructor(
    private readonly block: TableBlock,
    private readonly selected: boolean
  ) {
    super();
    this.fingerprint = createTableBlockFingerprint(block);
  }

  /** 比较表格范围，避免未变化时重建 DOM。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorTableWidget
      && widget.selected === this.selected
      && widget.fingerprint === this.fingerprint;
  }

  /** 创建原生表格及横向滚动区域，内部块保留拖拽和新增按钮的定位空间。 */
  public override toDOM(view: EditorView): HTMLElement {
    const shell = document.createElement('div');
    const scrollContainer = document.createElement('div');
    const scrollbarHost = document.createElement('div');
    const tableBlock = document.createElement('div');
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const body = document.createElement('tbody');

    shell.className = 'cm-editor-table-shell';
    scrollContainer.className = 'cm-editor-table-scroll';
    scrollbarHost.className = 'cm-editor-table-scrollbar';
    tableBlock.className = 'cm-editor-table-block';
    applyEditorBlockVisualState(tableBlock, this.selected, false);
    table.className = 'cm-editor-table';
    table.dataset.tableFrom = String(this.block.from);
    this.block.headers.forEach((cell, index) => {
      const headerCell = createTableCell(
        'th', cell, this.block.alignments[index] ?? 'left', view, resolveTableColumnBackground(cell.value)
      );
      const hasPlaceholderDataCells = this.block.rows.length > 0
        && this.block.rows.every((row) => !hasTableCellContent(row[index]?.value ?? ''));
      if (!hasTableCellContent(cell.value) || hasPlaceholderDataCells) {
        headerCell.classList.add('cm-editor-table__new-column');
      }
      headerCell.append(createColumnDragHandle(headerCell, this.block, index, view));
      headRow.append(headerCell);
    });
    head.append(headRow);

    this.block.rows.forEach((row) => {
      const rowElement = document.createElement('tr');
      const rowBackground = resolveTableRowBackground(row.map((cell) => cell.value));
      if (row.every((cell) => !hasTableCellContent(cell.value))) {
        rowElement.classList.add('cm-editor-table__new-row');
      }
      row.forEach((cell, index) => {
        const cellElement = createTableCell(
          'td', cell, this.block.alignments[index] ?? 'left', view,
          rowBackground ?? resolveTableColumnBackground(this.block.headers[index]?.value ?? '')
        );
        if (index === 0) {
          cellElement.append(createRowDragHandle(rowElement, this.block, body.rows.length, view));
        }
        rowElement.append(cellElement);
      });
      body.append(rowElement);
    });

    table.append(head, body);
    tableBlock.append(
      table,
      createTableAddButton('row', this.block, view),
      createTableAddButton('column', this.block, view)
    );
    scrollContainer.append(tableBlock);
    shell.append(scrollContainer, scrollbarHost);
    this.scrollbarApp = createApp(WorkbenchHorizontalScrollbar, {
      scrollerElement: scrollContainer
    });
    this.scrollbarApp.mount(scrollbarHost);
    const pendingFocus = pendingTableCellFocus.get(view);
    if (pendingFocus?.tableFrom === this.block.from) {
      pendingTableCellFocus.delete(view);
      const targetCell = pendingFocus.target === 'new-row'
        ? body.rows.item(body.rows.length - 1)?.cells.item(0)
        : pendingFocus.target === 'new-column'
          ? headRow.cells.item(headRow.cells.length - 1)
          : headRow.cells.item(0);
      requestAnimationFrame(() => {
        targetCell?.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true,
          button: 0
        }));
      });
    }
    tableBlock.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        syncTableCellEditingState(view);
        if (!view.dom.classList.contains('cm-table-cell-editing')) {
          view.requestMeasure();
        }
      });
    });
    this.resizeObserver = new ResizeObserver(() => {
      if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame);
      // Let table layout and container-query wrapping settle before CodeMirror
      // reads the block height for its document height map.
      this.measureFrame = requestAnimationFrame(() => {
        this.measureFrame = requestAnimationFrame(() => {
          this.measureFrame = null;
          if (view.dom.isConnected) view.requestMeasure();
        });
      });
    });
    this.resizeObserver.observe(tableBlock);
    this.resizeObserver.observe(shell);
    this.resizeObserver.observe(scrollContainer);
    return shell;
  }

  /** 更新同一表格时复用滚动容器，避免提交单元格或新增列后跳回最左侧。 */
  public override updateDOM(dom: HTMLElement, view: EditorView, previous: this): boolean {
    const table = dom.querySelector<HTMLTableElement>('.cm-editor-table');
    if (table) table.dataset.tableFrom = String(this.block.from);
    if (previous.fingerprint === this.fingerprint && previous.selected === this.selected) return true;
    const scrollLeft = dom.querySelector('.cm-editor-table-scroll')?.scrollLeft ?? 0;
    const updatedContainer = this.toDOM(view);
    previous.destroy();
    dom.replaceChildren(...Array.from(updatedContainer.childNodes));
    this.resizeObserver?.unobserve(updatedContainer);
    this.resizeObserver?.observe(dom);
    const scroller = dom.querySelector('.cm-editor-table-scroll');
    if (scroller) scroller.scrollLeft = scrollLeft;
    return true;
  }

  /** 清理表格高度监听、滚动条组件及其观察器和事件。 */
  public override destroy(): void {
    this.scrollbarApp?.unmount();
    this.scrollbarApp = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.measureFrame !== null) {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = null;
    }
  }

  /** 将表格内部事件交给原生控件处理。 */
  public override ignoreEvent(): boolean {
    return true;
  }
}

/** 使用 CodeMirror 官方 Widget 行号标记对齐表格顶部。 */
const editorTableLineNumberExtension = lineNumberWidgetMarker.of((
  view: EditorView,
  widget: WidgetType,
  block: BlockInfo
) => {
  if (!(widget instanceof EditorTableWidget)) {
    return null;
  }

  return new EditorTableLineNumberMarker(view.state.doc.lineAt(block.from).number);
});

/** 创建表格块替换装饰与尾随空行 Widget。 */
function buildEditorTableDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];

  collectTableBlocks(state).forEach((block) => {
    const replacementTo = getTableReplacementTo(state, block);
    const selected = state.selection.ranges.some(
      (range) => !range.empty && range.from < replacementTo && range.to > block.from
    );
    decorations.push(Decoration.replace({
      widget: new EditorTableWidget(block, selected),
      block: true,
      inclusiveStart: true,
      inclusiveEnd: false
    }).range(block.from, replacementTo));

    const tableEndLine = state.doc.lineAt(block.to);
    if (tableEndLine.number < state.doc.lines) {
      const trailingLine = state.doc.lineAt(replacementTo);
      if (trailingLine.length === 0) {
        decorations.push(Decoration.widget({
          widget: new EditorTableTrailingLineWidget(),
          side: 1
        }).range(trailingLine.from));
      }
    }
  });

  return Decoration.set(decorations, true);
}

/** 复用官方表格解析规则，识别当前段落开头是否已形成有效表头。 */
const tableBoundaryParser = parser.configure(Table);
const tableBlockParser = Table.parseBlock?.[0];

/** 修正官方 Table 候选解析器失败后仍阻止后续表格中断段落的情况。 */
export const editorTableMarkdownExtension: MarkdownExtension = [Table, {
  parseBlock: [{
    name: 'EditorTableParagraphBoundary',
    endLeaf(context, line, leaf) {
      // 先由官方规则验证新表头、分隔行及列数，仅跳过失效候选解析器的拦截。
      if (!tableBlockParser?.endLeaf?.(context, line, { ...leaf, parsers: [] })) {
        return false;
      }
      const lines = leaf.content.split('\n');
      const headerTree = tableBoundaryParser.parse(
        [...lines, line.text.slice(line.pos)].slice(0, 2).join('\n')
      );
      if (headerTree.topNode.firstChild?.name !== 'Table') {
        return true;
      }
      // 已形成的表格继续接收管道数据行；普通文本后的新表格应独立解析。
      return lines.slice(2).some((content) => (
        !tableBlockParser.leaf?.(context, { ...leaf, content, parsers: [] })
      ));
    }
  }]
}];

/** Markdown 表格块状态字段。 */
const editorTableBlockStateField = StateField.define<DecorationSet>({
  create: buildEditorTableDecorations,
  update(decorations, transaction) {
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    // 后台解析也会更新语法树，即使文档和选区都未变化也要恢复表格装饰。
    const syntaxChanged = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
    return transaction.docChanged || selectionChanged || syntaxChanged
      ? buildEditorTableDecorations(transaction.state)
      : decorations;
  },
  provide(field) {
    return EditorView.decorations.from(field);
  }
});

/** 在编辑器更新后规范化表格空单元格。 */
const editorTableMaintenanceExtension = ViewPlugin.fromClass(class {
  private cleanupScheduled = false;

  /** 创建清理控制器并检查初始文档。 */
  public constructor(private readonly view: EditorView) {
    this.scheduleCleanup();
  }

  /** 文档变化时安排下一次表格维护。 */
  public update(update: { readonly docChanged: boolean }): void {
    if (update.docChanged) {
      this.scheduleCleanup();
    }
  }

  /** 在当前 CodeMirror 更新完成后执行清理。 */
  private scheduleCleanup(): void {
    if (this.cleanupScheduled) return;
    this.cleanupScheduled = true;
    queueMicrotask(() => {
      this.cleanupScheduled = false;
      normalizeEmptyTableCells(this.view);
    });
  }
});

/** The editor viewport can shrink while a table keeps its intrinsic width; refresh
 * CodeMirror's block height map after responsive cell wrapping settles. */
const editorTableViewportMeasureExtension = ViewPlugin.fromClass(class {
  private readonly resizeObserver: ResizeObserver;
  private measureFrame: number | null = null;

  public constructor(private readonly view: EditorView) {
    this.resizeObserver = new ResizeObserver(() => this.scheduleMeasure());
    this.resizeObserver.observe(view.scrollDOM);
  }

  public destroy(): void {
    this.resizeObserver.disconnect();
    if (this.measureFrame !== null) {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = null;
    }
  }

  private scheduleMeasure(): void {
    if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame);
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = requestAnimationFrame(() => {
        this.measureFrame = null;
        if (this.view.dom.isConnected) this.view.requestMeasure();
      });
    });
  }
});

/** 文档前方内容变化时，同步复用表格 DOM 上用于菜单定位的源码位置。 */
const editorTableDomPositionExtension = ViewPlugin.fromClass(class {
  public update(update: ViewUpdate): void {
    if (!update.docChanged) return;

    const blocks = collectTableBlocks(update.view.state);
    const tables = update.view.dom.querySelectorAll<HTMLTableElement>('.cm-editor-table');
    tables.forEach((table, tableIndex) => {
      const block = blocks[tableIndex];
      if (!block) return;
      table.dataset.tableFrom = String(block.from);
      const cells = [
        ...block.headers,
        ...block.rows.flat()
      ];
      table.querySelectorAll<HTMLElement>('[data-table-cell-from]').forEach((cell, cellIndex) => {
        const currentCell = cells[cellIndex];
        if (currentCell) cell.dataset.tableCellFrom = String(currentCell.from);
      });
    });
  }
});

/** 从实际表格装饰派生光标状态，后台解析生成 Widget 时也同步更新。 */
const editorTableCursorAttributesExtension = EditorView.editorAttributes.compute(
  [editorTableBlockStateField, 'selection'],
  (state) => {
    const selectionHead = state.selection.main.head;
    let isCursorInsideTable = false;
    state.field(editorTableBlockStateField).between(selectionHead, selectionHead, (from, to, decoration) => {
      if (decoration.spec.widget instanceof EditorTableWidget
        && selectionHead >= from && selectionHead < to) {
        isCursorInsideTable = true;
      }
    });
    // 没有尾随换行的文末表格，其文档终点仍映射到 Widget 右侧；隐藏这个伪光标，避免出现整表高度的竖线。
    if (!isCursorInsideTable && selectionHead === state.doc.length) {
      isCursorInsideTable = collectTableBlocks(state).some((block) => block.to === state.doc.length);
    }
    return {
      class: isCursorInsideTable ? 'cm-table-block-cursor-hidden' : ''
    };
  }
);

/** 补全菜单优先处理上下键，关闭菜单后才进入表格；后边界退格保留最高优先级。 */
const editorTableBoundaryNavigationExtension = [
  Prec.high(keymap.of([
    // 补全查询或交互延迟期间也保留焦点，避免方向键落入表格或移动文档光标。
    { key: 'ArrowUp', run: (view) => completionStatus(view.state) !== null || enterPreviousEditorTable(view) },
    { key: 'ArrowDown', run: (view) => completionStatus(view.state) !== null || enterNextEditorTable(view) }
  ])),
  Prec.highest(keymap.of([
    { key: 'Backspace', run: enterPreviousEditorTable }
  ]))
];

/** 表格编辑期间隐藏主编辑器的文档光标与活动行背景。 */
const editorTableFocusTheme = EditorView.theme({
  '&.cm-table-block-cursor-hidden > .cm-scroller > .cm-cursorLayer .cm-cursor, &.cm-table-block-cursor-hidden > .cm-scroller > .cm-dropCursor': {
    display: 'none'
  },
  '&.cm-table-cell-editing > .cm-scroller > .cm-cursorLayer .cm-cursor, &.cm-table-cell-editing > .cm-scroller > .cm-dropCursor': {
    display: 'none'
  },
  '&.cm-table-cell-editing > .cm-scroller > .cm-content > .cm-activeLine': {
    backgroundColor: 'transparent'
  },
  '&.cm-table-column-dragging .cm-dropCursor': {
    display: 'none !important'
  }
});

/** Markdown 原生表格扩展。 */
export const editorTableBlockExtension = [
  tableImageContextTargetField,
  tableImageContextHighlightExtension,
  editorTableBlockStateField,
  editorTableMaintenanceExtension,
  editorTableViewportMeasureExtension,
  editorTableDomPositionExtension,
  editorTableLineNumberExtension,
  editorTableCursorAttributesExtension,
  editorTableBoundaryNavigationExtension,
  editorTableFocusTheme
];

/** 创建带文档路径上下文的表格扩展，复用宿主媒体协议加载单元格图片。 */
export function createEditorTableBlockExtension(getCurrentFilePath: () => string | undefined) {
  return [editorTableCurrentFilePath.of(getCurrentFilePath), editorTableBlockExtension];
}
