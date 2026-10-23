/**
 * 文件说明：允许非 `1.` 编号的有序列表在普通段落后继续开始，兼容连续编号文档。
 */
import type { MarkdownConfig } from '@lezer/markdown';

const ORDERED_LIST_MARKER_PATTERN = /^\d{1,9}[.)](?:[\t ]|$)/;

/**
 * 允许 `4.` 等有效编号中断前一个普通段落，后续仍由官方 OrderedList parser 解析。
 */
export const orderedListContinuationExtension: MarkdownConfig = {
  parseBlock: [
    {
      name: 'OrderedListContinuation',
      before: 'OrderedList',
      endLeaf(_context, line) {
        return ORDERED_LIST_MARKER_PATTERN.test(line.text.slice(line.pos));
      }
    }
  ]
};
