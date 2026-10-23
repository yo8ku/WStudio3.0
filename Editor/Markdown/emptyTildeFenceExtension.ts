/**
 * 文件说明：将不带语言或内容声明的纯波浪线围栏行解析为普通 Markdown 段落。
 */
import type { MarkdownConfig } from '@lezer/markdown';

const EMPTY_TILDE_FENCE_PATTERN = /^~{3,}\s*$/;

/**
 * 在默认 FencedCode 之前拦截纯波浪线行，避免其吞并后续 Markdown 内容。
 */
export const emptyTildeFenceExtension: MarkdownConfig = {
  parseBlock: [{
    name: 'EmptyTildeFence',

    /**
     * 将纯波浪线围栏作为普通段落消费，并保留原始文本内容。
     */
    parse(context, line) {
      const source = line.text.slice(line.pos);

      if (!EMPTY_TILDE_FENCE_PATTERN.test(source)) {
        return false;
      }

      const from = context.lineStart + line.pos;
      const to = context.lineStart + line.text.length;

      context.addElement(context.elt('Paragraph', from, to));
      context.nextLine();
      return true;
    },
    before: 'FencedCode'
  }]
};
