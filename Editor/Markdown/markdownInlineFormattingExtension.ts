/**
 * 文件说明：统一处理 Markdown 行内格式的渲染样式与光标命中时的源码显隐。
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import { collectMarkdownInlineLinkRanges } from '@editor/Markdown/markdownInlineLink';

type InlineDecorationAppender = (from: number, to: number, decoration: Decoration) => void;

/** 创建 Markdown 行内语法的开始标记装饰。 */
function createOpeningInlineMarkDecoration(isEditing: boolean, className: string): Decoration {
  return isEditing
    ? Decoration.mark({ class: className })
    : Decoration.replace({ inclusiveEnd: true });
}

/** 创建 Markdown 行内语法的结束标记装饰。 */
function createClosingInlineMarkDecoration(isEditing: boolean, className: string): Decoration {
  return isEditing
    ? Decoration.mark({ class: className })
    : Decoration.replace({ inclusiveStart: true });
}

/** 判断光标或选区是否与指定行内格式节点的完整源码范围相交。 */
function isInlineNodeEditing(view: EditorView, from: number, to: number): boolean {
  return view.state.selection.ranges.some((range) => (
    range.from <= to && range.to >= from
  ));
}

/** 为一个 Markdown 行内格式语法节点追加装饰。 */
export function appendMarkdownInlineNodeDecorations(
  view: EditorView,
  node: SyntaxNodeRef,
  add: InlineDecorationAppender,
  decoratedLinkRanges?: Set<string>
): boolean {
  const openingMark = node.node.firstChild;
  const closingMark = node.node.lastChild;

  if (node.type.name === 'Link') {
    const linkMarks: SyntaxNode[] = [];
    let destinationNode: SyntaxNode | null = null;
    let childNode = openingMark;

    while (childNode) {
      if (childNode.name === 'LinkMark') {
        linkMarks.push(childNode);
      } else if (childNode.name === 'URL') {
        destinationNode = childNode;
      }
      childNode = childNode.nextSibling;
    }

    const labelClosingMark = linkMarks[1];
    const destinationOpeningMark = linkMarks[2];

    if (
      openingMark?.name !== 'LinkMark'
      || labelClosingMark?.name !== 'LinkMark'
      || destinationOpeningMark?.name !== 'LinkMark'
      || destinationNode === null
      || closingMark?.name !== 'LinkMark'
      || linkMarks.length !== 4
      || openingMark.to > labelClosingMark.from
      || destinationOpeningMark.to > destinationNode.from
      || destinationNode.to > closingMark.from
    ) return false;

    const isEditing = isInlineNodeEditing(view, openingMark.from, closingMark.to);
    decoratedLinkRanges?.add(`${openingMark.from}:${closingMark.to}`);

    if (isEditing) {
      add(openingMark.from, closingMark.to, Decoration.mark({
        class: 'cm-markdown-inline-link-source'
      }));
      return true;
    }

    add(openingMark.from, openingMark.to, Decoration.replace({ inclusiveEnd: true }));
    add(openingMark.to, labelClosingMark.from, Decoration.mark({
      class: 'cm-markdown-inline-link-content'
    }));
    add(labelClosingMark.from, closingMark.to, Decoration.replace({ inclusiveStart: true }));
    return true;
  }

  if (node.type.name === 'InlineCode') {
    if (
      openingMark?.name !== 'CodeMark'
      || closingMark?.name !== 'CodeMark'
      || openingMark.to > closingMark.from
    ) return false;

    const isEditing = isInlineNodeEditing(view, openingMark.from, closingMark.to);
    add(openingMark.from, openingMark.to, createOpeningInlineMarkDecoration(isEditing, 'cm-markdown-inline-code-source'));
    add(openingMark.to, closingMark.from, Decoration.mark({ class: 'cm-markdown-inline-code-content' }));
    add(closingMark.from, closingMark.to, createClosingInlineMarkDecoration(isEditing, 'cm-markdown-inline-code-source'));
    return true;
  }

  if (node.type.name === 'Emphasis') {
    if (
      openingMark?.name !== 'EmphasisMark'
      || closingMark?.name !== 'EmphasisMark'
      || openingMark.to > closingMark.from
    ) return false;

    const isEditing = isInlineNodeEditing(view, openingMark.from, closingMark.to);
    const nestedStrong = openingMark.nextSibling;
    add(openingMark.from, openingMark.to, createOpeningInlineMarkDecoration(isEditing, 'cm-markdown-italic-source'));

    if (nestedStrong?.name === 'StrongEmphasis') {
      const nestedOpeningMark = nestedStrong.firstChild;
      const nestedClosingMark = nestedStrong.lastChild;
      if (nestedOpeningMark?.name === 'EmphasisMark' && nestedClosingMark?.name === 'EmphasisMark') {
        add(nestedOpeningMark.from, nestedOpeningMark.to, createOpeningInlineMarkDecoration(isEditing, 'cm-markdown-strong-source'));
        add(nestedOpeningMark.to, nestedClosingMark.from, Decoration.mark({
          class: 'cm-markdown-italic-content cm-markdown-strong-content'
        }));
        add(nestedClosingMark.from, nestedClosingMark.to, createClosingInlineMarkDecoration(isEditing, 'cm-markdown-strong-source'));
      }
    } else {
      add(openingMark.to, closingMark.from, Decoration.mark({ class: 'cm-markdown-italic-content' }));
    }

    add(closingMark.from, closingMark.to, createClosingInlineMarkDecoration(isEditing, 'cm-markdown-italic-source'));
    return true;
  }

  const format = node.type.name === 'Highlight'
    ? { mark: 'HighlightMark', source: 'cm-markdown-highlight-source', content: 'cm-markdown-highlight-content' }
    : node.type.name === 'Strikethrough'
      ? { mark: 'StrikethroughMark', source: 'cm-markdown-delete-source', content: 'cm-markdown-delete-content' }
      : node.type.name === 'StrongEmphasis'
        ? { mark: 'EmphasisMark', source: 'cm-markdown-strong-source', content: 'cm-markdown-strong-content' }
        : null;

  if (
    !format
    || openingMark?.name !== format.mark
    || closingMark?.name !== format.mark
    || openingMark.to > closingMark.from
  ) return false;

  const isEditing = isInlineNodeEditing(view, openingMark.from, closingMark.to);
  add(openingMark.from, openingMark.to, createOpeningInlineMarkDecoration(isEditing, format.source));
  add(openingMark.to, closingMark.from, Decoration.mark({ class: format.content }));
  add(closingMark.from, closingMark.to, createClosingInlineMarkDecoration(isEditing, format.source));
  return true;
}

