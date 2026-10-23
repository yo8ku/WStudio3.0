/**
 * 文件说明：为 Markdown 普通文本中的成对括号表达式提供稳定的嵌套主题前景色。
 */
import { syntaxTree } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Range } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  collectEditorWikiLinkRanges,
  type EditorWikiLinkRange
} from '@editor/WikiLink/editorWikiLink';

const TASK_CHECKBOX_PATTERN = /^\[[ xX]\]$/;
const TASK_LIST_PREFIX_PATTERN = /^\s*(?:[-+*]|\d+[.)])\s+$/;
const EXCLUDED_CODE_NODE_NAMES = new Set(['CodeBlock', 'InlineCode', 'FencedCode']);

/** 编辑器支持独立配色的括号类型。 */
type BracketExpressionType = 'square' | 'parenthesis' | 'brace' | 'angle';

/** 单类括号的字符与装饰类定义。 */
interface BracketExpressionDefinition {
  readonly className: string;
  readonly closingCharacter: string;
  readonly contentClassName?: string;
  readonly openingCharacter: string;
  readonly type: BracketExpressionType;
}

/** 已完成配对并按包含关系挂接的括号表达式。 */
interface MatchedBracketExpression {
  readonly children: MatchedBracketExpression[];
  readonly definition: BracketExpressionDefinition;
  readonly from: number;
  readonly to: number;
}

/** 所有括号类型共享的唯一配对定义。 */
const BRACKET_EXPRESSION_DEFINITIONS: readonly BracketExpressionDefinition[] = [
  {
    className: 'cm-markdown-square-bracket-expression',
    closingCharacter: ']',
    contentClassName: 'cm-markdown-square-bracket-content',
    openingCharacter: '[',
    type: 'square'
  },
  {
    className: 'cm-markdown-parenthesis-expression',
    closingCharacter: ')',
    contentClassName: 'cm-markdown-parenthesis-content',
    openingCharacter: '(',
    type: 'parenthesis'
  },
  {
    className: 'cm-markdown-brace-expression',
    closingCharacter: '}',
    contentClassName: 'cm-markdown-brace-content',
    openingCharacter: '{',
    type: 'brace'
  },
  {
    className: 'cm-markdown-angle-bracket-expression',
    closingCharacter: '>',
    contentClassName: 'cm-markdown-angle-bracket-content',
    openingCharacter: '<',
    type: 'angle'
  }
];

/** 通过开始字符快速定位对应括号定义。 */
const OPENING_DEFINITION_BY_CHARACTER = new Map(
  BRACKET_EXPRESSION_DEFINITIONS.map((definition) => [definition.openingCharacter, definition])
);
/** 通过结束字符快速定位对应括号定义。 */
const CLOSING_DEFINITION_BY_CHARACTER = new Map(
  BRACKET_EXPRESSION_DEFINITIONS.map((definition) => [definition.closingCharacter, definition])
);

/** 扫描期间尚未闭合的括号栈项。 */
interface OpenBracketExpression {
  readonly definition: BracketExpressionDefinition;
  readonly from: number;
}

/** 判断表达式是否位于代码块或标题语法中。 */
function isExcludedSyntaxExpression(view: EditorView, position: number): boolean {
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(position, 1);

  while (node) {
    if (EXCLUDED_CODE_NODE_NAMES.has(node.name) || node.name.includes('Heading')) {
      return true;
    }

    node = node.parent;
  }

  return false;
}

/** 判断括号表达式是否属于代码、链接、图片或任务列表语法。 */
function isExcludedBracketExpression(
  view: EditorView,
  expression: MatchedBracketExpression,
  source: string
): boolean {
  if (isExcludedSyntaxExpression(view, expression.from)) {
    return true;
  }

  const previousCharacter = expression.from > 0
    ? view.state.sliceDoc(expression.from - 1, expression.from)
    : '';
  const previousTwoCharacters = expression.from >= 2
    ? view.state.sliceDoc(expression.from - 2, expression.from)
    : '';
  const nextCharacter = expression.to < view.state.doc.length
    ? view.state.sliceDoc(expression.to, expression.to + 1)
    : '';

  if (expression.definition.type === 'square') {
    const line = view.state.doc.lineAt(expression.from);
    const expressionOffset = expression.from - line.from;
    const isTaskCheckbox = TASK_CHECKBOX_PATTERN.test(source)
      && TASK_LIST_PREFIX_PATTERN.test(line.text.slice(0, expressionOffset));

    return isTaskCheckbox
      || previousCharacter === '!'
      || previousTwoCharacters === '!['
      || nextCharacter === '('
      || nextCharacter === '[';
  }

  return expression.definition.type === 'parenthesis' && previousCharacter === ']';
}

