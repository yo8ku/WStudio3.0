/**
 * 文件说明：集中定义主编辑器与只读嵌入视图共用的 Markdown 渲染扩展。
 */
import { EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  HighlightStyle,
  defaultHighlightStyle,
  syntaxHighlighting
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { Strikethrough } from '@lezer/markdown';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { editorCodeBlockExtension } from '@editor/CodeBlock/editorCodeBlockExtension';
import {
  editorCodeBlockHighlightStyle,
  editorCodeBlockLanguages
} from '@editor/CodeBlock/editorCodeBlockSyntaxHighlight';
import {
  editorHtmlHighlightStyle,
  editorHtmlLanguageSupport
} from '@editor/HtmlBlock/editorHtmlSyntaxHighlight';
import { markdownHighlightExtension } from './markdownHighlightExtension';
import {
  markdownInlineFormattingExtension,
  markdownInlineFormattingTheme
} from './markdownInlineFormattingExtension';
import {
  markdownListMarkerFallbackExtension,
  markdownListMarkerHighlightExtension,
  markdownListMarkerTag
} from './markdownListMarkerHighlightExtension';
import { tagHighlightExtension } from './tagHighlightExtension';
import { collectMarkdownHeadingPrefixRanges } from './markdownHeadingModel';
import { isSelectionOnDocumentLine } from './markdownSelectionState';

const workbenchDefaultHighlightStyle = HighlightStyle.define([
  ...defaultHighlightStyle.specs.map((spec) => (
  spec.tag === tags.heading
    ? {
      ...spec,
      textDecoration: 'none',
      color: 'var(--ws-editor-heading-foreground)',
      fontWeight: 'var(--workbench-editor-heading-font-weight)'
    }
    : spec
  )),
  {
    tag: tags.contentSeparator,
    color: 'var(--ws-foreground)'
  },
  {
    tag: markdownListMarkerTag,
    color: 'var(--ws-editor-orderedListMarkerForeground)'
  }
]);

/** 主编辑器和嵌入视图共享的基础 Markdown token 颜色。 */
export const editorMarkdownHighlightStyle = syntaxHighlighting(workbenchDefaultHighlightStyle);

/** 主编辑器和嵌入视图共享的正文排版规则。 */
export const editorMarkdownDocumentTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--workbench-editor-font-size)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--workbench-editor-font-family)'
  },
  '.cm-content': {
    lineHeight: 'var(--workbench-editor-line-height)'
  },
  '.cm-line': {
    lineHeight: 'var(--workbench-editor-line-height)'
  }
});

/** 标题行布局与字体样式，可由同一工作台编辑器中的嵌入视图继承。 */
export const editorMarkdownHeadingTheme = EditorView.theme({
  '.cm-line.cm-markdown-heading': {
    fontSize: 'var(--workbench-editor-heading-fontSize)',
    lineHeight: 'var(--workbench-editor-heading-line-height)',
    textAlign: 'var(--workbench-editor-heading-align)'
  },
  // 标题行拥有字号；行内加粗及源码标记继承它，避免套用正文的固定字号。
  '.cm-line.cm-markdown-heading span': {
    fontSize: 'inherit'
  },
  '.cm-markdown-heading-gap.cm-markdown-heading-marker--hidden': {
    // Compress only the hidden, inactive prefix. While editing, keep the separator
    // space at its natural width so it remains visible and behaves like a space.
    marginLeft: 'var(--workbench-editor-heading-prefix-gap)'
  },
  '.cm-markdown-heading-marker, .cm-markdown-heading-marker *': {
    color: 'var(--ws-editor-heading-foreground) !important'
  },
  '.cm-markdown-heading-marker--hidden, .cm-markdown-heading-marker--hidden *': {
    visibility: 'hidden'
  },
  // 隐藏源码标记仍保留排版宽度；负缩进抵消它，保持标题正文与未装饰状态一致。
  '.cm-line.cm-markdown-heading-prefix-hidden.cm-markdown-heading-1': {
    textIndent: 'calc(-1ch - 0.28em - var(--workbench-editor-heading-prefix-gap))'
  },
  '.cm-line.cm-markdown-heading-prefix-hidden.cm-markdown-heading-2': {
    textIndent: 'calc(-2ch - 0.28em - var(--workbench-editor-heading-prefix-gap))'
  },
  '.cm-line.cm-markdown-heading-prefix-hidden.cm-markdown-heading-3': {
    textIndent: 'calc(-3ch - 0.28em - var(--workbench-editor-heading-prefix-gap))'
  },
  '.cm-line.cm-markdown-heading-prefix-hidden.cm-markdown-heading-4': {
    textIndent: 'calc(-4ch - 0.28em - var(--workbench-editor-heading-prefix-gap))'
  },
  '.cm-line.cm-markdown-heading-prefix-hidden.cm-markdown-heading-5': {
    textIndent: 'calc(-5ch - 0.28em - var(--workbench-editor-heading-prefix-gap))'
  },
  '.cm-line.cm-markdown-heading-prefix-hidden.cm-markdown-heading-6': {
    textIndent: 'calc(-6ch - 0.28em - var(--workbench-editor-heading-prefix-gap))'
  }
});

