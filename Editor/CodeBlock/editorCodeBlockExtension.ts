/**
 * 文件说明：使用 CodeMirror 官方 BlockWrapper 将 Markdown 围栏代码组织为可原生编辑的独立代码块。
 */
import {
  Prec,
  Range,
  StateField,
  countColumn,
  type EditorState,
  type RangeSet
} from '@codemirror/state';
import {
  BlockWrapper,
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType
} from '@codemirror/view';
import { foldService } from '@codemirror/language';
import { createEditorBlockClassName } from '@editor/Block/editorBlockSpacing';
import { editorSpaceWidthExtension } from '../Core/editorSpaceWidthExtension';

interface EditorCodeBlockMatch {
  readonly from: number;
  readonly to: number;
  readonly openingIndentColumns: number;
  readonly openingFenceFrom: number;
  readonly openingFenceTo: number;
  readonly openingTo: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly closingFrom: number;
  readonly closingFenceFrom: number;
  readonly closingFenceTo: number;
  readonly language: string;
  readonly key: string;
}

interface EditorCodeBlockState {
  readonly wrappers: RangeSet<BlockWrapper>;
  readonly decorations: DecorationSet;
  readonly atomicRanges: DecorationSet;
}

/** 判断整行内容是否为代码块开始或结束围栏。 */
export function isEditorCodeBlockFenceLine(lineText: string): boolean {
  return /^\s*(?:`{3,}|~{3,})(?:\s*[^\s]*)?\s*$/.test(lineText);
}

/** 计算代码行前导空白的视觉列数。 */
function measureCodeBlockIndent(lineText: string, tabSize: number): number {
  const indentation = /^[\t ]*/.exec(lineText)?.[0] ?? '';
  return countColumn(indentation, tabSize);
}

/** 创建仅隐藏围栏行源码字符并保留换行的行内替换装饰。 */
function createHiddenCodeFenceSource(
  state: EditorState,
  lineFrom: number
): Range<Decoration> {
  const line = state.doc.lineAt(lineFrom);

  return Decoration.replace({
    inclusiveStart: false,
    inclusiveEnd: false
  }).range(line.from, line.to);
}

/** 代码块右侧语言标签 Widget。 */
class EditorCodeBlockLanguageWidget extends WidgetType {
  /** 创建语言标签 Widget。 */
  public constructor(private readonly language: string) {
    super();
  }

  /** 判断语言标签内容是否相同。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorCodeBlockLanguageWidget
      && widget.language === this.language;
  }

  /** 创建右侧语言标签。 */
  public override toDOM(): HTMLElement {
    const label = document.createElement('span');
    label.className = 'cm-editor-code-block__language';
    label.textContent = this.language.toUpperCase();
    return label;
  }

  /** 语言标签不接管编辑器事件。 */
  public override ignoreEvent(): boolean {
    return true;
  }
}

/** 扫描 Markdown 文档并收集闭合的围栏代码块。 */
function collectEditorCodeBlockMatches(state: EditorState): EditorCodeBlockMatch[] {
  const matches: EditorCodeBlockMatch[] = [];
  let openingLineNumber: number | null = null;
  let openingFence = '';
  let openingInlineOffset = 0;
  let language = '';

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);

    if (openingLineNumber === null) {
      const openingMatch = /^\s*(`{3,}|~{3,})\s*([^\s]*)\s*$/.exec(line.text);

      if (!openingMatch) {
        continue;
      }

      openingLineNumber = lineNumber;
      openingFence = openingMatch[1];
      openingInlineOffset = line.text.indexOf(openingFence);
      language = openingMatch[2];
      continue;
    }

    const closingPattern = new RegExp(`^(\\s*)(${openingFence[0]}{${openingFence.length},})\\s*$`);
    const closingMatch = closingPattern.exec(line.text);

    if (!closingMatch) {
      continue;
    }

    const openingLine = state.doc.line(openingLineNumber);
    const contentFrom = openingLine.to < state.doc.length ? openingLine.to + 1 : openingLine.to;
    const contentTo = Math.max(contentFrom, line.from - 1);

    matches.push({
      from: openingLine.from,
      to: line.to,
      openingIndentColumns: measureCodeBlockIndent(openingLine.text, state.tabSize),
      openingFenceFrom: openingLine.from + openingInlineOffset,
      openingFenceTo: openingLine.from + openingInlineOffset + openingFence.length,
      openingTo: openingLine.to,
      contentFrom,
      contentTo,
      closingFrom: line.from,
      closingFenceFrom: line.from + closingMatch[1].length,
      closingFenceTo: line.from + closingMatch[1].length + closingMatch[2].length,
      language,
      key: String(openingLine.from)
    });
    openingLineNumber = null;
    openingFence = '';
    openingInlineOffset = 0;
    language = '';
  }

  return matches;
}

