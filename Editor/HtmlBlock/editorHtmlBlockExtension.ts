/**
 * 文件说明：将 Markdown 中独立的安全 HTML 元素及其内联样式渲染为 CodeMirror 块级 Widget。
 */
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';

import { createEditorBlockNavigationExtension } from '@editor/Block/editorBlockNavigationExtension';
import {
  createSanitizedEditorHtmlFragment,
  sanitizeEditorHtmlSource
} from '@editor/HtmlBlock/editorHtmlRenderer';

const HTML_CODE_NODE_NAMES = new Set(['FencedCode', 'InlineCode']);

interface EditorHtmlBlockMatch {
  readonly from: number;
  readonly to: number;
  readonly html: string;
}

interface EditorHtmlBlockState {
  readonly decorations: DecorationSet;
  readonly atomicRanges: DecorationSet;
  readonly editingBlockFrom: number | null;
}

/** 设置当前显示源码的 HTML 块行。 */
const setEditorHtmlBlockEditingEffect = StateEffect.define<number | null>();

/** 将 Lezer HTMLBlock 源码清洗为可安全渲染的嵌套 HTML。 */
function sanitizeEditorHtmlBlock(
  source: string,
  from: number,
  to: number
): EditorHtmlBlockMatch | null {
  const sanitizedSource = sanitizeEditorHtmlSource(source);
  if (sanitizedSource === null) return null;

  return {
    from,
    to,
    html: sanitizedSource
  };
}

/** 判断语法节点是否位于代码语法范围内。 */
function isInsideHtmlCodeNode(cursor: SyntaxNodeRef): boolean {
  let node = cursor.node.parent;

  while (node) {
    if (HTML_CODE_NODE_NAMES.has(node.name)) {
      return true;
    }
    node = node.parent;
  }

  return false;
}

/** 判断 Markdown 段落是否完全由独立 HTML 源码组成。 */
function isStandaloneHtmlParagraph(source: string): boolean {
  const trimmedSource = source.trim();

  return trimmedSource.startsWith('<')
    && trimmedSource.endsWith('>')
    && !trimmedSource.startsWith('<!--');
}

/** 判断语法节点是否为可渲染的独立 HTML 候选。 */
function isHtmlBlockCandidate(cursor: SyntaxNodeRef, source: string): boolean {
  return !isInsideHtmlCodeNode(cursor)
    && (cursor.name === 'HTMLBlock'
      || (cursor.name === 'Paragraph' && isStandaloneHtmlParagraph(source)));
}

/** 从 Markdown 语法树收集真实 HTML 块和独立 HTML 段落。 */
function collectEditorHtmlBlockMatches(state: EditorState): EditorHtmlBlockMatch[] {
  // 仅在短时间预算内同步解析，剩余语法交给 CodeMirror 后台解析。
  ensureSyntaxTree(state, state.doc.length, 80);
  const matches: EditorHtmlBlockMatch[] = [];

  syntaxTree(state).iterate({
    enter(cursor) {
      const source = state.sliceDoc(cursor.from, cursor.to);

      if (!isHtmlBlockCandidate(cursor, source)) {
        return;
      }

      const match = sanitizeEditorHtmlBlock(
        source,
        cursor.from,
        cursor.to
      );

      if (match) {
        matches.push(match);
      }
      return false;
    }
  });

  return matches;
}

/** 承载安全 HTML DOM 与点击编辑交互。 */
class EditorHtmlBlockWidget extends WidgetType {
  /** 创建 HTML 可视化块。 */
  public constructor(
    private readonly match: EditorHtmlBlockMatch,
    private readonly block: boolean
  ) {
    super();
  }

  /** 比较 Widget 内容，避免无意义的 DOM 重建。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorHtmlBlockWidget
      && widget.match.html === this.match.html
      && widget.block === this.block;
  }

  /** 创建保留 DOM 自身 style 的安全 HTML 块。 */
  public override toDOM(view: EditorView): HTMLElement {
    const widgetRoot = document.createElement('div');
    widgetRoot.className = this.block
      ? 'cm-editor-html-block'
      : 'cm-editor-html-block cm-editor-html-block--inline';
    widgetRoot.append(createSanitizedEditorHtmlFragment(this.match.html));
    widgetRoot.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      view.dispatch({
        effects: setEditorHtmlBlockEditingEffect.of(this.match.from),
        selection: { anchor: this.match.from },
        scrollIntoView: true
      });
      view.focus();
    });

    return widgetRoot;
  }

  /** 允许可视化块接收自身注册的鼠标事件。 */
  public override ignoreEvent(): boolean {
    return false;
  }
}

