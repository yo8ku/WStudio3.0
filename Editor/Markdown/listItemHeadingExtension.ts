/**
 * 文件说明：将列表项中的 ATX 标题源码按普通段落解析，避免列表内容被误标题化。
 */
import type { BlockContext, MarkdownConfig } from '@lezer/markdown';

/**
 * 判断当前 block parser 是否位于任意层级的列表项中。
 */
function isInsideListItem(context: BlockContext): boolean {
  for (let depth = 0; depth < context.depth; depth += 1) {
    if (context.parentType(depth).name === 'ListItem') {
      return true;
    }
  }

  return false;
}

/**
 * 在列表项上下文中将 `## 内容` 作为普通段落解析。
 */
export const listItemHeadingExtension: MarkdownConfig = {
  parseBlock: [
    {
      name: 'ListItemHeadingAsParagraph',
      before: 'ATXHeading',
      parse(context, line) {
        const source = line.text.slice(line.pos);

        if (!isInsideListItem(context) || !/^#{1,6}(?:\s|$)/.test(source)) {
          return false;
        }

        const from = context.lineStart + line.pos;
        const to = context.lineStart + line.text.length;
        const content = context.parser.parseInline(source, from);

        context.nextLine();
        context.addElement(context.elt('Paragraph', from, to, content));
        return true;
      }
    }
  ]
};
