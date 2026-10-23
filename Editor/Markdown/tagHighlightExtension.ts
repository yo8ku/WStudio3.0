/**
 * 文件说明：识别 Markdown 普通文本中的井号标签，并应用主题化的前景色与背景色。
 */
import { syntaxTree } from '@codemirror/language';
import type { Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { collectMarkdownInlineLinkRanges } from '@editor/Markdown/markdownInlineLink';

const TAG_PATTERN = /(^|[^\p{L}\p{N}_\-/])(#[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
const EXCLUDED_NODE_NAME_PARTS = ['Code', 'Image', 'Link', 'URL', 'Autolink'];
const HTML_NODE_NAMES = new Set(['HTMLBlock', 'HTMLTag']);

export interface MarkdownTagMatch {
  readonly label: string;
  readonly from: number;
}

/** Collects the same Markdown tag labels used by the editor tag highlighter. */
export function collectMarkdownTagLabels(content: string): MarkdownTagMatch[] {
  const values: MarkdownTagMatch[] = [];
  const inlineLinkRanges = collectMarkdownInlineLinkRanges(content);
  let offset = 0;
  let codeFence: '`' | '~' | undefined;

  for (const line of content.split(/\r?\n/u)) {
    const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      const nextFence = fence[1]?.[0] as '`' | '~' | undefined;
      codeFence = codeFence === nextFence ? undefined : codeFence ?? nextFence;
      offset += line.length + 1;
      continue;
    }

    if (!codeFence) {
      for (const match of line.matchAll(TAG_PATTERN)) {
        const boundaryLength = match[1].length;
        const matchFrom = offset + (match.index ?? 0) + boundaryLength;
        const isInlineLinkDestination = inlineLinkRanges.some((link) => (
          matchFrom >= link.destinationFrom && matchFrom < link.destinationTo
        ));

        if (!isInlineLinkDestination && match[2]) {
          values.push({ label: match[2], from: matchFrom });
        }
      }
    }

    offset += line.length + 1;
  }

  return values;
}

/** 判断标签是否位于 HTML、代码、链接或图片语法中。 */
function isExcludedTagPosition(view: EditorView, position: number): boolean {
  const tree = syntaxTree(view.state);
  let outerNode: SyntaxNode | null = tree.resolve(position, 1);

  while (outerNode) {
    if (HTML_NODE_NAMES.has(outerNode.name)) {
      return true;
    }
    outerNode = outerNode.parent;
  }

  let node: SyntaxNode | null = tree.resolveInner(position, 1);

  while (node) {
    if (EXCLUDED_NODE_NAME_PARTS.some((namePart) => node?.name.includes(namePart))) {
      return true;
    }

    node = node.parent;
  }

  return false;
}

/** 为当前可见区域构建标签装饰。 */
function buildTagDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const inlineLinkRanges = collectMarkdownInlineLinkRanges(view.state.doc.toString());

  for (const { from, to } of view.visibleRanges) {
    const visibleSource = view.state.sliceDoc(from, to);

    for (const match of visibleSource.matchAll(TAG_PATTERN)) {
      const boundaryLength = match[1].length;
      const matchFrom = from + (match.index ?? 0) + boundaryLength;
      const matchTo = matchFrom + match[2].length;
      const isInlineLinkDestination = inlineLinkRanges.some((link) => (
        matchFrom >= link.destinationFrom && matchFrom < link.destinationTo
      ));

      if (isInlineLinkDestination || isExcludedTagPosition(view, matchFrom)) {
        continue;
      }

      decorations.push(Decoration.mark({
        class: 'cm-markdown-tag'
      }).range(matchFrom, matchTo));
    }
  }

  return Decoration.set(decorations, true);
}

/** 维护当前可见区域的标签装饰。 */
class TagHighlightViewPlugin {
  decorations: DecorationSet;

  /** 初始化标签装饰。 */
  constructor(view: EditorView) {
    this.decorations = buildTagDecorations(view);
  }

  /** 在文档或视口变化后刷新标签装饰。 */
  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildTagDecorations(update.view);
    }
  }
}

/** 标签识别、装饰与主题扩展。 */
export const tagHighlightExtension = [
  ViewPlugin.fromClass(TagHighlightViewPlugin, {
    decorations: (plugin) => plugin.decorations
  }),
  EditorView.theme({
    '.cm-content .cm-markdown-tag': {
      backgroundColor: 'var(--ws-editor-tagBackground)',
      color: 'var(--ws-editor-tagForeground) !important',
      padding:'2px 10px',
      borderRadius: '15px',
    }
  })
];
