/** 文件说明：收集完整 Markdown 文档中的标题行与 ATX 前缀范围。 */
import { ensureSyntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

const MARKDOWN_HEADING_NAME_PATTERN = /^(?:ATX|Setext)Heading([1-6])$/;
const MARKDOWN_ATX_HEADING_PREFIX_PATTERN = /^(#{1,6})[\t ]+/;
const MARKDOWN_ATX_HEADING_MARKER_PATTERN = /^(#{1,6})(?=[\t ]|$)/;

export interface MarkdownHeadingLine {
  readonly lineFrom: number;
  readonly level: number;
  readonly markerTo?: number;
  readonly prefixTo?: number;
}

/** 遍历完整语法树，避免标题进入或离开视口时丢失行级排版装饰。 */
export function collectMarkdownHeadingPrefixRanges(state: EditorState): MarkdownHeadingLine[] {
  const headings: MarkdownHeadingLine[] = [];
  const seenLines = new Set<number>();

  const tree = ensureSyntaxTree(state, state.doc.length, 50);
  if (!tree) return headings;

  tree.iterate({
    enter(node) {
      const headingMatch = MARKDOWN_HEADING_NAME_PATTERN.exec(node.type.name);
      if (!headingMatch) return;

      const line = state.doc.lineAt(node.from);
      if (seenLines.has(line.from)) return;
      seenLines.add(line.from);

      const prefixMatch = MARKDOWN_ATX_HEADING_PREFIX_PATTERN.exec(line.text)
        ?? MARKDOWN_ATX_HEADING_MARKER_PATTERN.exec(line.text);
      headings.push({
        lineFrom: line.from,
        level: Number(headingMatch[1]),
        ...(prefixMatch
          ? {
              markerTo: line.from + prefixMatch[1].length,
              prefixTo: line.from + prefixMatch[0].length
            }
          : {})
      });
    }
  });

  return headings;
}
