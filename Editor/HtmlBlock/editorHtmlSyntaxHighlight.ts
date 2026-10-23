/**
 * 文件说明：提供主编辑器与表格单元格共用的 HTML 嵌套语言支持和源码高亮样式。
 */
import { HighlightStyle, LanguageSupport } from '@codemirror/language';
import { htmlLanguage } from '@codemirror/lang-html';
import { tags } from '@lezer/highlight';

/** Markdown 中嵌套 HTML 源码的共享语言支持。 */
export const editorHtmlLanguageSupport = new LanguageSupport(htmlLanguage);

/** HTML 标签、尖括号和属性名的共享源码高亮样式。 */
export const editorHtmlHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.tagName, tags.angleBracket],
    color: 'var(--ws-editor-htmlForeground) !important'
  },
  {
    tag: tags.attributeName,
    color: 'var(--ws-editor-htmlDomForeground) !important'
  }
], {
  scope: htmlLanguage
});
