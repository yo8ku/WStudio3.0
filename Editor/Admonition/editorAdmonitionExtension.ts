/**
 * 文件说明：默认渲染可直接编辑的 Markdown 标注卡片，并提供源码模式入口。
 */
import { Compartment, EditorState, Prec, StateEffect, StateField, type Range } from '@codemirror/state';
import { redo, standardKeymap, undo } from '@codemirror/commands';
import { Decoration, type DecorationSet, drawSelection, EditorView, keymap, WidgetType } from '@codemirror/view';
import { createIconButton } from '@/components/WsIconButton/iconButton';
const admonitionIcon = '<span class="icon icon-circle-alert"></span>';
const editorCodeIcon = '<span class="icon icon-editor-code"></span>';
const importantAdmonitionIcon = '<span class="icon icon-message"></span>';
const warningAdmonitionIcon = '<span class="icon icon-warning"></span>';
const cautionAdmonitionIcon = '<span class="icon icon-error"></span>';
const tipAdmonitionIcon = '<span class="icon icon-tip"></span>';

interface EditorAdmonitionMatch {
  readonly from: number;
  readonly titleTo: number;
  readonly to: number;
  readonly type: string;
  readonly rawTitle: string;
  readonly openingPrefix: string;
  readonly content: string;
  readonly contentPrefix: string;
}

interface EditorAdmonitionState {
  readonly decorations: DecorationSet;
  readonly atomicRanges: DecorationSet;
  readonly editingBlockFrom: number | null;
}

export const setEditorAdmonitionEditingEffect = StateEffect.define<number | null>();

/** 将无引用符号的消息框标题规范化，并进入标准引用内容行。 */
function enterAdmonitionContent(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  const shorthandMatch = /^(\s*)(\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\].*?)\s*$/i.exec(line.text);
  if (!shorthandMatch) return false;

  const indent = shorthandMatch[1];
  const insert = `${indent}> ${shorthandMatch[2]}\n${indent}> `;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length },
    scrollIntoView: true,
    userEvent: 'input'
  });
  return true;
}

/** 获取位于消息框正文行末尾的光标位置、缩进与正文状态。 */
function getAdmonitionContentCursor(view: EditorView): {
  head: number;
  indent: string;
  lineFrom: number;
  hasContent: boolean;
} | null {
  const selection = view.state.selection.main;
  if (!selection.empty) return null;

  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return null;
  const contentMatch = /^(\s*)>\s?(.*)$/.exec(line.text);
  if (!contentMatch) return null;
  const belongsToAdmonition = collectEditorAdmonitionMatches(view.state)
    .some((match) => line.from > match.from && line.to <= match.to);
  if (!belongsToAdmonition) return null;

  return {
    head: selection.head,
    indent: contentMatch[1],
    lineFrom: line.from,
    hasContent: contentMatch[2].trim().length > 0
  };
}

/** 在消息框正文中按回车时续写内容，空引用行再次回车时退出。 */
function handleAdmonitionContentEnter(view: EditorView): boolean {
  const cursor = getAdmonitionContentCursor(view);
  if (!cursor) return false;

  if (cursor.hasContent) {
    const insert = `\n${cursor.indent}> `;
    view.dispatch({
      changes: { from: cursor.head, insert },
      selection: { anchor: cursor.head + insert.length },
      scrollIntoView: true,
      userEvent: 'input'
    });
    return true;
  }

  view.dispatch({
    changes: { from: cursor.lineFrom, to: cursor.head, insert: '' },
    selection: { anchor: cursor.lineFrom },
    scrollIntoView: true,
    userEvent: 'input'
  });
  return true;
}

/** 在消息框正文末尾按 Shift+Enter 时继续新的引用内容行。 */
function continueAdmonitionContent(view: EditorView): boolean {
  const cursor = getAdmonitionContentCursor(view);
  if (!cursor) return false;

  const insert = `\n${cursor.indent}> `;
  view.dispatch({
    changes: { from: cursor.head, insert },
    selection: { anchor: cursor.head + insert.length },
    scrollIntoView: true,
    userEvent: 'input'
  });
  return true;
}

