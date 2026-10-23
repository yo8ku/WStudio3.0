/**
 * 文件说明：识别 Markdown 行内与块级公式语法，使用 KaTeX 实时渲染公式预览。
 */
import {
  EditorSelection,
  StateField,
  type EditorState,
  type Range
} from '@codemirror/state';
import {
  type BlockInfo,
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  lineNumberWidgetMarker,
  WidgetType
} from '@codemirror/view';
import { createEditorBlockNavigationExtension } from '@editor/Block/editorBlockNavigationExtension';
import { createEditorBlockClassName } from '@editor/Block/editorBlockSpacing';
import type { EditorBlockSourceRange } from '@editor/Block/editorBlockTypes';

type KatexApi = typeof import('katex').default;

let katexApiPromise: Promise<KatexApi> | undefined;

/** 仅在文档实际包含数学公式时加载 KaTeX 运行时和样式。 */
function loadKatex(): Promise<KatexApi> {
  katexApiPromise ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css')
  ]).then(([module]) => module.default);
  return katexApiPromise;
}

/** 异步渲染公式；加载失败时保留原公式，避免创建空白块。 */
function renderKatex(expression: string, target: HTMLElement, displayMode: boolean): void {
  target.textContent = expression;
  void loadKatex().then((katex) => {
    if (!target.isConnected) return;
    katex.render(expression, target, {
      displayMode,
      output: 'htmlAndMathml',
      strict: false,
      throwOnError: false
    });
  }).catch(() => {
    if (target.isConnected) target.textContent = expression;
  });
}

/** 已闭合 Markdown 公式块的文档范围与公式内容。 */
interface EditorMathBlockMatch {
  readonly from: number;
  readonly to: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly openingDelimiterFrom: number;
  readonly openingDelimiterTo: number;
  readonly closingDelimiterFrom: number;
  readonly closingDelimiterTo: number;
  readonly expression: string;
}

/** 已闭合 Markdown 行内公式的文档范围与公式内容。 */
interface EditorInlineMathMatch {
  readonly from: number;
  readonly to: number;
  readonly expression: string;
}

/** 数学公式扩展统一维护的可见装饰与原子范围。 */
interface EditorMathState {
  readonly decorations: DecorationSet;
  readonly atomicRanges: DecorationSet;
  readonly renderedBlocks: readonly EditorBlockSourceRange[];
}

const EDITOR_MATH_BLOCK_PASTE_PATTERN = /(?:^|\r?\n)\s*\$\$\s*\r?\n[\s\S]*?\r?\n\s*\$\$\s*(?=\r?\n|$)/;
const ESCAPED_LATEX_COMMAND_PATTERN = /\\\\(?=[A-Za-z])/g;
const ESCAPED_MATH_BRACKET_PATTERN = /\\([\[\]])/g;

/** 还原数学块中的 Markdown 方括号转义，并按需处理 JSON 风格 LaTeX 转义。 */
function normalizeEscapedMathBlockPaste(source: string): string {
  const normalizedBrackets = source.replace(ESCAPED_MATH_BRACKET_PATTERN, '$1');
  if (source.search(ESCAPED_LATEX_COMMAND_PATTERN) === -1) {
    return normalizedBrackets;
  }

  return normalizedBrackets
    .replace(ESCAPED_LATEX_COMMAND_PATTERN, '\\')
    .replace(/\\_/g, '_');
}