/** 为当前编辑器构建所有 Markdown 行内格式装饰。 */
function buildMarkdownInlineFormattingDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const decoratedLinkRanges = new Set<string>();
  // 限制初始化同步解析时间，避免行内装饰阻塞编辑器首屏绘制。
  const parsedTree = ensureSyntaxTree(view.state, view.state.doc.length, 80) ?? syntaxTree(view.state);

  view.visibleRanges.forEach((range) => {
    parsedTree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (appendMarkdownInlineNodeDecorations(view, node, (from, to, decoration) => {
          ranges.push(decoration.range(from, to));
        }, decoratedLinkRanges)) return false;
      }
    });
  });

  for (const link of collectMarkdownInlineLinkRanges(view.state.doc.toString())) {
    const isVisible = view.visibleRanges.some(({ from, to }) => link.from <= to && link.to >= from);

    if (!isVisible || decoratedLinkRanges.has(`${link.from}:${link.to}`)) {
      continue;
    }

    if (isInlineNodeEditing(view, link.from, link.to)) {
      ranges.push(Decoration.mark({
        class: 'cm-markdown-inline-link-source'
      }).range(link.from, link.to));
      continue;
    }

    ranges.push(Decoration.replace({ inclusiveEnd: true }).range(link.from, link.labelFrom));
    ranges.push(Decoration.mark({
      class: 'cm-markdown-inline-link-content'
    }).range(link.labelFrom, link.labelTo));
    ranges.push(Decoration.replace({ inclusiveStart: true }).range(link.labelTo, link.to));
  }

  return Decoration.set(ranges, true);
}