/** 判断指定文档行是否位于已闭合的围栏代码块中。 */
export function isEditorCodeBlockLine(state: EditorState, lineNumber: number): boolean {
  const line = state.doc.line(lineNumber);
  return collectEditorCodeBlockMatches(state).some(
    (match) => line.from >= match.from && line.to <= match.to
  );
}

/** 根据文档与折叠状态构建 BlockWrapper 和控件装饰。 */
function buildEditorCodeBlockState(
  state: EditorState
): EditorCodeBlockState {
  const wrappers: Range<BlockWrapper>[] = [];
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const selection = state.selection.main;

  collectEditorCodeBlockMatches(state).forEach((match) => {
    const active = selection.to >= match.from && selection.from <= match.to;
    const openingLineNumber = state.doc.lineAt(match.from).number;
    const closingLineNumber = state.doc.lineAt(match.to).number;

    wrappers.push(BlockWrapper.create({
      tagName: 'section',
      attributes: {
        class: createEditorBlockClassName(['cm-editor-code-block'], true),
        style: `--workbench-editor-code-block-inline-offset: calc(var(--workbench-editor-space-width) * ${match.openingIndentColumns})`
      }
    }).range(match.from, match.to));

    for (
      let lineNumber = openingLineNumber;
      lineNumber <= closingLineNumber;
      lineNumber += 1
    ) {
      const line = state.doc.line(lineNumber);
      const compensatedIndent = Math.min(
        measureCodeBlockIndent(line.text, state.tabSize),
        match.openingIndentColumns
      );

      decorations.push(Decoration.line({
        attributes: {
          class: 'cm-editor-code-block__line',
          style: `--workbench-editor-code-block-line-indent: calc(var(--workbench-editor-space-width) * ${compensatedIndent})`
        }
      }).range(line.from));
    }

    if (match.language) {
      decorations.push(Decoration.mark({
        class: 'cm-editor-code-block__language-source'
      }).range(match.openingTo - match.language.length, match.openingTo));
      decorations.push(Decoration.widget({
        widget: new EditorCodeBlockLanguageWidget(match.language),
        side: 1
      }).range(match.contentFrom));
    }

    if (active) {
      decorations.push(
        Decoration.mark({ class: 'cm-editor-code-block__fence-source' }).range(
          match.openingFenceFrom,
          match.openingFenceTo
        ),
        Decoration.mark({ class: 'cm-editor-code-block__fence-source' }).range(
          match.closingFenceFrom,
          match.closingFenceTo
        )
      );
    }

    if (!active) {
      const hiddenOpeningFence = createHiddenCodeFenceSource(state, match.from);
      const hiddenClosingFence = createHiddenCodeFenceSource(state, match.closingFrom);

      decorations.push(hiddenOpeningFence, hiddenClosingFence);
      atomicRanges.push(hiddenOpeningFence, hiddenClosingFence);
    }

  });

  return {
    wrappers: BlockWrapper.set(wrappers, true),
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomicRanges, true)
  };
}

/** 仅折叠围栏内部代码内容，保留开始与闭合围栏。 */
const editorCodeBlockFoldService = foldService.of((state, lineStart) => {
  const match = collectEditorCodeBlockMatches(state).find((block) => block.from === lineStart);

  if (!match || match.contentFrom >= match.contentTo) {
    return null;
  }

  return {
    from: match.openingTo,
    to: match.contentTo
  };
});

const editorCodeBlockStateField = StateField.define<EditorCodeBlockState>({
  /** 初始化代码块包装与装饰状态。 */
  create(state) {
    return buildEditorCodeBlockState(state);
  },

  /** 在文档、选区或制表符宽度变化时更新代码块包装与装饰。 */
  update(value, transaction) {
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    return transaction.docChanged || selectionChanged
      || transaction.startState.tabSize !== transaction.state.tabSize
      ? buildEditorCodeBlockState(transaction.state)
      : value;
  },

  provide(field) {
    return [
      EditorView.blockWrappers.from(field, (value) => value.wrappers),
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
    ];
  }
});

/** 官方 BlockWrapper 代码块扩展。 */
export const editorCodeBlockExtension = [
  editorSpaceWidthExtension,
  Prec.high(editorCodeBlockFoldService),
  editorCodeBlockStateField
];