/** 判断当前行是否为 Markdown 围栏代码块的开始行。 */
function getCodeFenceMarker(lineText: string): string | null {
  return /^\s*(`{3,}|~{3,})/.exec(lineText)?.[1] ?? null;
}

/** 判断当前行是否关闭指定的 Markdown 围栏代码块。 */
function isCodeFenceClosingLine(lineText: string, openingMarker: string): boolean {
  const markerCharacter = openingMarker[0];
  const closingPattern = new RegExp(`^\\s*${markerCharacter}{${openingMarker.length},}\\s*$`);
  return closingPattern.test(lineText);
}

/** 扫描单行及多行 $$ 公式块，并排除围栏代码中的同名文本。 */
function collectEditorMathBlockMatches(state: EditorState): EditorMathBlockMatch[] {
  const matches: EditorMathBlockMatch[] = [];
  let codeFenceMarker: string | null = null;

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);

    if (codeFenceMarker !== null) {
      if (isCodeFenceClosingLine(line.text, codeFenceMarker)) {
        codeFenceMarker = null;
      }
      continue;
    }

    codeFenceMarker = getCodeFenceMarker(line.text);
    if (codeFenceMarker !== null) {
      continue;
    }

    const singleLineMatch = /^\s*\$\$(.+?)\$\$\s*$/.exec(line.text);
    if (singleLineMatch) {
      const openingDelimiterOffset = line.text.indexOf('$$');
      const closingDelimiterOffset = line.text.lastIndexOf('$$');
      matches.push({
        from: line.from,
        to: line.to,
        contentFrom: line.from + openingDelimiterOffset + 2,
        contentTo: line.from + closingDelimiterOffset,
        openingDelimiterFrom: line.from + openingDelimiterOffset,
        openingDelimiterTo: line.from + openingDelimiterOffset + 2,
        closingDelimiterFrom: line.from + closingDelimiterOffset,
        closingDelimiterTo: line.from + closingDelimiterOffset + 2,
        expression: singleLineMatch[1].trim()
      });
      continue;
    }

    if (!/^\s*\$\$\s*$/.test(line.text)) {
      continue;
    }

    const expressionLines: string[] = [];
    let closingLineNumber: number | null = null;

    for (let candidateLineNumber = lineNumber + 1; candidateLineNumber <= state.doc.lines; candidateLineNumber += 1) {
      const candidateLine = state.doc.line(candidateLineNumber);
      if (/^\s*\$\$\s*$/.test(candidateLine.text)) {
        closingLineNumber = candidateLineNumber;
        break;
      }
      expressionLines.push(candidateLine.text);
    }

    if (closingLineNumber === null) {
      continue;
    }

    const closingLine = state.doc.line(closingLineNumber);
    const openingDelimiterOffset = line.text.indexOf('$$');
    const closingDelimiterOffset = closingLine.text.indexOf('$$');
    const contentFrom = line.to < state.doc.length ? line.to + 1 : line.to;
    matches.push({
      from: line.from,
      to: closingLine.to,
      contentFrom,
      contentTo: Math.max(contentFrom, closingLine.from - 1),
      openingDelimiterFrom: line.from + openingDelimiterOffset,
      openingDelimiterTo: line.from + openingDelimiterOffset + 2,
      closingDelimiterFrom: closingLine.from + closingDelimiterOffset,
      closingDelimiterTo: closingLine.from + closingDelimiterOffset + 2,
      expression: expressionLines.join('\n').trim()
    });
    lineNumber = closingLineNumber;
  }

  return matches;
}

/** 判断指定字符是否被奇数个反斜杠转义。 */
function isEscapedCharacter(source: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/** 获取从指定位置开始的连续反引号数量。 */
function getBacktickRunLength(source: string, from: number): number {
  let to = from;
  while (to < source.length && source[to] === '`') {
    to += 1;
  }
  return to - from;
}

/** 扫描行内 $...$ 公式，排除代码围栏、行内代码、转义符号和块级公式。 */
function collectEditorInlineMathMatches(
  state: EditorState,
  blockMatches: readonly EditorMathBlockMatch[]
): EditorInlineMathMatch[] {
  const matches: EditorInlineMathMatch[] = [];
  let codeFenceMarker: string | null = null;

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);

    if (codeFenceMarker !== null) {
      if (isCodeFenceClosingLine(line.text, codeFenceMarker)) {
        codeFenceMarker = null;
      }
      continue;
    }

    codeFenceMarker = getCodeFenceMarker(line.text);
    if (codeFenceMarker !== null) {
      continue;
    }

    if (blockMatches.some((match) => line.from >= match.from && line.to <= match.to)) {
      continue;
    }

    let codeSpanDelimiterLength = 0;
    let formulaStart: number | null = null;

    for (let index = 0; index < line.text.length; index += 1) {
      const character = line.text[index];

      if (character === '`' && !isEscapedCharacter(line.text, index)) {
        const runLength = getBacktickRunLength(line.text, index);
        if (codeSpanDelimiterLength === 0) {
          codeSpanDelimiterLength = runLength;
          formulaStart = null;
        } else if (runLength === codeSpanDelimiterLength) {
          codeSpanDelimiterLength = 0;
        }
        index += runLength - 1;
        continue;
      }

      if (codeSpanDelimiterLength !== 0
        || character !== '$'
        || isEscapedCharacter(line.text, index)
        || line.text[index - 1] === '$'
        || line.text[index + 1] === '$') {
        continue;
      }

      if (formulaStart === null) {
        formulaStart = index;
        continue;
      }

      const expression = line.text.slice(formulaStart + 1, index).trim();
      if (expression.length > 0) {
        matches.push({
          from: line.from + formulaStart,
          to: line.from + index + 1,
          expression
        });
      }
      formulaStart = null;
    }
  }

  return matches;
}