/** Markdown 行内格式源码显隐扩展。 */
export const markdownInlineFormattingExtension = ViewPlugin.fromClass(
  class {
    public decorations: DecorationSet;

    /** 初始化行内格式装饰。 */
    public constructor(view: EditorView) {
      this.decorations = buildMarkdownInlineFormattingDecorations(view);
    }

    /** 在文档、选择、焦点或视口变化后刷新装饰。 */
    public update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
        this.decorations = buildMarkdownInlineFormattingDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/** Markdown 行内格式共享视觉主题。 */
export const markdownInlineFormattingTheme = EditorView.theme({
  '.cm-markdown-inline-link-content, .cm-markdown-inline-link-content *': {
    color: 'var(--ws-link-foreground) !important',
    cursor: 'pointer'
  },
  '.cm-markdown-inline-link-content:hover, .cm-markdown-inline-link-content:hover *, .cm-markdown-inline-link-content--preview-active, .cm-markdown-inline-link-content--preview-active *': {
    color: 'var(--ws-editor-linkHoverForeground) !important'
  },
  '.cm-markdown-inline-link-source, .cm-markdown-inline-link-source *': {
    color: 'var(--ws-editor-linkForeground) !important'
  },
  '.cm-markdown-strong-content, .cm-markdown-strong-content *': {
    color: 'var(--ws-editor-strongForeground) !important',
    fontSize: 'var(--workbench-editor-strong-font-size)',
    fontWeight: 'var(--workbench-editor-strong-font-weight) !important'
  },
  '.cm-markdown-strong-source, .cm-markdown-strong-source *': {
    color: 'var(--ws-editor-strongForeground) !important',
    fontSize: 'var(--workbench-editor-strong-font-size)'
  },
  '.cm-markdown-italic-content, .cm-markdown-italic-content *': {
    color: 'var(--ws-editor-italicForeground) !important',
    fontStyle: 'italic !important'
  },
  '.cm-markdown-italic-source, .cm-markdown-italic-source *': {
    color: 'var(--ws-foreground) !important'
  },
  '.cm-markdown-delete-content, .cm-markdown-delete-content *': {
    color: 'var(--ws-editor-deleteForeground) !important',
    textDecorationLine: 'line-through',
    textDecorationThickness: 'var(--workbench-editor-delete-line-width)'
  },
  '.cm-markdown-delete-source, .cm-markdown-delete-source *': {
    color: 'var(--ws-editor-deleteForeground) !important'
  },
  '.cm-markdown-highlight-content, .cm-markdown-highlight-content *': {
    paddingInline: 'var(--workbench-editor-highlight-padding-x)',
    color: 'var(--ws-editor-highlightForeground) !important',
    backgroundColor: 'var(--ws-editor-highlightBackground)',
    borderRadius: 'var(--workbench-editor-highlight-radius)'
  },
  '.cm-markdown-highlight-source, .cm-markdown-highlight-source *': {
    backgroundColor: 'var(--ws-editor-highlightBackground)',
    borderRadius: 'var(--workbench-editor-highlight-radius)'
  },
  '.cm-markdown-inline-code-content, .cm-markdown-inline-code-content *': {
    paddingInline: 'var(--workbench-editor-inline-code-padding-x)',
    color: 'var(--ws-editor-inlineCodeForeground) !important',
    backgroundColor: 'var(--ws-editor-inlineCodeBackground)',
    borderRadius: 'var(--workbench-editor-inline-code-radius)'
  },
  '.cm-markdown-inline-code-source, .cm-markdown-inline-code-source *': {
    color: 'var(--ws-foreground) !important',
    backgroundColor: 'var(--ws-editor-inlineCodeBackground)',
    borderRadius: 'var(--workbench-editor-inline-code-radius)'
  }
});