/** 判断普通括号表达式是否已经属于一个完整 Wiki 链接。 */
function isWikiLinkBracketExpression(
  expression: MatchedBracketExpression,
  wikiLinkRanges: readonly EditorWikiLinkRange[]
): boolean {
  return wikiLinkRanges.some((wikiLink) => (
    expression.from >= wikiLink.from && expression.to <= wikiLink.to
  ));
}

/** 按严格的栈顺序收集当前行内所有成对括号，避免交叉范围造成颜色串线。 */
function collectMatchedBracketExpressions(
  source: string,
  offset: number
): MatchedBracketExpression[] {
  const openStack: OpenBracketExpression[] = [];
  const matchedExpressions: MatchedBracketExpression[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const openingDefinition = OPENING_DEFINITION_BY_CHARACTER.get(character);

    if (openingDefinition) {
      openStack.push({
        definition: openingDefinition,
        from: offset + index
      });
      continue;
    }

    const closingDefinition = CLOSING_DEFINITION_BY_CHARACTER.get(character);
    const opening = openStack[openStack.length - 1];

    if (!closingDefinition || !opening || opening.definition.type !== closingDefinition.type) {
      continue;
    }

    openStack.pop();
    matchedExpressions.push({
      children: [],
      definition: opening.definition,
      from: opening.from,
      to: offset + index + 1
    });
  }

  return matchedExpressions;
}

/** 将已匹配的括号按包含关系组织成嵌套树，未闭合外层不会丢失内部完整配对。 */
function buildBracketExpressionTree(
  expressions: MatchedBracketExpression[]
): MatchedBracketExpression[] {
  const roots: MatchedBracketExpression[] = [];
  const expressionStack: MatchedBracketExpression[] = [];
  const sortedExpressions = [...expressions].sort((left, right) => (
    left.from - right.from || right.to - left.to
  ));

  for (const expression of sortedExpressions) {
    while (
      expressionStack.length > 0
      && expression.from >= (expressionStack[expressionStack.length - 1]?.to ?? 0)
    ) {
      expressionStack.pop();
    }

    const parent = expressionStack[expressionStack.length - 1];

    if (parent && expression.to <= parent.to) {
      parent.children.push(expression);
    } else {
      roots.push(expression);
    }

    expressionStack.push(expression);
  }

  return roots;
}

/** 为一个括号表达式添加外层、分隔符和非嵌套内容装饰。 */
function appendBracketExpressionDecorations(
  view: EditorView,
  expression: MatchedBracketExpression,
  source: string,
  decorations: Range<Decoration>[]
): void {
  const lineFrom = view.state.doc.lineAt(expression.from).from;
  const expressionSource = source.slice(
    expression.from - lineFrom,
    expression.to - lineFrom
  );
  const excluded = isExcludedBracketExpression(view, expression, expressionSource);

  if (excluded) {
    return;
  }

  const { definition } = expression;
  const openingEnd = expression.from + definition.openingCharacter.length;
  const closingStart = expression.to - definition.closingCharacter.length;

  decorations.push(Decoration.mark({
    class: `cm-markdown-bracket-expression ${definition.className}`
  }).range(expression.from, expression.to));
  decorations.push(
    Decoration.mark({
      class: `${definition.className}__delimiter`
    }).range(expression.from, openingEnd),
    Decoration.mark({
      class: `${definition.className}__delimiter`
    }).range(closingStart, expression.to)
  );

  let contentFrom = openingEnd;

  for (const child of expression.children) {
    if (contentFrom < child.from) {
      appendBracketContentDecoration(definition, contentFrom, child.from, decorations);
    }

    appendBracketExpressionDecorations(view, child, source, decorations);
    contentFrom = child.to;
  }

  if (contentFrom < closingStart) {
    appendBracketContentDecoration(definition, contentFrom, closingStart, decorations);
  }
}

/** 为括号内部的普通文本添加内容前景色，避免覆盖嵌套括号分隔符。 */
function appendBracketContentDecoration(
  definition: BracketExpressionDefinition,
  from: number,
  to: number,
  decorations: Range<Decoration>[]
): void {
  if (!definition.contentClassName || from >= to) {
    return;
  }

  decorations.push(Decoration.mark({
    class: definition.contentClassName
  }).range(from, to));
}