/** 消息框后的首个普通段落按回车时强制插入普通行，阻止引用标记延续。 */
function insertPlainLineAfterAdmonition(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to || /^\s*>/.test(line.text)) return false;
  if (/^\s*(?:\d+[.)]|[-+*])\s+/.test(line.text)) return false;
  const followsAdmonition = collectEditorAdmonitionMatches(view.state)
    .some((match) => {
      const endLineNumber = view.state.doc.lineAt(match.to).number;
      if (endLineNumber >= line.number) return false;
      for (let lineNumber = endLineNumber + 1; lineNumber <= line.number; lineNumber += 1) {
        const text = view.state.doc.line(lineNumber).text;
        if (text.trim().length === 0 || /^\s*>/.test(text)) return false;
      }
      return true;
    });
  if (!followsAdmonition) return false;

  view.dispatch({
    changes: { from: selection.head, insert: '\n' },
    selection: { anchor: selection.head + 1 },
    scrollIntoView: true,
    userEvent: 'input'
  });
  return true;
}

/** 扫描标准引用语法及省略引用符号的单行消息框语法。 */
function collectEditorAdmonitionMatches(state: EditorState): EditorAdmonitionMatch[] {
  const matches: EditorAdmonitionMatch[] = [];
  let lineNumber = 1;

  while (lineNumber <= state.doc.lines) {
    const openingLine = state.doc.line(lineNumber);
    const openingMatch = /^(\s*(?:>\s*)?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*)(.*)$/i.exec(openingLine.text);
    if (!openingMatch) {
      lineNumber += 1;
      continue;
    }

    const openingPrefix = openingMatch[1];
    const rawTitle = openingMatch[3] ?? '';
    const titleTo = openingLine.from + openingPrefix.length + rawTitle.trimEnd().length;

    const contentLines: string[] = [];
    let contentPrefix = /^\s*>\s?/.exec(openingLine.text)?.[0] ?? '> ';
    let endLineNumber = lineNumber;
    const usesBlockquoteSyntax = /^\s*>/.test(openingLine.text);
    if (usesBlockquoteSyntax) {
      for (let nextLineNumber = lineNumber + 1; nextLineNumber <= state.doc.lines; nextLineNumber += 1) {
        const line = state.doc.line(nextLineNumber);
        const contentMatch = /^(\s*>\s?)(.*)$/.exec(line.text);
        if (!contentMatch) break;
        contentPrefix = contentLines.length === 0 ? contentMatch[1] : contentPrefix;
        contentLines.push(contentMatch[2]);
        endLineNumber = nextLineNumber;
      }
    }

    const endLine = state.doc.line(endLineNumber);
    matches.push({
      from: openingLine.from,
      titleTo,
      to: endLine.to,
      type: openingMatch[2].toUpperCase(),
      rawTitle,
      openingPrefix,
      content: contentLines.join('\n'),
      contentPrefix
    });
    lineNumber = endLineNumber + 1;
  }

  return matches;
}

/** Return the caret location for source mode without placing it in the Markdown marker. */
export function getEditorAdmonitionSourceSelection(
  state: EditorState,
  from: number
): number | undefined {
  return collectEditorAdmonitionMatches(state).find(match => match.from === from)?.titleTo;
}

/** 将渲染态标题与正文写回标注 Markdown，同时保留原有引用语法前缀。 */
export function buildEditorAdmonitionSource(
  state: EditorState,
  from: number,
  title: string,
  content: string
): { from: number; to: number; insert: string } | undefined {
  const match = collectEditorAdmonitionMatches(state).find(candidate => candidate.from === from);
  if (!match) return undefined;

  const normalizedTitle = title.replace(/[\r\n]+/g, ' ');
  const normalizedContent = content.replace(/\r\n?/g, '\n');
  const sourceOpeningPrefix = normalizedContent.length > 0 && !/^\s*>/.test(match.openingPrefix)
    ? match.openingPrefix.replace(/^(\s*)/, '$1> ')
    : match.openingPrefix;
  const openingPrefix = normalizedTitle && !/\s$/.test(sourceOpeningPrefix)
    ? `${sourceOpeningPrefix} `
    : sourceOpeningPrefix;
  const contentSource = normalizedContent === match.content
    ? state.sliceDoc(state.doc.lineAt(match.from).to, match.to)
    : `\n${normalizedContent.split('\n').map(line => `${match.contentPrefix}${line}`).join('\n')}`;

  return {
    from: match.from,
    to: match.to,
    insert: `${openingPrefix}${normalizedTitle}${contentSource}`
  };
}

