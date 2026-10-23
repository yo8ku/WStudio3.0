/**
 * 文件说明：为 WikiLink 的当前文档标题目标提供 CodeMirror 标题补全。
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  collectMarkdownHeadingSections,
  type MarkdownHeadingSection
} from '@editor/Markdown/markdownInlineLinkPreview';

/** Wiki 标题补全允许继续输入的字符范围。 */
const WIKI_LINK_HEADING_VALID_PATTERN = /^[^\]\r\n|]*$/u;

/** 不应触发 Wiki 标题补全的 Markdown 语法节点。 */
const EXCLUDED_WIKI_LINK_NODE_NAMES = new Set([
  'Comment',
  'CommentBlock',
  'FencedCode',
  'HTMLBlock',
  'HTMLTag',
  'InlineCode'
]);

/** 当前文档标题补全上下文。 */
export interface EditorWikiLinkHeadingCompletionContext {
  /** 标题查询文本的起始位置，不包含 `#`。 */
  readonly from: number;
  /** 标题查询文本的结束位置。 */
  readonly to: number;
}

/** 判断指定字符位置之前是否有奇数个连续反斜杠。 */
function isEscaped(source: string, position: number): boolean {
  let slashCount = 0;

  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

/** 在指定文本范围内查找未转义的字符串。 */
function findUnescapedSequence(
  source: string,
  sequence: string,
  start = 0
): number {
  let position = source.indexOf(sequence, start);

  while (position >= 0) {
    if (!isEscaped(source, position)) {
      return position;
    }

    position = source.indexOf(sequence, position + sequence.length);
  }

  return -1;
}

/** 在指定文本范围内查找未转义的单个字符。 */
function findUnescapedCharacter(
  source: string,
  character: string,
  start = 0
): number {
  for (
    let position = source.indexOf(character, start);
    position >= 0;
    position = source.indexOf(character, position + 1)
  ) {
    if (!isEscaped(source, position)) {
      return position;
    }
  }

  return -1;
}

/** 判断语法树位置是否处于代码或 HTML 注释上下文。 */
function isExcludedSyntaxPosition(state: EditorState, position: number): boolean {
  const resolvedPosition = Math.max(0, Math.min(state.doc.length - 1, position - 1));
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(resolvedPosition, -1);

  while (node) {
    if (EXCLUDED_WIKI_LINK_NODE_NAMES.has(node.name)) {
      return true;
    }

    node = node.parent;
  }

  const sourceBeforeCursor = state.sliceDoc(0, position);
  const commentStart = sourceBeforeCursor.lastIndexOf('<!--');
  const commentEnd = sourceBeforeCursor.lastIndexOf('-->');

  return commentStart > commentEnd;
}

/** 判断指定 WikiLink 开始位置是否是媒体嵌入。 */
function isMediaEmbed(source: string, openingPosition: number): boolean {
  const markerPosition = openingPosition - 1;
  return markerPosition >= 0
    && source[markerPosition] === '!'
    && !isEscaped(source, markerPosition);
}

/** 查找当前光标所在的 `[[#标题` 查询范围。 */
export function findEditorWikiLinkHeadingCompletionContext(
  state: EditorState,
  position = state.selection.main.head
): EditorWikiLinkHeadingCompletionContext | null {
  if (position < 0 || position > state.doc.length) {
    return null;
  }

  const line = state.doc.lineAt(position);
  const cursorOffset = position - line.from;
  const beforeCursor = line.text.slice(0, cursorOffset);

  // lastIndexOf 会将负搜索位置钳制为 0，扫描完行首起点后必须显式结束。
  for (
    let openingPosition = beforeCursor.lastIndexOf('[[');
    openingPosition >= 0;
    openingPosition = openingPosition > 0
      ? beforeCursor.lastIndexOf('[[', openingPosition - 1)
      : -1
  ) {
    if (
      isEscaped(beforeCursor, openingPosition)
      || isMediaEmbed(beforeCursor, openingPosition)
    ) {
      continue;
    }

    const linkContent = beforeCursor.slice(openingPosition + 2);

    if (
      findUnescapedSequence(linkContent, ']]') >= 0
      || findUnescapedSequence(linkContent, '[[') >= 0
    ) {
      continue;
    }

    const headingSeparatorPosition = findUnescapedCharacter(linkContent, '#');

    if (headingSeparatorPosition < 0) {
      continue;
    }

    const documentTarget = linkContent.slice(0, headingSeparatorPosition).trim();
    const headingQuery = linkContent.slice(headingSeparatorPosition + 1);
    const hasTrailingBlockMarker = headingQuery.endsWith('^')
      && !isEscaped(headingQuery, headingQuery.length - 1);

    if (
      documentTarget.length > 0
      || headingQuery.startsWith('^')
      || hasTrailingBlockMarker
      || findUnescapedCharacter(headingQuery, '|') >= 0
      || findUnescapedCharacter(headingQuery, ']') >= 0
    ) {
      continue;
    }

    const afterCursor = line.text.slice(cursorOffset);

    if (afterCursor.length > 0 && !afterCursor.startsWith(']]')) {
      continue;
    }

    return {
      from: line.from + openingPosition + 2 + headingSeparatorPosition + 1,
      to: position
    };
  }

  return null;
}

/** 将标题规范化为稳定的去重键，同时保留原始显示文本。 */
function createHeadingKey(title: string): string {
  return title.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

/** 创建选择标题后的源码替换行为。 */
function createHeadingCompletion(
  heading: MarkdownHeadingSection,
  order: number
): Completion {
  const title = heading.title.trim();

  return {
    label: title,
    displayLabel: `${'#'.repeat(heading.level)} ${title}`,
    detail: '当前文档',
    sortText: String(order).padStart(6, '0'),
    type: 'text',
    apply(view, completion, from, to) {
      const hasClosingMark = view.state.sliceDoc(to, to + 2) === ']]';
      const insertedText = `${title}${hasClosingMark ? '' : ']]'}`;

      view.dispatch({
        changes: { from, to, insert: insertedText },
        selection: { anchor: from + title.length },
        annotations: pickedCompletion.of(completion),
        scrollIntoView: true,
        userEvent: 'input.complete'
      });
      view.focus();
    }
  };
}

/** 收集当前文档中按出现顺序排列且去重的标题补全项。 */
function collectEditorWikiLinkHeadingCompletions(
  state: EditorState
): Completion[] {
  const seenTitles = new Set<string>();
  const completions: Completion[] = [];

  collectMarkdownHeadingSections(state.doc.toString()).forEach((heading, index) => {
    const title = heading.title.trim();
    const key = createHeadingKey(title);

    if (!title || seenTitles.has(key)) {
      return;
    }

    seenTitles.add(key);
    completions.push(createHeadingCompletion({ ...heading, title }, index));
  });

  return completions;
}

/** 在输入 WikiLink 标题目标时提供当前文档标题补全。 */
export function editorWikiLinkHeadingCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  if (!context.state.selection.main.empty) {
    return null;
  }

  const completionContext = findEditorWikiLinkHeadingCompletionContext(
    context.state,
    context.pos
  );

  if (
    !completionContext
    || isExcludedSyntaxPosition(context.state, context.pos)
  ) {
    return null;
  }

  const options = collectEditorWikiLinkHeadingCompletions(context.state);

  return options.length > 0
    ? {
        from: completionContext.from,
        to: completionContext.to,
        options,
        validFor: WIKI_LINK_HEADING_VALID_PATTERN
      }
    : null;
}

/** WikiLink 标题补全扩展，接入 CodeMirror 的统一补全面板。 */
export const editorWikiLinkCompletionExtension = [
  EditorState.languageData.of(() => [{
    autocomplete: editorWikiLinkHeadingCompletionSource
  }])
];

/** 判断当前补全状态是否处于 WikiLink 标题输入范围。 */
export function isEditorWikiLinkHeadingCompletionState(state: EditorState): boolean {
  return findEditorWikiLinkHeadingCompletionContext(state) !== null
    && !isExcludedSyntaxPosition(state, state.selection.main.head);
}
