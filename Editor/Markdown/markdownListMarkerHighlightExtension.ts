/**
 * 文件说明：为所有 Markdown ListMark 节点提供独立语法高亮标签。
 */
import { styleTags, Tag } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Range } from '@codemirror/state';

/** Markdown 列表标记专用高亮标签。 */
export const markdownListMarkerTag = Tag.define();

/**
 * 将任意嵌套层级的 ListMark 节点绑定到列表标记专用标签。
 */
export const markdownListMarkerHighlightExtension: MarkdownConfig = {
  props: [
    styleTags({
      ListMark: markdownListMarkerTag
    })
  ]
};

const ORDERED_LIST_MARKER_PATTERN = /^(\s*\d{1,9}[.)])(?=\s)/;
const UNORDERED_LIST_MARKER_PATTERN = /^(\s*)([-+*])(?=\s)/;
const TASK_LIST_CONTENT_PATTERN = /^\s+\[[ xX]\](?=\s|$)/;

/** 将制表符和空格换算为列表悬挂缩进所需的视觉列数。 */
function measureListColumns(value: string): number {
  return Array.from(value).reduce(
    (columns, character) => columns + (character === '\t' ? 4 : 1),
    0
  );
}

/** 计算列表正文起始列，让软换行与正文保持对齐。 */
function getListContentOffset(lineText: string): number | null {
  const orderedMatch = /^(\s*\d{1,9}[.)])(\s+)/.exec(lineText);

  if (orderedMatch) {
    return measureListColumns(orderedMatch[1] + orderedMatch[2]);
  }

  const unorderedMatch = /^(\s*)([-+*])(\s+)/.exec(lineText);

  if (!unorderedMatch) {
    return null;
  }

  const taskMatch = /^\[[ xX]\](\s+)/.exec(lineText.slice(
    unorderedMatch[1].length + unorderedMatch[2].length + unorderedMatch[3].length
  ));

  return measureListColumns(
    unorderedMatch[1]
      + unorderedMatch[2]
      + unorderedMatch[3]
      + (taskMatch?.[0] ?? '')
  );
}

/** 计算带前导空白的普通文本正文列，让软换行保持原始缩进。 */
function getIndentedTextOffset(lineText: string): number | null {
  const indentationMatch = /^([\t ]+)(?=\S)/.exec(lineText);
  return indentationMatch ? measureListColumns(indentationMatch[1]) : null;
}

/**
 * 为可见区域内的有序和无序列表标记提供视觉兜底，兼容深缩进与不完整语法。
 */
function buildListMarkerFallback(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    let position = from;

    while (position <= to) {
      const line = view.state.doc.lineAt(position);
      const orderedMatch = ORDERED_LIST_MARKER_PATTERN.exec(line.text);
      const unorderedMatch = UNORDERED_LIST_MARKER_PATTERN.exec(line.text);
      const contentOffset = getListContentOffset(line.text) ?? getIndentedTextOffset(line.text);

      if (contentOffset !== null) {
        decorations.push(Decoration.line({
          attributes: {
            class: 'cm-markdown-hanging-line',
            style: `--workbench-editor-line-content-offset: ${contentOffset}ch`
          }
        }).range(line.from));
      }

      if (orderedMatch) {
        const markerStart = line.from + orderedMatch[1].search(/\d/);
        decorations.push(Decoration.mark({
          class: 'cm-markdown-ordered-list-marker-fallback'
        }).range(markerStart, line.from + orderedMatch[1].length));
      } else if (unorderedMatch) {
        const markerOffset = unorderedMatch[1].length;
        const markerEnd = markerOffset + unorderedMatch[2].length;
        const content = line.text.slice(markerEnd);

        if (!TASK_LIST_CONTENT_PATTERN.test(content)) {
          decorations.push(Decoration.mark({
            class: 'cm-markdown-unordered-list-marker'
          }).range(line.from + markerOffset, line.from + markerEnd));
        }
      }

      if (line.to >= to) break;
      position = line.to + 1;
    }
  }

  return Decoration.set(decorations, true);
}

/**
 * 监听文档、选区和视口变化，刷新列表标记的视觉兜底装饰。
 */
export const markdownListMarkerFallbackExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    /**
     * 初始化可见列表标记装饰。
     */
    constructor(view: EditorView) {
      this.decorations = buildListMarkerFallback(view);
    }

    /**
     * 在文档、选区和视口变化时刷新标记装饰。
     */
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildListMarkerFallback(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);