function buildMarkdownHeadingDecorations(
  view: EditorView,
  headings: ReturnType<typeof collectMarkdownHeadingPrefixRanges>
): DecorationSet {
  const lineClasses = new Map<number, Set<string>>();
  const prefixRanges = new Map<number, { markerTo: number; prefixTo: number }>();

  const appendLineClass = (lineFrom: number, className: string): void => {
    const classes = lineClasses.get(lineFrom) ?? new Set<string>();
    classes.add(className);
    lineClasses.set(lineFrom, classes);
  };

  for (const heading of headings) {
    appendLineClass(heading.lineFrom, 'cm-markdown-heading');
    appendLineClass(heading.lineFrom, `cm-markdown-heading-${heading.level}`);
    if (heading.markerTo !== undefined && heading.prefixTo !== undefined) {
      prefixRanges.set(heading.lineFrom, {
        markerTo: heading.markerTo,
        prefixTo: heading.prefixTo
      });
    }
  }

  const builder = new RangeSetBuilder<Decoration>();

  Array.from(new Set([...lineClasses.keys(), ...prefixRanges.keys()]))
    .sort((left, right) => left - right)
    .forEach((lineFrom) => {
      const classes = lineClasses.get(lineFrom);
      const prefixRange = prefixRanges.get(lineFrom);
      const isEditing = isSelectionOnDocumentLine(view, lineFrom);
      if (classes && prefixRange && !isEditing) {
        classes.add('cm-markdown-heading-prefix-hidden');
      }
      if (classes) {
        builder.add(lineFrom, lineFrom, Decoration.line({
          attributes: { class: Array.from(classes).join(' ') }
        }));
      }
      if (!prefixRange) return;
      builder.add(lineFrom, prefixRange.markerTo, Decoration.mark({
        class: isEditing
          ? 'cm-markdown-heading-marker'
          : 'cm-markdown-heading-marker cm-markdown-heading-marker--hidden'
      }));
      if (prefixRange.markerTo < prefixRange.prefixTo) {
        builder.add(prefixRange.markerTo, prefixRange.prefixTo, Decoration.mark({
          class: isEditing
            ? 'cm-markdown-heading-gap'
            : 'cm-markdown-heading-gap cm-markdown-heading-marker--hidden'
        }));
      }
    });

  return builder.finish();
}

/** 在只读状态下渲染标题行并隐藏非活动标题前缀。 */
export const editorMarkdownHeadingDecorationsExtension = ViewPlugin.fromClass(
  class {
    public decorations: DecorationSet;
    private headings: ReturnType<typeof collectMarkdownHeadingPrefixRanges>;

    public constructor(view: EditorView) {
      this.headings = collectMarkdownHeadingPrefixRanges(view.state);
      this.decorations = buildMarkdownHeadingDecorations(view, this.headings);
    }

    public update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.headings = collectMarkdownHeadingPrefixRanges(update.state);
      }
      if (update.docChanged || update.selectionSet || update.focusChanged) {
        this.decorations = buildMarkdownHeadingDecorations(update.view, this.headings);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

/** 嵌入块使用与工作台一致的只读 Markdown、标题和代码块渲染栈。 */
export const editorMarkdownReadOnlyExtensions = [
  markdown({
    addKeymap: false,
    codeLanguages: editorCodeBlockLanguages,
    htmlTagLanguage: editorHtmlLanguageSupport,
    extensions: [Strikethrough, markdownHighlightExtension, markdownListMarkerHighlightExtension]
  }),
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.lineWrapping,
  editorMarkdownDocumentTheme,
  editorCodeBlockExtension,
  editorMarkdownHeadingDecorationsExtension,
  editorMarkdownHeadingTheme,
  markdownInlineFormattingExtension,
  markdownInlineFormattingTheme,
  markdownListMarkerFallbackExtension,
  tagHighlightExtension,
  editorMarkdownHighlightStyle,
  syntaxHighlighting(editorCodeBlockHighlightStyle),
  syntaxHighlighting(editorHtmlHighlightStyle),
  EditorView.theme({
    '&': { height: 'auto', backgroundColor: 'transparent' },
    '.cm-scroller': { overflow: 'visible' },
    '.cm-content': { padding: '0' }
  })
];