/** 读取 contenteditable 的可见文本，并将浏览器生成的块节点转换为换行。 */
function readEditorAdmonitionEditableText(root: HTMLElement): string {
  const readNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement)) return '';
    if (node.tagName === 'BR') return node === node.parentNode?.lastChild ? '' : '\n';

    const children = Array.from(node.childNodes);
    const text = children.reduce((result, child, index) => {
      const childText = readNode(child);
      const childIsBlock = child instanceof HTMLElement && ['DIV', 'P'].includes(child.tagName);
      const needsSeparator = childIsBlock && result.length > 0 && !result.endsWith('\n');
      const needsTrailingSeparator = childIsBlock
        && index < children.length - 1
        && childText.length > 0
        && !childText.endsWith('\n');
      return `${result}${needsSeparator ? '\n' : ''}${childText}${needsTrailingSeparator ? '\n' : ''}`;
    }, '');

    return text;
  };

  return readNode(root);
}

interface EditorAdmonitionBinding {
  match: EditorAdmonitionMatch;
  title: HTMLElement;
  contentEditor: EditorView | null;
  readonlyConfig: Compartment;
  syncingContent: boolean;
  composing: boolean;
}

const editorAdmonitionBindings = new WeakMap<HTMLElement, EditorAdmonitionBinding>();

