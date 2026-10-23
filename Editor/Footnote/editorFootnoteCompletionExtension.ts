/**
 * 文件说明：解析 Markdown 脚注定义，并在输入脚注引用时提供带悬停说明的补全列表。
 */
import {
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete';
import {
  EditorState,
  StateEffect,
  StateField,
  type Range
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view';
const cornerDownLeftIcon = '<span class="icon icon-corner-down-left"></span>';
import {
  buildEditorFootnoteReferenceIndex,
  type EditorFootnoteReference,
  isExcludedFootnotePosition
} from '@editor/Footnote/editorFootnoteReferenceIndex';
import { navigateToFootnoteReference } from '@/services/footnoteNavigation';
import {
  FOOTNOTE_PROJECT_INDEX_UPDATED_EVENT,
  useFootnoteReferenceStore
} from '@/store/footnoteReferences';

const FOOTNOTE_DEFINITION_PATTERN = /^\s*\[\^([^\]\s]+)\]:\s*(.*)$/;
const FOOTNOTE_REFERENCE_PATTERN = /\[\^[^\]\s:]*$/;
const FOOTNOTE_SOURCE_PATTERN = /\[\^[^\]\s]+\](?::[^\r\n]*)?/g;
const MULTIPLE_FOOTNOTE_REFERENCE_COUNT = 2;

interface EditorFootnoteTooltipRequest {
  readonly footnoteId: string;
  readonly position: number;
}

interface EditorFootnoteDefinition {
  readonly id: string;
  readonly description: string;
}

/** 将脚注引用渲染为紧跟正文的上标标识。 */
class EditorFootnoteReferenceWidget extends WidgetType {
  /** 创建保留源码位置的脚注引用 Widget。 */
  public constructor(
    private readonly footnoteId: string,
    private readonly sourcePosition: number
  ) {
    super();
  }

  /** 比较脚注标识，避免无意义的 DOM 重建。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorFootnoteReferenceWidget
      && widget.footnoteId === this.footnoteId
      && widget.sourcePosition === this.sourcePosition;
  }

  /** 创建上标脚注引用 DOM，并允许点击后恢复源码编辑。 */
  public override toDOM(view: EditorView): HTMLElement {
    const reference = document.createElement('sup');
    reference.className = 'cm-editor-footnote-reference';
    reference.textContent = this.footnoteId;
    reference.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      view.dispatch({
        selection: { anchor: this.sourcePosition }
      });
      view.focus();
    });
    return reference;
  }

  /** 允许脚注 Widget 接收鼠标事件。 */
  public override ignoreEvent(): boolean {
    return false;
  }
}

/** 判断当前选区是否进入脚注引用源码范围。 */
function isFootnoteReferenceSelected(
  state: EditorState,
  from: number,
  to: number
): boolean {
  return state.selection.ranges.some((range) => (
    range.empty
      ? range.head >= from && range.head <= to
      : range.from < to && range.to > from
  ));
}

/** 合并当前编辑器实时引用与全项目引用，并移除已被磁盘索引覆盖的本地重复项。 */
function collectFootnoteReferences(
  view: EditorView,
  footnoteId: string
): readonly EditorFootnoteReference[] {
  const projectReferences = useFootnoteReferenceStore().getReferences(footnoteId);
  const localIndex = buildEditorFootnoteReferenceIndex(view.state);
  const localReferences = localIndex.referencesByFootnoteId.get(footnoteId) ?? [];
  const uniqueLocalReferences = localReferences.filter((localReference) => (
    !projectReferences.some((projectReference) => (
      projectReference.from === localReference.from
      && projectReference.to === localReference.to
      && projectReference.preview === localReference.preview
    ))
  ));

  return [...uniqueLocalReferences, ...projectReferences];
}

/** 脚注定义完成换行后的行尾回车图标。 */
class EditorFootnoteEnterWidget extends WidgetType {
  /** 创建带脚注 ID、位置和引用数量的图标 Widget。 */
  public constructor(
    private readonly footnoteId: string,
    private readonly position: number,
    private readonly referenceCount: number
  ) {
    super();
  }

  /** 比较图标关联数据，避免无意义的 DOM 重建。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorFootnoteEnterWidget
      && widget.footnoteId === this.footnoteId
      && widget.position === this.position
      && widget.referenceCount === this.referenceCount;
  }

  /** 创建脚注行尾回车图标 DOM。 */
  public override toDOM(view: EditorView): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'cm-editor-footnote-enter-icon';
    icon.innerHTML = cornerDownLeftIcon;
    icon.setAttribute('aria-hidden', 'true');

    if (this.referenceCount >= MULTIPLE_FOOTNOTE_REFERENCE_COUNT) {
      icon.classList.add('cm-editor-footnote-enter-icon--multiple');
    }

    icon.addEventListener('mousedown', (event) => {
      if (event.button !== 0 || this.referenceCount === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        effects: setEditorFootnoteTooltipEffect.of({
          footnoteId: this.footnoteId,
          position: this.position
        })
      });
      view.focus();
    });
    return icon;
  }

  /** 图标不接管编辑器事件。 */
  public override ignoreEvent(): boolean {
    return true;
  }
}