/** 数学块对应的真实文档行号标记。 */
class EditorMathBlockLineNumberMarker extends GutterMarker {
  /** 创建数学块行号标记。 */
  public constructor(private readonly lineNumber: number) {
    super();
  }

  /** 比较行号，避免无变化时重复创建 DOM。 */
  public override eq(marker: GutterMarker): boolean {
    return marker instanceof EditorMathBlockLineNumberMarker
      && marker.lineNumber === this.lineNumber;
  }

  /** 创建行号文本节点。 */
  public override toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'cm-editor-math-block-line-number';
    element.textContent = String(this.lineNumber);
    return element;
  }
}

/** 在公式源码下方承载 KaTeX display 模式渲染结果。 */
class EditorMathBlockWidget extends WidgetType {
  /** 创建数学块 Widget，并记录是否需要显示块级行号。 */
  public constructor(
    private readonly match: EditorMathBlockMatch,
    private readonly showLineNumber: boolean
  ) {
    super();
  }

  /** 公式内容未变化时复用已有 Widget DOM。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorMathBlockWidget
      && widget.match.expression === this.match.expression
      && widget.match.contentFrom === this.match.contentFrom
      && widget.match.contentTo === this.match.contentTo
      && widget.showLineNumber === this.showLineNumber;
  }

  /** 判断当前 Widget 是否需要在行号 gutter 中显示源码起始行号。 */
  public shouldShowLineNumber(): boolean {
    return this.showLineNumber;
  }

  /** 获取数学块源码起始位置，用于计算真实文档行号。 */
  public getSourceFrom(): number {
    return this.match.from;
  }

  /** 创建公式预览并让 KaTeX 将语法错误呈现为可读文本。 */
  public override toDOM(): HTMLElement {
    const shell = document.createElement('div');
    const preview = document.createElement('section');
    shell.className = createEditorBlockClassName(['cm-editor-math-block-shell'], true, true);
    preview.className = this.showLineNumber
      ? 'cm-editor-math-block'
      : 'cm-editor-math-block cm-editor-math-block--editing';
    preview.dataset.mathContentFrom = String(this.match.contentFrom);
    preview.dataset.mathContentTo = String(this.match.contentTo);
    preview.setAttribute('aria-label', '数学公式预览');
    renderKatex(this.match.expression, preview, true);
    shell.append(preview);
    return shell;
  }

  /** 允许编辑器事件处理器接收公式块点击。 */
  public override ignoreEvent(): boolean {
    return false;
  }
}

/** 为非编辑态数学块恢复与公式顶部对齐的真实文档行号。 */
const editorMathBlockLineNumberExtension = lineNumberWidgetMarker.of((
  view: EditorView,
  widget: WidgetType,
  _block: BlockInfo
) => {
  if (
    !(widget instanceof EditorMathBlockWidget)
    || !widget.shouldShowLineNumber()
  ) {
    return null;
  }

  return new EditorMathBlockLineNumberMarker(
    view.state.doc.lineAt(widget.getSourceFrom()).number
  );
});

/** 在正文中承载 KaTeX 行内公式，并提供点击回源码的位置。 */
class EditorInlineMathWidget extends WidgetType {
  public constructor(
    private readonly expression: string,
    private readonly from: number
  ) {
    super();
  }