/** 判断当前选区是否仍位于指定 HTML 块语法节点范围。 */
function isSelectionOnHtmlBlock(state: EditorState, blockFrom: number): boolean {
  let blockTo: number | null = null;

  syntaxTree(state).iterate({
    enter(cursor) {
      const source = state.sliceDoc(cursor.from, cursor.to);

      if (cursor.from === blockFrom && isHtmlBlockCandidate(cursor, source)) {
        blockTo = cursor.to;
        return false;
      }

      return blockTo === null;
    }
  });

  return blockTo !== null
    && state.selection.ranges.some((range) => range.head >= blockFrom && range.head <= blockTo!);
}

/** 判断光标或选区是否接触 HTML 块源码范围。 */
function isHtmlBlockSelected(
  state: EditorState,
  match: EditorHtmlBlockMatch
): boolean {
  return state.selection.ranges.some((range) => (
    range.from <= match.to
    && range.to >= match.from
  ));
}

/** 单行 HTML 保留文本行结构，多行 HTML 使用块级装饰替换。 */
function createEditorHtmlBlockDecoration(
  state: EditorState,
  match: EditorHtmlBlockMatch,
  widget: WidgetType,
  block: boolean
): Range<Decoration> {
  if (!block) {
    return Decoration.replace({
      widget,
      inclusiveStart: true,
      inclusiveEnd: false
    }).range(match.from, match.to);
  }

  const endLine = state.doc.lineAt(match.to);
  const replacementTo = endLine.to < state.doc.length ? endLine.to + 1 : endLine.to;

  return Decoration.replace({
    widget,
    block: true,
    inclusiveStart: true,
    inclusiveEnd: false
  }).range(state.doc.lineAt(match.from).from, replacementTo);
}

/** 根据文档与编辑行构建 HTML 块装饰状态。 */
function buildEditorHtmlBlockState(
  state: EditorState,
  editingBlockFrom: number | null
): EditorHtmlBlockState {
  const decorationRanges: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  let hasEditingBlock = false;

  collectEditorHtmlBlockMatches(state).forEach((match) => {
    if (match.from === editingBlockFrom) {
      hasEditingBlock = true;
      return;
    }

    if (isHtmlBlockSelected(state, match)) {
      return;
    }

    const block = state.doc.lineAt(match.from).number !== state.doc.lineAt(match.to).number;
    const decoration = createEditorHtmlBlockDecoration(
      state,
      match,
      new EditorHtmlBlockWidget(match, block),
      block
    );
    decorationRanges.push(decoration);
    atomicRanges.push(decoration);
  });

  return {
    decorations: Decoration.set(decorationRanges, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    editingBlockFrom: hasEditingBlock ? editingBlockFrom : null
  };
}

/** 使用 CodeMirror 状态字段同步 HTML 块渲染与源码编辑态。 */
const editorHtmlBlockStateField = StateField.define<EditorHtmlBlockState>({
  /** 初始化文档中的 HTML 块装饰。 */
  create(state) {
    return buildEditorHtmlBlockState(state, null);
  },
  /** 在文档、选区或显式编辑状态变化时重建 HTML 块装饰。 */
  update(blockState, transaction) {
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    let editingBlockFrom = blockState.editingBlockFrom;
    let editingEffectChanged = false;

    if (transaction.docChanged && editingBlockFrom !== null) {
      editingBlockFrom = transaction.changes.mapPos(editingBlockFrom, 1);
    }

    transaction.effects.forEach((effect) => {
      if (effect.is(setEditorHtmlBlockEditingEffect)) {
        editingBlockFrom = effect.value;
        editingEffectChanged = true;
      }
    });

    if (
      !editingEffectChanged
      && editingBlockFrom !== null
      && selectionChanged
      && !isSelectionOnHtmlBlock(transaction.state, editingBlockFrom)
    ) {
      editingBlockFrom = null;
    }

    if (!transaction.docChanged && !selectionChanged && !editingEffectChanged) {
      return blockState;
    }

    return buildEditorHtmlBlockState(transaction.state, editingBlockFrom);
  },
  /** 向编辑器提供块级装饰与原子选区范围。 */
  provide(field) {
    return [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
    ];
  }
});

/** HTML 可视化块下一行向上导航或退格时通过共享基础逻辑恢复上方源码。 */
const editorHtmlBlockNavigationExtension = createEditorBlockNavigationExtension(
  collectEditorHtmlBlockMatches,
  (view, sourceRange) => {
    view.dispatch({
      effects: setEditorHtmlBlockEditingEffect.of(sourceRange.from),
      selection: { anchor: sourceRange.to },
      scrollIntoView: true,
      userEvent: 'select'
    });
  }
);

/** HTML 可视化块完整扩展。 */
export const editorHtmlBlockExtension = [
  editorHtmlBlockNavigationExtension,
  editorHtmlBlockStateField
];
