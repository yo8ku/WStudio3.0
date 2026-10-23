/**
 * 文件说明：为 Lezer Markdown 增加空的成对反引号行内代码语法。
 */
import type { MarkdownConfig } from '@lezer/markdown';

const BACKTICK_CHARACTER_CODE = 96;

/**
 * 将恰好两个连续反引号解析为空行内代码节点。
 */
export const emptyInlineCodeExtension: MarkdownConfig = {
  defineNodes: ['EmptyInlineCode'],
  parseInline: [{
    name: 'EmptyInlineCode',

    /**
     * 识别不属于更长反引号序列的空代码对。
     */
    parse(context, nextCharacter, position) {
      if (
        nextCharacter !== BACKTICK_CHARACTER_CODE
        || context.char(position + 1) !== BACKTICK_CHARACTER_CODE
        || context.char(position - 1) === BACKTICK_CHARACTER_CODE
        || context.char(position + 2) === BACKTICK_CHARACTER_CODE
      ) {
        return -1;
      }

      return context.addElement(context.elt('EmptyInlineCode', position, position + 2));
    },
    before: 'InlineCode'
  }]
};
