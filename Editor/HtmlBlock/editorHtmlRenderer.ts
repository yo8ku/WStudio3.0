/**
 * 文件说明：提供 HTML 块与表格单元格共用的安全 HTML 清洗和 DOM Fragment 创建能力。
 */
import { htmlLanguage } from '@codemirror/lang-html';
import DOMPurify from 'dompurify';

const ALLOWED_EDITOR_HTML_TAGS = [
  'a',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'cite',
  'code',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  's',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'time',
  'u',
  'ul'
] as const;
const DANGEROUS_EDITOR_HTML_STYLE_PATTERN = /(?:expression\s*\(|@import|behavior\s*:|-moz-binding\s*:|url\s*\(\s*["']?\s*(?:javascript|data):)/i;

/** 移除 CSS 中可执行脚本、危险协议和浏览器行为声明。 */
function sanitizeEditorHtmlStyles(container: ParentNode): void {
  container.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    for (let index = element.style.length - 1; index >= 0; index -= 1) {
      const property = element.style.item(index);
      const value = element.style.getPropertyValue(property);

      if (DANGEROUS_EDITOR_HTML_STYLE_PATTERN.test(`${property}:${value}`)) {
        element.style.removeProperty(property);
      }
    }
  });
}

/** 通过官方 HTML 语法树确认所有非 void 元素均包含结束标签。 */
function hasCompleteEditorHtmlElements(source: string): boolean {
  let complete = true;

  htmlLanguage.parser.parse(source).iterate({
    enter(node) {
      if (node.name !== 'Element') return;
      let hasOpenTag = false;
      let hasCloseTag = false;
      let child = node.node.firstChild;
      while (child) {
        if (child.name === 'OpenTag') hasOpenTag = true;
        if (child.name === 'CloseTag') hasCloseTag = true;
        child = child.nextSibling;
      }
      if (hasOpenTag && !hasCloseTag) complete = false;
    }
  });

  return complete;
}

/** 将 HTML 源码清洗为允许在编辑器中渲染的安全 HTML。 */
export function sanitizeEditorHtmlSource(source: string): string | null {
  if (!hasCompleteEditorHtmlElements(source)) return null;

  const sanitizedSource = DOMPurify.sanitize(source, {
    ALLOWED_ATTR: ['style'],
    ALLOWED_TAGS: [...ALLOWED_EDITOR_HTML_TAGS]
  });
  const template = document.createElement('template');
  template.innerHTML = sanitizedSource;

  return template.content.childElementCount === 0 ? null : sanitizedSource;
}

/** 从已清洗的 HTML 创建经过危险内联样式过滤的 DOM Fragment。 */
export function createSanitizedEditorHtmlFragment(sanitizedSource: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = sanitizedSource;
  sanitizeEditorHtmlStyles(template.content);
  return template.content;
}