  /** 公式内容和源码位置未变化时复用已有 Widget DOM。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorInlineMathWidget
      && widget.expression === this.expression
      && widget.from === this.from;
  }

  /** 创建可点击回源码的 KaTeX 行内公式。 */
  public override toDOM(): HTMLElement {
    const formula = document.createElement('span');
    formula.className = 'cm-editor-inline-math';
    formula.dataset.mathFrom = String(this.from);
    formula.setAttribute('aria-label', '行内数学公式');
    renderKatex(this.expression, formula, false);
    return formula;
  }

  /** 允许编辑器事件处理器接收行内公式点击。 */
  public override ignoreEvent(): boolean {
    return false;
  }
}

/** 判断当前选区是否进入指定的行内公式源码范围。 */
function isInlineMathSelected(state: EditorState, match: EditorInlineMathMatch): boolean {
  return state.selection.ranges.some((range) => range.from <= match.to && range.to >= match.from);
}

/** 点击渲染后的行内公式时恢复源码，并把光标放入两个 $ 之间。 */
const editorInlineMathEventHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.target instanceof Element)) {
      return false;
    }

    const formula = event.target.closest<HTMLElement>('.cm-editor-inline-math');
    const from = Number(formula?.dataset.mathFrom);
    if (!formula || !Number.isInteger(from)) {
      return false;
    }

    event.preventDefault();
    view.dispatch({
      selection: { anchor: from + 1 },
      scrollIntoView: true
    });
    view.focus();
    return true;
  }
});

/** 判断当前选区是否进入指定的数学块源码范围。 */
function isMathBlockSelected(state: EditorState, match: EditorMathBlockMatch): boolean {
  return state.selection.ranges.some((range) => range.from <= match.to && range.to >= match.from);
}

/** 点击渲染后的数学块时恢复源码，并创建 CodeMirror 原生公式内容选区。 */
const editorMathBlockEventHandlers = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.target instanceof Element)) {
      return false;
    }

    const block = event.target.closest<HTMLElement>('.cm-editor-math-block');
    const contentFrom = Number(block?.dataset.mathContentFrom);
    const contentTo = Number(block?.dataset.mathContentTo);
    if (!block
      || !Number.isInteger(contentFrom)
      || !Number.isInteger(contentTo)) {
      return false;
    }

    event.preventDefault();
    view.dispatch({
      selection: { anchor: contentFrom, head: contentTo },
      scrollIntoView: true
    });
    view.focus();
    return true;
  }
});

/** 将完整数学块按纯文本写入，并按需还原剪贴板中的 LaTeX 转义。 */
const editorMathBlockPasteEventHandlers = EditorView.domEventHandlers({
  paste(event, view) {
    const clipboardText = event.clipboardData?.getData('text/plain');
    if (!clipboardText || !EDITOR_MATH_BLOCK_PASTE_PATTERN.test(clipboardText)) {
      return false;
    }

    event.preventDefault();
    const normalizedText = normalizeEscapedMathBlockPaste(clipboardText);
    const transaction = view.state.changeByRange((range) => ({
      changes: {
        from: range.from,
        to: range.to,
        insert: normalizedText
      },
      range: EditorSelection.cursor(range.from + normalizedText.length)
    }));
    view.dispatch(transaction, {
      scrollIntoView: true,
      userEvent: 'input.paste'
    });
    return true;
  }
});

