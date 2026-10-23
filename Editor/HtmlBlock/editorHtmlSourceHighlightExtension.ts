/**
 * 文件说明：统一 HTML 属性值源码颜色，覆盖 style 属性中嵌套 CSS 语法树的子级高亮。
 */
import { syntaxTree } from '@codemirror/language';
import { htmlLanguage } from '@codemirror/lang-html';
import type { Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view';

const HTML_ATTRIBUTE_VALUE_NODE_NAMES = new Set([
  'AttributeValue',
  'UnquotedAttributeValue'
]);

/** 判断 Markdown 段落是否完全由独立 HTML 源码组成。 */
function isStandaloneHtmlSource(source: string): boolean {
  const trimmedSource = source.trim();

  return trimmedSource.startsWith('<')
    && trimmedSource.endsWith('>')
    && !trimmedSource.startsWith('<!--');
}

/** 将 HTML 源码中的属性值节点映射为编辑器文档装饰。 */
function appendHtmlAttributeValueDecorations(
  decorations: Range<Decoration>[],
  source: string,
  documentFrom: number
): void {
  htmlLanguage.parser.parse(source).iterate({
    enter(node) {
      if (!HTML_ATTRIBUTE_VALUE_NODE_NAMES.has(node.name)) {
        return;
      }

      decorations.push(Decoration.mark({
        class: 'cm-editor-html-attribute-value'
      }).range(documentFrom + node.from, documentFrom + node.to));
    }
  });
}

/** 为当前可见区域中的 HTML 属性值创建统一源码装饰。 */
function buildHtmlAttributeValueDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const decoratedRanges = new Set<string>();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const source = view.state.sliceDoc(node.from, node.to);
        const isHtmlSource = node.name === 'HTMLBlock'
          || (node.name === 'Paragraph' && isStandaloneHtmlSource(source));

        if (!isHtmlSource) {
          return;
        }

        const rangeKey = `${node.from}:${node.to}`;

        if (!decoratedRanges.has(rangeKey)) {
          decoratedRanges.add(rangeKey);
          appendHtmlAttributeValueDecorations(decorations, source, node.from);
        }
        return false;
      }
    });
  }

  return Decoration.set(decorations, true);
}

/** 维护 HTML 属性值源码装饰。 */
class HtmlAttributeValueHighlightViewPlugin {
  public decorations: DecorationSet;

  /** 初始化可见区域装饰。 */
  public constructor(view: EditorView) {
    this.decorations = buildHtmlAttributeValueDecorations(view);
  }

  /** 在文档或视口变化后刷新属性值装饰。 */
  public update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildHtmlAttributeValueDecorations(update.view);
    }
  }
}

/** HTML 属性值统一源码颜色扩展。 */
export const editorHtmlSourceHighlightExtension = [
  ViewPlugin.fromClass(HtmlAttributeValueHighlightViewPlugin, {
    decorations: (plugin) => plugin.decorations
  }),
  EditorView.theme({
    '.cm-content .cm-editor-html-attribute-value, .cm-content .cm-editor-html-attribute-value *': {
      color: 'var(--ws-editor-htmlDomValueForeground) !important'
    }
  })
];