/** 收集当前文档中有效且唯一的脚注定义。 */
function collectEditorFootnoteDefinitions(state: EditorState): EditorFootnoteDefinition[] {
  const definitions = new Map<string, EditorFootnoteDefinition>();

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const match = FOOTNOTE_DEFINITION_PATTERN.exec(line.text);

    if (!match || isExcludedFootnotePosition(state, line.from + line.text.indexOf('[^'))) {
      continue;
    }

    if (!definitions.has(match[1])) {
      definitions.set(match[1], {
        id: match[1],
        description: match[2]
      });
    }
  }

  return [...definitions.values()];
}

/** 查找指定脚注引用及其当前文档定义描述。 */
function resolveEditorFootnoteReferenceDescription(
  state: EditorState,
  position: number
): { readonly from: number; readonly to: number; readonly description: string } | null {
  const referenceIndex = buildEditorFootnoteReferenceIndex(state);

  for (const [footnoteId, references] of referenceIndex.referencesByFootnoteId) {
    const reference = references.find((item) => (
      position >= item.from && position <= item.to
    ));

    if (!reference) {
      continue;
    }

    const definition = collectEditorFootnoteDefinitions(state).find((item) => (
      item.id === footnoteId
    ));
    const description = definition?.description.trim();

    return description
      ? { from: reference.from, to: reference.to, description }
      : null;
  }

  return null;
}

/** 鼠标悬停脚注上标时显示对应定义描述。 */
const editorFootnoteReferenceHoverTooltip = hoverTooltip((view, position) => {
  const resolved = resolveEditorFootnoteReferenceDescription(view.state, position);

  if (!resolved || isFootnoteReferenceSelected(view.state, resolved.from, resolved.to)) {
    return null;
  }

  return {
    pos: resolved.from,
    end: resolved.to,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-editor-footnote-reference-hover-tooltip';
      dom.textContent = resolved.description;
      return { dom };
    }
  };
});

/** 为当前可见区域中的脚注引用和定义创建统一前景色装饰。 */
function buildEditorFootnoteDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const decoratedDefinitionLines = new Set<number>();
  const referenceIndex = buildEditorFootnoteReferenceIndex(view.state);

  for (const references of referenceIndex.referencesByFootnoteId.values()) {
    for (const reference of references) {
      if (isFootnoteReferenceSelected(view.state, reference.from, reference.to)) {
        decorations.push(Decoration.mark({
          class: 'cm-editor-footnote-source'
        }).range(reference.from, reference.to));
        continue;
      }

      decorations.push(Decoration.replace({
        widget: new EditorFootnoteReferenceWidget(reference.footnoteId, reference.from)
      }).range(reference.from, reference.to));
    }
  }

  for (const { from, to } of view.visibleRanges) {
    const source = view.state.sliceDoc(from, to);

    for (const match of source.matchAll(FOOTNOTE_SOURCE_PATTERN)) {
      const matchFrom = from + (match.index ?? 0);

      if (isExcludedFootnotePosition(view.state, matchFrom)) {
        continue;
      }

      const line = view.state.doc.lineAt(matchFrom);
      if (!FOOTNOTE_DEFINITION_PATTERN.test(line.text)) {
        continue;
      }

      decorations.push(Decoration.mark({
        class: 'cm-editor-footnote-source'
      }).range(matchFrom, matchFrom + match[0].length));
    }

    const firstLine = view.state.doc.lineAt(from).number;
    const lastLine = view.state.doc.lineAt(to).number;

    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);

      const definitionMatch = FOOTNOTE_DEFINITION_PATTERN.exec(line.text);

      if (
        decoratedDefinitionLines.has(line.from)
        || line.to >= view.state.doc.length
        || !definitionMatch
        || isExcludedFootnotePosition(view.state, line.from + line.text.indexOf('[^'))
      ) {
        continue;
      }

      const references = collectFootnoteReferences(view, definitionMatch[1]);
      decoratedDefinitionLines.add(line.from);
      decorations.push(Decoration.widget({
        widget: new EditorFootnoteEnterWidget(
          definitionMatch[1],
          line.to,
          references.length
        ),
        side: 1
      }).range(line.to));
    }
  }

  return Decoration.set(decorations, true);
}

/** 切换当前脚注引用信息面板。 */
const setEditorFootnoteTooltipEffect = StateEffect.define<EditorFootnoteTooltipRequest | null>();

