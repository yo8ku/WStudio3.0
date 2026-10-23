/**
 * 文件说明：禁用 Markdown Setext 标题语法，避免单独的减号行重写前一段内容的标题样式。
 */
import type { MarkdownConfig } from '@lezer/markdown';

/**
 * 移除 SetextHeading 解析规则，标题统一使用井号形式的 ATX 标题语法。
 */
export const disableSetextHeadingExtension: MarkdownConfig = {
  remove: ['SetextHeading']
};
