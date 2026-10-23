/**
 * 文件说明：统一解析与插入跨文档 Wiki 双向链接，为后续反向链接索引提供稳定的数据入口。
 */
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Wiki 链接的开始分隔符。 */
export const EDITOR_WIKI_LINK_OPENING_MARK = '[[';

/** Wiki 链接的结束分隔符。 */
export const EDITOR_WIKI_LINK_CLOSING_MARK = ']]';

/** 未选中文本时插入的 Wiki 链接占位内容。 */
export const EDITOR_WIKI_LINK_PLACEHOLDER = '链接文本';

/** Wiki 链接解析出的跨文档目标。 */
export interface EditorWikiLinkTarget {
  /** 目标文档路径；为空时表示当前文档。 */
  readonly documentTarget: string;
  /** 目标文档中的标题片段；未指定标题时为空。 */
  readonly headingTarget: string | null;
  /** 显示别名；未指定别名时为空。 */
  readonly displayText: string | null;
}

/** Wiki 链接及其目标内容在源文档中的绝对范围。 */
export interface EditorWikiLinkRange {
  readonly from: number;
  readonly to: number;
  readonly targetFrom: number;
  readonly targetTo: number;
  readonly target: EditorWikiLinkTarget;
}

/** 判断匹配位置之前是否存在生效的反斜杠转义。 */
function isEscapedSourcePosition(source: string, position: number): boolean {
  let escapeCharacterCount = 0;

  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    escapeCharacterCount += 1;
  }

  return escapeCharacterCount % 2 === 1;
}

/**
 * 从 Wiki 开始标记向右查找同层级结束标记；换行或未闭合内容会放弃本次匹配。
 */
function findEditorWikiLinkEnd(source: string, openingPosition: number): number | null {
  let nestingLevel = 1;
  let nestedSquareBracketLevel = 0;
  const openingMarkLength = EDITOR_WIKI_LINK_OPENING_MARK.length;

  for (let index = openingPosition + openingMarkLength; index < source.length; index += 1) {
    const character = source[index];

    if (character === '\r' || character === '\n') {
      return null;
    }

    if (character === '\\') {
      index += 1;
      continue;
    }

    if (source.startsWith('[[', index)) {
      nestingLevel += 1;
      index += 1;
      continue;
    }

    if (character === '[') {
      nestedSquareBracketLevel += 1;
      continue;
    }

    if (character === ']' && nestedSquareBracketLevel > 0) {
      nestedSquareBracketLevel -= 1;
      continue;
    }

    if (!source.startsWith(']]', index)) {
      continue;
    }

    nestingLevel -= 1;

    if (nestingLevel === 0) {
      return index + EDITOR_WIKI_LINK_CLOSING_MARK.length;
    }

    index += 1;
  }

  return null;
}

/** 查找未被反斜杠转义的第一个目标分隔符。 */
function findUnescapedTargetSeparator(source: string, separator: '#' | '|'): number {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === separator && !isEscapedSourcePosition(source, index)) {
      return index;
    }
  }

  return -1;
}

/** 将 Wiki 链接内部文本拆分为文档、标题和显示文本。 */
function parseEditorWikiLinkTarget(source: string): EditorWikiLinkTarget {
  const displaySeparatorIndex = findUnescapedTargetSeparator(source, '|');
  const destinationSource = displaySeparatorIndex >= 0
    ? source.slice(0, displaySeparatorIndex)
    : source;
  const headingSeparatorIndex = findUnescapedTargetSeparator(destinationSource, '#');

  return {
    documentTarget: (
      headingSeparatorIndex >= 0
        ? destinationSource.slice(0, headingSeparatorIndex)
        : destinationSource
    ).trim(),
    headingTarget: headingSeparatorIndex >= 0
      ? destinationSource.slice(headingSeparatorIndex + 1).trim()
      : null,
    displayText: displaySeparatorIndex >= 0
      ? source.slice(displaySeparatorIndex + 1).trim()
      : null
  };
}

/**
 * 收集源文本中的 Wiki 链接；媒体嵌入 `![[...]]` 不计入普通双向链接。
 */
export function collectEditorWikiLinkRanges(
  source: string,
  offset = 0
): EditorWikiLinkRange[] {
  const ranges: EditorWikiLinkRange[] = [];

  let scanPosition = 0;

  while (scanPosition <= source.length - EDITOR_WIKI_LINK_OPENING_MARK.length) {
    const isMediaEmbed = scanPosition > 0
      && source[scanPosition - 1] === '!'
      && !isEscapedSourcePosition(source, scanPosition - 1);

    if (
      !source.startsWith(EDITOR_WIKI_LINK_OPENING_MARK, scanPosition)
      || isMediaEmbed
      || isEscapedSourcePosition(source, scanPosition)
    ) {
      scanPosition += 1;
      continue;
    }

    const endPosition = findEditorWikiLinkEnd(source, scanPosition);

    if (endPosition === null) {
      scanPosition += EDITOR_WIKI_LINK_OPENING_MARK.length;
      continue;
    }

    const targetSource = source.slice(
      scanPosition + EDITOR_WIKI_LINK_OPENING_MARK.length,
      endPosition - EDITOR_WIKI_LINK_CLOSING_MARK.length
    );
    const from = offset + scanPosition;
    const targetFrom = from + EDITOR_WIKI_LINK_OPENING_MARK.length;
    const targetTo = targetFrom + targetSource.length;

    ranges.push({
      from,
      to: offset + endPosition,
      targetFrom,
      targetTo,
      target: parseEditorWikiLinkTarget(targetSource)
    });
    scanPosition = endPosition;
  }

  return ranges;
}

/**
 * 用 Wiki 链接语法包裹所有选区，并选中原内容或新建的占位内容。
 */
export function insertEditorWikiLink(view: EditorView): boolean {
  if (view.state.readOnly) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const selectedText = view.state.sliceDoc(range.from, range.to);
    const targetText = selectedText || EDITOR_WIKI_LINK_PLACEHOLDER;

    return {
      changes: {
        from: range.from,
        to: range.to,
        insert: `${EDITOR_WIKI_LINK_OPENING_MARK}${targetText}${EDITOR_WIKI_LINK_CLOSING_MARK}`
      },
      range: EditorSelection.range(
        range.from + EDITOR_WIKI_LINK_OPENING_MARK.length,
        range.from + EDITOR_WIKI_LINK_OPENING_MARK.length + targetText.length
      )
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });
  view.focus();

  return true;
}
