/** 文件说明：提供引用行前导缩进的源码定位工具。 */

/** 返回引用标记前的空格与制表符数量。 */
export function getMarkdownQuoteIndentLength(lineText: string): number {
  return /^[ \t]*(?=>)/.exec(lineText)?.[0].length ?? 0;
}