/** 把卡片内的标题或正文输入同步到 CodeMirror 文档。 */
function updateEditorAdmonitionFromWidget(
  view: EditorView,
  binding: EditorAdmonitionBinding
): void {
  if (binding.composing || view.state.readOnly || !view.state.facet(EditorView.editable)) return;

  const replacement = buildEditorAdmonitionSource(
    view.state,
    binding.match.from,
    readEditorAdmonitionEditableText(binding.title),
    binding.contentEditor?.state.doc.toString() ?? binding.match.content
  );
  if (!replacement) return;

  const currentSource = view.state.sliceDoc(replacement.from, replacement.to);
  if (currentSource === replacement.insert) return;
  // 只提交变化的文本，保护主文档选区、相邻块和撤销历史的位置映射。
  let start = 0;
  let oldEnd = currentSource.length;
  let newEnd = replacement.insert.length;
  while (start < oldEnd && start < newEnd && currentSource[start] === replacement.insert[start]) start += 1;
  while (oldEnd > start && newEnd > start && currentSource[oldEnd - 1] === replacement.insert[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  view.dispatch({
    changes: {
      from: replacement.from + start,
      to: replacement.from + oldEnd,
      insert: replacement.insert.slice(start, newEnd)
    },
    userEvent: 'input'
  });
  view.requestMeasure();
}

/** 判断选区是否接触标注块源码范围。 */
function isAdmonitionSelected(state: EditorState, match: EditorAdmonitionMatch): boolean {
  return state.selection.ranges.some((range) => range.from <= match.to && range.to >= match.from);
}

/** 承载标注头部与内容区域的块级 Widget。 */
class EditorAdmonitionWidget extends WidgetType {
  public constructor(
    private readonly match: EditorAdmonitionMatch,
    private readonly canEdit: boolean
  ) {
    super();
  }

  /** 文本变化时交给 updateDOM 更新，避免打断卡片内的光标和中文输入。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorAdmonitionWidget
      && widget.match.type === this.match.type
      && widget.canEdit === this.canEdit;
  }

  public override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const binding = editorAdmonitionBindings.get(dom);
    if (!binding || binding.match.type !== this.match.type) return false;
    binding.match = this.match;
    const root = dom.querySelector<HTMLElement>('.cm-editor-admonition');
    if (root) root.dataset.admonitionFrom = String(this.match.from);
    const editable = !view.state.readOnly && view.state.facet(EditorView.editable);
    for (const [field, text] of [[binding.title, this.match.rawTitle]] as const) {
      field.contentEditable = editable ? 'plaintext-only' : 'false';
      if (!binding.composing && readEditorAdmonitionEditableText(field) !== text) {
        const focused = field === field.ownerDocument.activeElement;
        field.textContent = text;
        if (focused) {
          const range = field.ownerDocument.createRange();
          range.selectNodeContents(field);
          range.collapse(false);
          const selection = field.ownerDocument.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
    }
    const contentEditor = binding.contentEditor;
    if (contentEditor) {
      const docChanged = contentEditor.state.doc.toString() !== this.match.content;
      const editableChanged = contentEditor.state.facet(EditorView.editable) !== editable;
      if (docChanged || editableChanged) {
        binding.syncingContent = true;
        try {
          contentEditor.dispatch({
            changes: docChanged ? { from: 0, to: contentEditor.state.doc.length, insert: this.match.content } : undefined,
            effects: editableChanged ? binding.readonlyConfig.reconfigure([
              EditorState.readOnly.of(!editable), EditorView.editable.of(editable)
            ]) : [],
            selection: docChanged ? { anchor: Math.min(contentEditor.state.selection.main.head, this.match.content.length) } : undefined
          });
        } finally {
          binding.syncingContent = false;
        }
      }
    }
    return true;
  }

  public override destroy(dom: HTMLElement): void {
    editorAdmonitionBindings.get(dom)?.contentEditor?.destroy();
    editorAdmonitionBindings.delete(dom);
  }

  /** 创建带显式源码入口的标注块。 */
  public override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-editor-admonition-widget';
    const root = document.createElement('section');
    root.className = `cm-editor-admonition cm-editor-admonition--${this.match.type.toLowerCase()}`;
    root.dataset.admonitionFrom = String(this.match.from);
    const header = document.createElement('header');
    header.className = 'cm-editor-admonition__header';
    const icon = document.createElement('span');
    icon.className = 'cm-editor-admonition__icon';
    icon.innerHTML = this.match.type === 'IMPORTANT'
      ? importantAdmonitionIcon
      : this.match.type === 'TIP'
        ? tipAdmonitionIcon
      : this.match.type === 'WARNING'
        ? warningAdmonitionIcon
        : this.match.type === 'CAUTION'
          ? cautionAdmonitionIcon
          : admonitionIcon;
    const title = document.createElement('span');
    title.className = 'cm-editor-admonition__title';
    title.textContent = this.match.rawTitle;
    title.dataset.placeholder = this.match.type;
    title.contentEditable = this.canEdit ? 'plaintext-only' : 'false';
    title.setAttribute('role', 'textbox');
    title.setAttribute('aria-label', '标注标题');
    title.spellcheck = false;
    const sourceToggle = createIconButton({
      iconMarkup: editorCodeIcon,
      label: '源码模式',
      className: 'cm-editor-admonition__source-toggle',
      iconClassName: 'cm-editor-admonition__source-icon'
    });
    header.append(icon, title, sourceToggle);
    const content = document.createElement('div');
    content.className = 'cm-editor-admonition__content';
    const binding: EditorAdmonitionBinding = {
      match: this.match,
      title,
      contentEditor: null,
      readonlyConfig: new Compartment(),
      syncingContent: false,
      composing: false
    };
    editorAdmonitionBindings.set(wrapper, binding);
    const syncInput = () => updateEditorAdmonitionFromWidget(view, binding);
    // 复用编辑器的光标绘制，避免 WebKit 原生多行 contenteditable 光标高度随行变化。
    binding.contentEditor = new EditorView({
      parent: content,
      doc: this.match.content,
      extensions: [
        EditorView.lineWrapping,
        drawSelection(),
        binding.readonlyConfig.of([EditorState.readOnly.of(!this.canEdit), EditorView.editable.of(this.canEdit)]),
        EditorView.contentAttributes.of({ 'aria-label': '标注内容', 'aria-multiline': 'true', spellcheck: 'false' }),
        keymap.of([
          { key: 'Mod-z', run: () => undo(view) },
          { key: 'Mod-Shift-z', run: () => redo(view) },
          { key: 'Mod-y', run: () => redo(view) },
          ...standardKeymap
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !binding.syncingContent) syncInput();
        }),
        EditorView.theme({
          '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
            backgroundColor: 'var(--workbench-editor-selection) !important'
          }
        })
      ]
    });
    for (const field of [title]) {
      field.addEventListener('input', syncInput);
      field.addEventListener('compositionstart', () => { binding.composing = true; });
      field.addEventListener('compositionend', () => { binding.composing = false; syncInput(); });
      field.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          event.stopPropagation();
          (event.shiftKey ? redo : undo)(view);
        } else if (field === title && event.key === 'Enter') {
          event.preventDefault();
          binding.contentEditor?.focus();
        }
      });
      field.addEventListener('beforeinput', (event) => {
        if (view.state.readOnly || !view.state.facet(EditorView.editable)) {
          event.preventDefault();
          return;
        }
        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
          event.preventDefault();
          (event.inputType === 'historyRedo' ? redo : undo)(view);
        }
      });
    }
    root.append(header, content);
    wrapper.append(root);
    return wrapper;
  }

  public override ignoreEvent(event: Event): boolean {
    // Only the source button's click reaches the mode handler. Card interactions
    // must not let CodeMirror place a cursor inside the hidden Markdown.
    return !(event.type === 'click'
      && event.target instanceof Element
      && event.target.closest('.cm-editor-admonition__source-toggle'));
  }
}