/** 为完整 Wiki 链接添加统一的双分隔符和目标内容装饰。 */
function appendWikiLinkDecorations(
  view: EditorView,
  wikiLink: EditorWikiLinkRange,
  decorations: Range<Decoration>[]
): void {
  if (isExcludedSyntaxExpression(view, wikiLink.from)) {
    return;
  }

  decorations.push(
    Decoration.mark({
      class: 'cm-markdown-bracket-expression cm-markdown-square-bracket-expression cm-markdown-wiki-link-expression'
    }).range(wikiLink.from, wikiLink.to),
    Decoration.mark({
      class: 'cm-markdown-square-bracket-expression__delimiter'
    }).range(wikiLink.from, wikiLink.targetFrom)
  );

  if (wikiLink.targetFrom < wikiLink.targetTo) {
    decorations.push(Decoration.mark({
      class: 'cm-markdown-square-bracket-content'
    }).range(wikiLink.targetFrom, wikiLink.targetTo));
  }

  decorations.push(Decoration.mark({
    class: 'cm-markdown-square-bracket-expression__delimiter'
  }).range(wikiLink.targetTo, wikiLink.to));
}

/** 为当前可见区域构建普通括号表达式装饰。 */
function buildBracketExpressionDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const visitedLines = new Set<number>();

  for (const visibleRange of view.visibleRanges) {
    const firstLine = view.state.doc.lineAt(visibleRange.from);
    const lastLine = view.state.doc.lineAt(visibleRange.to);

    for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber += 1) {
      if (visitedLines.has(lineNumber)) {
        continue;
      }

      visitedLines.add(lineNumber);
      const line = view.state.doc.line(lineNumber);
      const wikiLinkRanges = collectEditorWikiLinkRanges(line.text, line.from);
      const expressions = buildBracketExpressionTree(
        collectMatchedBracketExpressions(line.text, line.from)
      );

      for (const wikiLink of wikiLinkRanges) {
        appendWikiLinkDecorations(view, wikiLink, decorations);
      }

      for (const expression of expressions) {
        if (isWikiLinkBracketExpression(expression, wikiLinkRanges)) {
          continue;
        }

        appendBracketExpressionDecorations(view, expression, line.text, decorations);
      }
    }
  }

  return Decoration.set(decorations, true);
}

/** 括号表达式装饰与主题扩展。 */
export const bracketExpressionExtension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      /** 初始化可见括号表达式。 */
      constructor(view: EditorView) {
        this.decorations = buildBracketExpressionDecorations(view);
      }

      /** 在文档、视口或 Markdown 解析树变化后刷新括号表达式。 */
      update(update: ViewUpdate): void {
        const syntaxTreeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);

        if (update.docChanged || update.viewportChanged || syntaxTreeChanged) {
          this.decorations = buildBracketExpressionDecorations(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  ),
  EditorView.theme({
    '.cm-content .cm-markdown-bracket-expression, .cm-content .cm-markdown-bracket-expression *': {
      textDecoration: 'none'
    },
    '.cm-content .cm-markdown-square-bracket-expression__delimiter, .cm-content .cm-markdown-square-bracket-expression__delimiter *': {
      color: 'var(--ws-editor-squareBracketForeground) !important'
    },
    '.cm-content .cm-markdown-square-bracket-content, .cm-content .cm-markdown-square-bracket-content *': {
      color: 'var(--ws-editor-squareBracketContentForeground) !important'
    },
    '.cm-content .cm-markdown-parenthesis-expression__delimiter, .cm-content .cm-markdown-parenthesis-expression__delimiter *': {
      color: 'var(--ws-editor-parenthesisForeground) !important'
    },
    '.cm-content .cm-markdown-parenthesis-content, .cm-content .cm-markdown-parenthesis-content *': {
      color: 'var(--ws-editor-parenthesisContentForeground) !important'
    },
    '.cm-content .cm-markdown-brace-expression__delimiter, .cm-content .cm-markdown-brace-expression__delimiter *': {
      color: 'var(--ws-editor-braceForeground) !important'
    },
    '.cm-content .cm-markdown-brace-content, .cm-content .cm-markdown-brace-content *': {
      color: 'var(--ws-editor-braceContentForeground) !important'
    },
    '.cm-content .cm-markdown-angle-bracket-expression__delimiter, .cm-content .cm-markdown-angle-bracket-expression__delimiter *': {
      color: 'var(--ws-editor-angleBracketForeground) !important'
    },
    '.cm-content .cm-markdown-angle-bracket-content, .cm-content .cm-markdown-angle-bracket-content *': {
      color: 'var(--ws-editor-angleBracketForeground) !important'
    },
    '.cm-content .cm-markdown-square-bracket-expression:not(:has(.cm-editor-math-source)):hover .cm-markdown-square-bracket-content, .cm-content .cm-markdown-square-bracket-expression:not(:has(.cm-editor-math-source)):hover .cm-markdown-square-bracket-content *': {
      textDecoration: 'underline'
    }
  })
];
