/**
 * 文件说明：将过度缩进但明确使用数字列表标记的行解析为有序列表。
 */
import type { MarkdownConfig } from '@lezer/markdown';

const INDENTED_ORDERED_LIST_PATTERN = /^([0-9]{1,9})([.)])(?:[\t ]+|$)/;

/**
 * 兼容 4 个及以上前导空格的有序列表，同时保留普通缩进代码块解析。
 */
export const indentedOrderedListExtension: MarkdownConfig = {
  parseBlock: [
    {
      name: 'IndentedOrderedList',
      before: 'IndentedCode',
      parse(context, line) {
        const source = line.text.slice(line.pos);
        const markerMatch = INDENTED_ORDERED_LIST_PATTERN.exec(source);

        if (!markerMatch || line.indent - line.baseIndent < 4) {
          return false;
        }

        const markerEnd = line.pos + markerMatch[1].length + 1;
        const contentStart = line.skipSpace(markerEnd);
        const listBase = line.countIndent(contentStart);

        if (context.parentType().name !== 'OrderedList') {
          context.startComposite(
            'OrderedList',
            line.basePos,
            markerMatch[2].charCodeAt(0)
          );
        }

        context.startComposite('ListItem', line.basePos, listBase - line.baseIndent);
        line.addMarker(context.elt(
          'ListMark',
          context.lineStart + line.pos,
          context.lineStart + markerEnd
        ));
        line.moveBaseColumn(listBase);
        return null;
      }
    }
  ]
};