/** 创建指定脚注的引用信息 Tooltip。 */
function createEditorFootnoteReferencesTooltip(
  request: EditorFootnoteTooltipRequest
): Tooltip {
  return {
    pos: request.position,
    arrow: true,
    create(view) {
      const footnoteReferenceStore = useFootnoteReferenceStore();
      const references = collectFootnoteReferences(view, request.footnoteId);
      const dom = document.createElement('div');
      const list = document.createElement('ul');
      dom.className = 'cm-editor-footnote-references-tooltip';
      list.className = 'cm-editor-footnote-references-list';

      references.forEach((reference) => {
        const item = document.createElement('li');
        const file = reference.documentId
          ? footnoteReferenceStore.getFile(reference.documentId)
          : undefined;
        item.className = 'cm-editor-footnote-reference-item';
        item.textContent = file
          ? `${file.relativePath}: ${reference.preview}`
          : reference.preview;
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
          view.dispatch({ effects: setEditorFootnoteTooltipEffect.of(null) });

          if (reference.documentId) {
            navigateToFootnoteReference(reference);
            return;
          }

          view.dispatch({
            selection: { anchor: reference.from },
            scrollIntoView: true
          });
          view.focus();
        });
        list.append(item);
      });
      dom.append(list);
      return { dom };
    }
  };
}

/** 维护点击图标后打开的脚注引用信息面板。 */
const editorFootnoteTooltipStateField = StateField.define<EditorFootnoteTooltipRequest | null>({
  /** 初始化关闭状态。 */
  create() {
    return null;
  },
  /** 响应图标切换、文档变化与选区变化。 */
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorFootnoteTooltipEffect)) {
        return effect.value
          && value?.footnoteId === effect.value.footnoteId
          ? null
          : effect.value;
      }
    }

    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    return transaction.docChanged || selectionChanged
      ? null
      : value;
  },
  /** 将当前面板状态提供给 CodeMirror Tooltip。 */
  provide(field) {
    return showTooltip.from(field, (value) => (
      value ? createEditorFootnoteReferencesTooltip(value) : null
    ));
  }
});

/** 维护脚注源码前景色装饰。 */
class EditorFootnoteHighlightViewPlugin {
  public decorations: DecorationSet;

  /** 初始化脚注源码装饰。 */
  public constructor(private readonly view: EditorView) {
    this.decorations = buildEditorFootnoteDecorations(view);
    window.addEventListener(FOOTNOTE_PROJECT_INDEX_UPDATED_EVENT, this.handleProjectIndexUpdate);
  }

  /** 在文档或视口变化后刷新脚注源码装饰。 */
  public update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = buildEditorFootnoteDecorations(update.view);
    }
  }

  /** 释放全项目索引更新监听。 */
  public destroy(): void {
    window.removeEventListener(FOOTNOTE_PROJECT_INDEX_UPDATED_EVENT, this.handleProjectIndexUpdate);
  }

  /** 索引刷新后触发空事务，使图标引用数量重新计算。 */
  private readonly handleProjectIndexUpdate = (): void => {
    this.decorations = buildEditorFootnoteDecorations(this.view);
    this.view.dispatch({});
  };
}

/** 在输入 `[^` 后提供当前文档脚注引用补全。 */
function editorFootnoteCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  const token = context.matchBefore(FOOTNOTE_REFERENCE_PATTERN);

  if (!token || isExcludedFootnotePosition(context.state, token.from)) {
    return null;
  }

  const definitions = collectEditorFootnoteDefinitions(context.state);

  if (definitions.length === 0) {
    return null;
  }

  return {
    from: token.from + 2,
    options: definitions.map((definition) => ({
      label: definition.id,
      displayLabel: `[^${definition.id}]: ${definition.description}`,
      apply: `${definition.id}]`
    })),
    validFor: /^[^\]\s:]*$/
  };
}

/** Markdown 脚注补全扩展。 */
export const editorFootnoteCompletionExtension = [
  EditorState.languageData.of(() => [{
    autocomplete: editorFootnoteCompletionSource
  }]),
  editorFootnoteTooltipStateField,
  editorFootnoteReferenceHoverTooltip,
  ViewPlugin.fromClass(EditorFootnoteHighlightViewPlugin, {
    decorations: (plugin) => plugin.decorations
  }),
  EditorView.domEventHandlers({
    /** 点击图标之外的编辑器区域时关闭引用信息面板。 */
    mousedown(event, view) {
      const target = event.target;

      if (target instanceof Element && target.closest('.cm-editor-footnote-enter-icon')) {
        return false;
      }

      if (view.state.field(editorFootnoteTooltipStateField, false)) {
        view.dispatch({ effects: setEditorFootnoteTooltipEffect.of(null) });
      }
      return false;
    }
  }),
  keymap.of([{
    key: 'Escape',
    run(view) {
      if (!view.state.field(editorFootnoteTooltipStateField, false)) {
        return false;
      }

      view.dispatch({ effects: setEditorFootnoteTooltipEffect.of(null) });
      return true;
    }
  }]),
  EditorView.theme({
    '.cm-content .cm-editor-footnote-source, .cm-content .cm-editor-footnote-source *': {
      color: 'var(--ws-editor-footnoteForeground) !important'
    }
  })
];

/** 判断当前补全状态是否处于脚注引用输入范围。 */
export function isEditorFootnoteCompletionState(state: EditorState): boolean {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return FOOTNOTE_REFERENCE_PATTERN.test(state.sliceDoc(line.from, head))
    && !isExcludedFootnotePosition(state, head);
}
