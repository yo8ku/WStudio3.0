/**
 * 文件说明：为 Lezer Markdown 增加使用双等号包裹内容的行内高亮语法。
 */
import type { DelimiterType, MarkdownConfig } from '@lezer/markdown';

const HIGHLIGHT_MARK_CHARACTER_CODE = 61;
const highlightDelimiter: DelimiterType = {
  mark: 'HighlightMark',
  resolve: 'Highlight'
};

/**
 * 判断指定字符是否为空白或超出当前行内解析范围。
 */
function isWhitespaceBoundary(value: string): boolean {
  return /^\s*$/.test(value);
}

/**
 * 提供 `==高亮内容==` Markdown 方言语法。
 */
export const markdownHighlightExtension: MarkdownConfig = {
  defineNodes: [
    'Highlight',
    'HighlightMark'
  ],
  parseInline: [{
    name: 'Highlight',

    /**
     * 识别成对双等号并注册可自动配对的行内分隔符。
     */
    parse(context, nextCharacter, position) {
      if (
        nextCharacter !== HIGHLIGHT_MARK_CHARACTER_CODE
        || context.char(position + 1) !== HIGHLIGHT_MARK_CHARACTER_CODE
        || context.char(position + 2) === HIGHLIGHT_MARK_CHARACTER_CODE
      ) {
        return -1;
      }

      const before = context.slice(position - 1, position);
      const after = context.slice(position + 2, position + 3);

      return context.addDelimiter(
        highlightDelimiter,
        position,
        position + 2,
        !isWhitespaceBoundary(after),
        !isWhitespaceBoundary(before)
      );
    },
    after: 'Emphasis'
  }]
};
