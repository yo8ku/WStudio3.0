/**
 * 文件说明：解析项目支持的 Markdown 行内链接范围，包括目标中含空格的宽松语法。
 */

/** Markdown 行内链接各源码片段的绝对文档范围。 */
export interface MarkdownInlineLinkRange {
  from: number;
  to: number;
  labelFrom: number;
  labelTo: number;
  destinationFrom: number;
  destinationTo: number;
}

const MARKDOWN_INLINE_LINK_PATTERN = /\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/gu;

/** 收集文本中的行内链接，并将匹配位置转换为文档绝对位置。 */
export function collectMarkdownInlineLinkRanges(
  source: string,
  offset = 0
): MarkdownInlineLinkRange[] {
  const ranges: MarkdownInlineLinkRange[] = [];

  for (const match of source.matchAll(MARKDOWN_INLINE_LINK_PATTERN)) {
    const matchIndex = match.index ?? 0;

    if (matchIndex > 0 && source[matchIndex - 1] === '!') {
      continue;
    }

    const from = offset + matchIndex;
    const labelFrom = from + 1;
    const labelTo = labelFrom + match[1].length;
    const destinationFrom = labelTo + 2;

    ranges.push({
      from,
      to: from + match[0].length,
      labelFrom,
      labelTo,
      destinationFrom,
      destinationTo: destinationFrom + match[2].length
    });
  }

  return ranges;
}