/** 只有点击源码模式按钮时才恢复对应标注的 Markdown。 */
const editorAdmonitionEventHandlers = EditorView.domEventHandlers({
  click(event, view) {
    if (event.button !== 0 || !(event.target instanceof Element)) return false;
    const button = event.target.closest('.cm-editor-admonition__source-toggle');
    if (!button) return false;
    const root = button.closest<HTMLElement>('.cm-editor-admonition');
    const matchFrom = Number(root?.dataset.admonitionFrom);
    if (!root || !Number.isInteger(matchFrom)
      || !collectEditorAdmonitionMatches(view.state).some(match => match.from === matchFrom)) return false;

    event.preventDefault();
    event.stopPropagation();
    view.focus();
    // Unlock the block first so the source caret is no longer inside an atomic
    // range when CodeMirror validates the following selection transaction.
    view.dispatch({
      effects: setEditorAdmonitionEditingEffect.of(matchFrom),
      userEvent: 'select'
    });
    view.dispatch({
      selection: { anchor: getEditorAdmonitionSourceSelection(view.state, matchFrom) ?? matchFrom },
      scrollIntoView: true,
      userEvent: 'select'
    });
    return true;
  }
});

/** 创建覆盖完整标注源码的块级替换装饰。 */
function createAdmonitionDecoration(state: EditorState, match: EditorAdmonitionMatch): Range<Decoration> {
  const replacementTo = match.to < state.doc.length ? match.to + 1 : match.to;
  return Decoration.replace({
    widget: new EditorAdmonitionWidget(match, !state.readOnly && state.facet(EditorView.editable)),
    block: true,
    inclusiveStart: true,
    inclusiveEnd: false
  }).range(match.from, replacementTo);
}

/** 构建当前文档中的标注渲染状态。 */
function buildEditorAdmonitionState(state: EditorState, editingBlockFrom: number | null): EditorAdmonitionState {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  let activeEditingBlock: number | null = null;

  collectEditorAdmonitionMatches(state).forEach((match) => {
    if (match.from === editingBlockFrom) {
      activeEditingBlock = match.from;
      return;
    }
    const decoration = createAdmonitionDecoration(state, match);
    decorations.push(decoration);
    // Keep the following newline outside the atomic range so the next ordinary
    // line can show its caret while the visual replacement still owns spacing.
    atomicRanges.push(Decoration.mark({}).range(match.from, match.to));
  });

  return {
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    editingBlockFrom: activeEditingBlock
  };
}

/** 通过状态字段在选区和文档更新时切换标注源码/渲染态。 */
const editorAdmonitionStateField = StateField.define<EditorAdmonitionState>({
  create: (state) => buildEditorAdmonitionState(state, null),
  update(value, transaction) {
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    let editingBlockFrom = value.editingBlockFrom;
    let effectChanged = false;
    if (transaction.docChanged && editingBlockFrom !== null) {
      editingBlockFrom = transaction.changes.mapPos(editingBlockFrom, 1);
    }
    transaction.effects.forEach((effect) => {
      if (effect.is(setEditorAdmonitionEditingEffect)) {
        editingBlockFrom = effect.value;
        effectChanged = true;
      }
    });
    if (!effectChanged && selectionChanged && editingBlockFrom !== null) {
      const stillSelected = collectEditorAdmonitionMatches(transaction.state)
        .some((match) => match.from === editingBlockFrom && isAdmonitionSelected(transaction.state, match));
      if (!stillSelected) editingBlockFrom = null;
    }
    if (!transaction.docChanged && !selectionChanged && !effectChanged && !transaction.reconfigured) return value;
    return buildEditorAdmonitionState(transaction.state, editingBlockFrom);
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
  ]
});

/** Markdown 标注块完整扩展。 */
export const editorAdmonitionExtension = [
  editorAdmonitionStateField,
  editorAdmonitionEventHandlers,
  Prec.high(keymap.of([
    { key: 'Shift-Enter', run: continueAdmonitionContent },
    { key: 'Enter', run: enterAdmonitionContent },
    { key: 'Enter', run: handleAdmonitionContentEnter },
    { key: 'Enter', run: insertPlainLineAfterAdmonition }
  ]))
];