/** 为所有已闭合公式块创建位于源码下方的块级 Widget。 */
function buildEditorMathState(state: EditorState): EditorMathState {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const blockMatches = collectEditorMathBlockMatches(state);

  blockMatches.forEach((match) => {
    if (isMathBlockSelected(state, match)) {
      decorations.push(
        Decoration.mark({ class: 'cm-editor-math-source' }).range(
          match.from,
          match.to
        ),
        Decoration.mark({ class: 'cm-editor-math-block__delimiter' }).range(
          match.openingDelimiterFrom,
          match.openingDelimiterTo
        ),
        Decoration.mark({ class: 'cm-editor-math-block__delimiter' }).range(
          match.closingDelimiterFrom,
          match.closingDelimiterTo
        ),
        Decoration.widget({
          block: true,
          side: 1,
          widget: new EditorMathBlockWidget(match, false)
        }).range(match.to)
      );
      return;
    }

    const replacementTo = match.to < state.doc.length ? match.to + 1 : match.to;
    const replacement = Decoration.replace({
      block: true,
      inclusiveStart: true,
      inclusiveEnd: false,
      widget: new EditorMathBlockWidget(match, true)
    }).range(match.from, replacementTo);
    decorations.push(replacement);
    atomicRanges.push(replacement);
  });

  collectEditorInlineMathMatches(state, blockMatches).forEach((match) => {
    if (isInlineMathSelected(state, match)) {
      decorations.push(
        Decoration.mark({ class: 'cm-editor-math-source' }).range(match.from, match.to)
      );
      return;
    }

    const replacement = Decoration.replace({
      widget: new EditorInlineMathWidget(match.expression, match.from),
      inclusiveStart: false,
      inclusiveEnd: false
    }).range(match.from, match.to);
    decorations.push(replacement);
    atomicRanges.push(replacement);
  });

  return {
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    renderedBlocks: blockMatches.map(({ from, to }) => ({ from, to }))
  };
}

/** 在文档或选区变化时统一重建行内与块级公式装饰。 */
const editorMathBlockStateField = StateField.define<EditorMathState>({
  create: buildEditorMathState,
  update(_value, transaction) {
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    return transaction.docChanged || selectionChanged
      ? buildEditorMathState(transaction.state)
      : _value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
  ]
});

/** 从数学块下一行向上导航或退格时恢复源码，并将光标移到闭合定界符末尾。 */
const editorMathBlockNavigationExtension = createEditorBlockNavigationExtension(
  (state) => state.field(editorMathBlockStateField).renderedBlocks,
  (view, sourceRange) => {
    view.dispatch({
      selection: EditorSelection.cursor(sourceRange.to),
      scrollIntoView: true,
      userEvent: 'select'
    });
  }
);

/** 插入多行 Markdown 公式块，并选中公式内容方便直接输入。 */
export function insertMathBlock(view: EditorView): void {
  const selection = view.state.selection.main;
  const selectedExpression = view.state.sliceDoc(selection.from, selection.to).trim();
  const expression = selectedExpression || 'E = mc^2';
  const prefix = '$$\n';
  const insert = `${prefix}${expression}\n$$`;

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: {
      anchor: selection.from + prefix.length,
      head: selection.from + prefix.length + expression.length
    },
    scrollIntoView: true,
    userEvent: 'input'
  });
  view.focus();
}

/** 数学公式块渲染与主题扩展。 */
export const editorMathBlockExtension = [
  editorMathBlockNavigationExtension,
  editorMathBlockLineNumberExtension,
  editorMathBlockStateField,
  editorInlineMathEventHandlers,
  editorMathBlockEventHandlers,
  editorMathBlockPasteEventHandlers,
  EditorView.baseTheme({
    '.cm-editor-math-block': {
      display: 'block',
      padding: 'var(--workbench-editor-block-gap)',
      overflowX: 'auto',
      color: 'var(--ws-foreground)',
      backgroundColor: 'var(--ws-editor-background)',
      boxSizing: 'border-box'
    },
    '.cm-editor-math-block-line-number': {
      display: 'inline-block',
      paddingBlockStart: 'var(--workbench-editor-block-gap)'
    },
    '.cm-editor-math-block:hover, .cm-editor-math-block--editing': {
      outline: 'var(--workbench-editor-horizontal-rule-width) solid var(--ws-border)',
      outlineOffset: 'calc(var(--workbench-editor-horizontal-rule-width) * -1)'
    },
    '.cm-editor-math-block .katex-display': {
      margin: 'var(--workbench-editor-block-gap)'
    },
    '.cm-editor-math-block .katex': {
      userSelect: 'none'
    },
    '.cm-editor-math-block__delimiter, .cm-editor-math-block__delimiter *': {
      color: 'var(--ws-editor-mathDelimiterForeground) !important'
    },
    '.cm-editor-math-source, .cm-editor-math-source *': {
      textDecoration: 'none !important'
    },
    '.cm-editor-inline-math': {
      color: 'var(--ws-foreground)',
      cursor: 'text'
    }
  })
];
