/**
 * 文件说明：提供 `![[文件名称]]` 文件嵌入补全，并将独立嵌入行渲染为可滚动 Markdown 块。
 */
import {
  acceptCompletion,
  closeCompletion,
  moveCompletionSelection,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion,
  startCompletion
} from '@codemirror/autocomplete';
import { EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType, ViewPlugin } from '@codemirror/view';
import { createApp, h, shallowRef, type App as VueApp } from 'vue';
import type { SyntaxNode } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
import { editorMarkdownReadOnlyExtensions } from '@editor/Markdown/editorMarkdownRenderExtensions';

import type { WorkspaceMarkdownFile, WorkspaceMarkdownFileMetadata } from '@/types/ipc';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
const enlargeIcon = '<span class="icon icon-enlarge"></span>';
const editorCodeIcon = '<span class="icon icon-editor-code"></span>';
import { createIconButton } from '@/components/WsIconButton/iconButton';
import { createEditorBlockNavigationExtension } from '@editor/Block/editorBlockNavigationExtension';
import {
  createEditorBlockDecoration,
  resolveRenderedEditorBlockLineRanges
} from '@editor/Block/editorBlockState';
import { createEditorBlockTrailingLineExtension } from '@editor/Block/editorBlockTrailingLineExtension';
import type { EditorBlockSourceRange } from '@editor/Block/editorBlockTypes';
import { createEditorBlockClassName } from '@editor/Block/editorBlockSpacing';
import { EditorBlockWidget } from '@editor/Block/editorBlockWidget';
import {
  findEditorWikiLinkEmbedCompletionContext,
  retainEditorWikiLinkEmbedSourceKeys,
  resolveEditorWikiLinkEmbedFile,
  stripEditorWikiLinkEmbedExtension,
  setEditorWikiLinkEmbedSourceMode,
  clampEditorWikiLinkEmbedHeight
} from '@editor/WikiLinkEmbed/editorWikiLinkEmbed';

const EMBED_LINE_PATTERN = /^\s*!\[\[([^\]\r\n#|]+)\]\]\s*$/u;
const EXCLUDED_NODE_NAMES = new Set(['Comment', 'CommentBlock', 'FencedCode', 'HTMLBlock', 'HTMLTag', 'InlineCode']);
const embedCompletionSearchQueries = new WeakMap<EditorView, string>();

export interface EditorWikiLinkEmbedCompletionOptions {
  readonly getWorkspaceFiles: () => readonly WorkspaceMarkdownFileMetadata[];
  readonly readWorkspaceFile: (filePath: string) => Promise<WorkspaceMarkdownFile | undefined>;
  readonly onOpenFileInNewTab?: (filePath: string) => void;
}

interface EditorWikiLinkEmbedMatch extends EditorBlockSourceRange {
  readonly fileName: string;
  readonly key: string;
}

interface EditorWikiLinkEmbedState {
  readonly decorations: DecorationSet;
  readonly atomicRanges: DecorationSet;
  readonly matches: readonly EditorWikiLinkEmbedMatch[];
  readonly renderedLineFroms: readonly number[];
  readonly contents: ReadonlyMap<string, string | null>;
  readonly measuredHeights: ReadonlyMap<string, number>;
  readonly sourceKeys: ReadonlySet<string>;
}

const setEditorWikiLinkEmbedContentEffect = StateEffect.define<{ key: string; content: string | null }>();
const setEditorWikiLinkEmbedHeightEffect = StateEffect.define<{ key: string; height: number }>();
const toggleEditorWikiLinkEmbedSourceEffect = StateEffect.define<string>();
const embedResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
const embedScrollbarApps = new WeakMap<HTMLElement, VueApp<Element>>();
const embedNestedEditorViews = new WeakMap<HTMLElement, EditorView>();
const embedResizeCleanups = new WeakMap<HTMLElement, () => void>();

function isExcludedSyntaxPosition(state: EditorState, position: number): boolean {
  if (state.doc.length === 0) return false;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(Math.max(0, Math.min(state.doc.length - 1, position - 1)), -1);
  while (node) {
    if (EXCLUDED_NODE_NAMES.has(node.name)) return true;
    node = node.parent;
  }
  return false;
}

/** 收集独立行文件嵌入源码。 */
function collectEditorWikiLinkEmbedMatches(state: EditorState): EditorWikiLinkEmbedMatch[] {
  const matches: EditorWikiLinkEmbedMatch[] = [];
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const match = EMBED_LINE_PATTERN.exec(line.text);
    if (!match) continue;
    const fileName = match[1].trim();
    if (/\.(?:md|markdown)$/iu.test(fileName)) continue;
    matches.push({ from: line.from, to: line.to, fileName, key: `${line.from}:${fileName}` });
  }
  return matches;
}

/** 创建嵌入块统一的源码模式按钮。 */
function createEditorWikiLinkEmbedSourceButton(label: string): HTMLButtonElement {
  return createIconButton({
    iconMarkup: editorCodeIcon,
    label,
    className: ['cm-editor-wiki-link-embed__source-toggle'],
    iconClassName: 'cm-editor-wiki-link-embed__source-icon'
  });
}

class EditorWikiLinkEmbedWidget extends EditorBlockWidget {
  public constructor(
    private readonly match: EditorWikiLinkEmbedMatch,
    private readonly content: string | null,
    private readonly measuredBlockHeight: number | null,
    private readonly options: EditorWikiLinkEmbedCompletionOptions
  ) {
    super(false, false, measuredBlockHeight);
  }

  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorWikiLinkEmbedWidget
      && widget.match.key === this.match.key
      && widget.content === this.content
      && this.hasEqualEditorBlockState(widget);
  }

  /** 高度变化只更新块布局，保留只读编辑器与滚动条的 DOM 生命周期。 */
  public override updateDOM(dom: HTMLElement, _view: EditorView, previousWidget: this): boolean {
    if (previousWidget.match.key !== this.match.key || previousWidget.content !== this.content) return false;
    dom.style.height = this.measuredBlockHeight === null ? '' : `${this.measuredBlockHeight}px`;
    dom.querySelector('.cm-editor-wiki-link-embed__resize-handle')
      ?.setAttribute('aria-valuenow', String(this.measuredBlockHeight ?? dom.getBoundingClientRect().height));
    return true;
  }

  public override toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('section');
    const header = document.createElement('header');
    const title = document.createElement('span');
    const actions = document.createElement('div');
    const action = createIconButton({
      iconMarkup: enlargeIcon,
      label: '在新标签页中打开',
      className: 'cm-editor-wiki-link-embed__open-tab',
      iconClassName: 'cm-editor-wiki-link-embed__open-tab-icon'
    });
    const sourceToggle = createEditorWikiLinkEmbedSourceButton('编辑嵌入语法');
    const scroller = document.createElement('div');
    const content = document.createElement('article');
    const scrollbarHost = document.createElement('div');

    root.className = createEditorBlockClassName(['cm-editor-wiki-link-embed'], true, true);
    root.contentEditable = 'false';
    root.setAttribute('aria-label', `嵌入文件 ${this.match.fileName}`);
    header.className = 'cm-editor-wiki-link-embed__header';
    title.className = 'cm-editor-wiki-link-embed__title';
    title.textContent = this.match.fileName;
    action.title = '在新标签页中打开';
    action.disabled = !this.options.onOpenFileInNewTab
      || !resolveEditorWikiLinkEmbedFile(this.match.fileName, this.options.getWorkspaceFiles());
    action.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const file = resolveEditorWikiLinkEmbedFile(this.match.fileName, this.options.getWorkspaceFiles());
      if (file) this.options.onOpenFileInNewTab?.(file.path);
    });
    sourceToggle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    sourceToggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.match.to },
        effects: toggleEditorWikiLinkEmbedSourceEffect.of(this.match.key),
        scrollIntoView: true,
        userEvent: 'select'
      });
      view.focus();
    });
    actions.className = 'cm-editor-wiki-link-embed__actions';
    actions.append(sourceToggle, action);
    header.append(title, actions);
    scroller.className = 'cm-editor-wiki-link-embed__scroller';
    content.className = 'cm-editor-wiki-link-embed__content';
    if (this.content === null) {
      content.textContent = '正在加载文件内容…';
    } else {
      const nestedEditor = new EditorView({
        parent: content,
        state: EditorState.create({
          doc: this.content,
          selection: { anchor: this.content.length },
          extensions: [
            editorMarkdownReadOnlyExtensions
          ]
        })
      });
      embedNestedEditorViews.set(content, nestedEditor);
    }
    if (this.measuredBlockHeight !== null) {
      root.style.height = `${this.measuredBlockHeight}px`;
    }
    scrollbarHost.className = 'cm-editor-wiki-link-embed__scrollbar';
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'cm-editor-wiki-link-embed__resize-handle';
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', '调整嵌入文件块高度');
    resizeHandle.setAttribute('aria-orientation', 'horizontal');
    resizeHandle.tabIndex = 0;
    scroller.append(content);
    root.append(header, scroller, resizeHandle, scrollbarHost);

    let activePointerId: number | null = null;
    let startPointerY = 0;
    let startHeight = 0;
    let nextHeight = 0;
    let lastReportedHeight = this.estimatedHeight;
    const readHeightBounds = (): { min: number; max: number } => {
      const styles = getComputedStyle(root);
      return {
        min: Number.parseFloat(styles.minHeight),
        max: Number.parseFloat(styles.maxHeight)
      };
    };
    const dispatchHeight = (height: number): void => {
      if (height === lastReportedHeight) return;
      lastReportedHeight = height;
      view.dispatch({
        effects: setEditorWikiLinkEmbedHeightEffect.of({ key: this.match.key, height })
      });
    };
    const finishResize = (event?: PointerEvent): void => {
      if (activePointerId === null || (event && event.pointerId !== activePointerId)) return;
      activePointerId = null;
      root.classList.remove('cm-editor-wiki-link-embed--resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      if (event) resizeHandle.releasePointerCapture?.(event.pointerId);
      if (nextHeight > 0) dispatchHeight(nextHeight);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== activePointerId) return;
      event.preventDefault();
      const bounds = readHeightBounds();
      nextHeight = clampEditorWikiLinkEmbedHeight(
        startHeight + event.clientY - startPointerY,
        bounds.min,
        bounds.max
      );
      root.style.height = `${nextHeight}px`;
      resizeHandle.setAttribute('aria-valuemin', String(bounds.min));
      resizeHandle.setAttribute('aria-valuemax', String(bounds.max));
      resizeHandle.setAttribute('aria-valuenow', String(nextHeight));
    };
    const onPointerUp = (event: PointerEvent): void => finishResize(event);
    const onPointerCancel = (event: PointerEvent): void => finishResize(event);
    const removeResizeListeners = (): void => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = readHeightBounds();
      activePointerId = event.pointerId;
      startPointerY = event.clientY;
      startHeight = clampEditorWikiLinkEmbedHeight(root.getBoundingClientRect().height, bounds.min, bounds.max);
      nextHeight = startHeight;
      root.style.height = `${startHeight}px`;
      root.classList.add('cm-editor-wiki-link-embed--resizing');
      resizeHandle.setAttribute('aria-valuemin', String(bounds.min));
      resizeHandle.setAttribute('aria-valuemax', String(bounds.max));
      resizeHandle.setAttribute('aria-valuenow', String(startHeight));
      resizeHandle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerCancel);
    });
    resizeHandle.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = readHeightBounds();
      const currentHeight = root.getBoundingClientRect().height;
      const next = event.key === 'Home'
        ? bounds.min
        : event.key === 'End'
          ? bounds.max
          : clampEditorWikiLinkEmbedHeight(currentHeight + (event.key === 'ArrowUp' ? 16 : -16), bounds.min, bounds.max);
      root.style.height = `${next}px`;
      resizeHandle.setAttribute('aria-valuemin', String(bounds.min));
      resizeHandle.setAttribute('aria-valuemax', String(bounds.max));
      resizeHandle.setAttribute('aria-valuenow', String(next));
      dispatchHeight(next);
    });
    embedResizeCleanups.set(root, () => {
      removeResizeListeners();
      activePointerId = null;
      root.classList.remove('cm-editor-wiki-link-embed--resizing');
    });

    const scrollbar = shallowRef<HTMLElement | null>(scroller);
    const scrollbarApp = createApp({ setup: () => () => h(WorkbenchVerticalScrollbar, { scrollerElement: scrollbar.value }) });
    scrollbarApp.mount(scrollbarHost);
    embedScrollbarApps.set(root, scrollbarApp);

    const observer = new ResizeObserver(() => {
      if (!root.isConnected || activePointerId !== null) return;
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height > 0) dispatchHeight(height);
    });
    observer.observe(root);
    embedResizeObservers.set(root, observer);

    root.addEventListener('mousedown', (event) => {
      if (
        event.button !== 0
        || !(event.target instanceof Element)
        || event.target.closest('a, button, input, select, textarea, [role="button"], .cm-editor-wiki-link-embed__content, .cm-editor-wiki-link-embed__scrollbar, .cm-editor-wiki-link-embed__resize-handle')
      ) return;
      event.preventDefault();
      event.stopPropagation();
      const line = view.state.doc.lineAt(view.posAtDOM(root));
      view.dispatch({ selection: { anchor: line.to }, userEvent: 'select' });
      view.focus();
    });
    return root;
  }

  public override destroy(dom: HTMLElement): void {
    embedResizeCleanups.get(dom)?.();
    embedResizeCleanups.delete(dom);
    const content = dom.querySelector<HTMLElement>('.cm-editor-wiki-link-embed__content');
    if (content) {
      embedNestedEditorViews.get(content)?.destroy();
      embedNestedEditorViews.delete(content);
    }
    embedResizeObservers.get(dom)?.disconnect();
    embedResizeObservers.delete(dom);
    embedScrollbarApps.get(dom)?.unmount();
    embedScrollbarApps.delete(dom);
  }

  public override ignoreEvent(): boolean {
    return true;
  }
}

function buildEditorWikiLinkEmbedState(
  state: EditorState,
  contents: ReadonlyMap<string, string | null>,
  measuredHeights: ReadonlyMap<string, number>,
  sourceKeys: ReadonlySet<string>,
  options: EditorWikiLinkEmbedCompletionOptions
): EditorWikiLinkEmbedState {
  const matches = collectEditorWikiLinkEmbedMatches(state);
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const renderedLineFroms: number[] = [];

  for (const match of matches) {
    if (sourceKeys.has(match.key)) continue;
    const widget = new EditorWikiLinkEmbedWidget(
      match,
      contents.has(match.key) ? contents.get(match.key) ?? null : null,
      measuredHeights.get(match.key) ?? null,
      options
    );
    const decoration = createEditorBlockDecoration(state, match, widget);
    decorations.push(decoration);
    atomicRanges.push(decoration);
    renderedLineFroms.push(match.from);
  }

  return {
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    matches,
    renderedLineFroms,
    contents,
    measuredHeights,
    sourceKeys
  };
}

/** 将源码模式保留在编辑后仍对应同一行的嵌入语法上。 */
function mapEditorWikiLinkEmbedSourceKeys(
  state: EditorState,
  previous: EditorWikiLinkEmbedState,
  changes: { mapPos: (position: number, assoc?: number) => number }
): Set<string> {
  const matchesByPosition = new Map(
    collectEditorWikiLinkEmbedMatches(state).map((match) => [match.from, match.key])
  );
  const mappedKeys = new Set<string>();
  for (const match of previous.matches) {
    if (!previous.sourceKeys.has(match.key)) continue;
    const mappedKey = matchesByPosition.get(changes.mapPos(match.from, 1));
    if (mappedKey) mappedKeys.add(mappedKey);
  }
  return mappedKeys;
}

function createEmbedCompletion(file: WorkspaceMarkdownFileMetadata, order: number): Completion {
  const fileName = stripEditorWikiLinkEmbedExtension(file.name);
  return {
    label: fileName,
    detail: file.relativePath,
    sortText: String(order).padStart(6, '0'),
    type: 'file',
    apply(view, completion, from, to) {
      const closingMark = view.state.sliceDoc(to, to + 2) === ']]' ? '' : ']]';
      const inserted = `${fileName}${closingMark}`;
      view.dispatch({
        changes: { from, to, insert: inserted },
        selection: { anchor: from + inserted.length },
        annotations: pickedCompletion.of(completion),
        scrollIntoView: true,
        userEvent: 'input.complete'
      });
      closeCompletion(view);
      view.focus();
    }
  };
}

export function editorWikiLinkEmbedCompletionSource(
  context: CompletionContext,
  options: EditorWikiLinkEmbedCompletionOptions
): CompletionResult | null {
  if (isExcludedSyntaxPosition(context.state, context.pos)) return null;
  const completionContext = findEditorWikiLinkEmbedCompletionContext(context.state, context.pos);
  if (!completionContext) return null;
  const searchQuery = context.view
    ? embedCompletionSearchQueries.get(context.view) ?? ''
    : '';
  const query = (searchQuery.trim() || completionContext.query).toLocaleLowerCase();
  const files = options.getWorkspaceFiles().filter((file) => (
    query.length === 0
      || file.name.toLocaleLowerCase().includes(query)
      || file.relativePath.toLocaleLowerCase().includes(query)
  ));
  return {
    from: completionContext.from,
    to: completionContext.to,
    options: files.length > 0
      ? files.map(createEmbedCompletion)
      : [{ label: '暂无匹配文件', type: 'text', apply: (view) => view.focus() }],
    filter: false
  };
}

class EmbedCompletionPanelPlugin {
  private readonly view: EditorView;
  private readonly mutationObserver: MutationObserver;
  private tooltip: HTMLElement | null = null;
  private attachedList: HTMLElement | null = null;
  private listWheelHandler: ((event: WheelEvent) => void) | null = null;
  private scrollbarHost: HTMLElement | null = null;
  private scrollbarApp: ReturnType<typeof createApp> | undefined;
  private readonly scrollbarScroller = shallowRef<HTMLElement | null>(null);

  public constructor(view: EditorView) {
    this.view = view;
    this.mutationObserver = new MutationObserver(() => this.sync());
    this.mutationObserver.observe(view.dom, { childList: true, subtree: true });
    this.sync();
  }

  public update(): void { this.sync(); }

  public destroy(): void {
    this.mutationObserver.disconnect();
    this.detach();
    embedCompletionSearchQueries.delete(this.view);
  }

  private sync(): void {
    const list = this.view.dom.querySelector<HTMLElement>('.cm-tooltip-autocomplete.cm-editor-wiki-link-embed-completion > ul[role="listbox"]');
    const tooltip = list?.closest<HTMLElement>(
      '.cm-tooltip-autocomplete.cm-editor-wiki-link-embed-completion'
    );
    if (!list || !tooltip) {
      this.detach();
      return;
    }

    if (tooltip !== this.tooltip) {
      this.detach();
      this.tooltip = tooltip;
      const search = document.createElement('label');
      const icon = document.createElement('span');
      const input = document.createElement('input');
      const footer = document.createElement('footer');
      search.className = 'cm-editor-wiki-link-embed-completion__search';
      icon.className = 'cm-editor-wiki-link-embed-completion__search-icon';
      icon.setAttribute('aria-hidden', 'true');
      input.className = 'cm-editor-wiki-link-embed-completion__search-input';
      input.type = 'search';
      input.placeholder = '搜索文件';
      input.setAttribute('aria-label', '搜索文件');
      input.value = embedCompletionSearchQueries.get(this.view) ?? '';
      input.addEventListener('input', () => {
        embedCompletionSearchQueries.set(this.view, input.value);
        startCompletion(this.view);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveCompletionSelection(true)(this.view);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveCompletionSelection(false)(this.view);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          acceptCompletion(this.view);
          this.view.focus();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          closeCompletion(this.view);
          this.view.focus();
        } else {
          event.stopPropagation();
        }
      });
      input.addEventListener('mousedown', (event) => event.stopPropagation());
      search.append(icon, input);
      footer.className = 'cm-editor-wiki-link-embed-completion__description';
      footer.innerHTML = '<strong>输入</strong> # 可以链接到标题&nbsp;&nbsp;<strong>输入</strong> ^ 链接文本块';
      tooltip.prepend(search);
      tooltip.append(footer);

      this.scrollbarHost = document.createElement('div');
      this.scrollbarHost.className = 'cm-editor-wiki-link-embed-completion__scrollbar';
      this.scrollbarHost.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      this.scrollbarHost.addEventListener('wheel', (event: WheelEvent) => {
        if (!this.attachedList || event.deltaY === 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.attachedList.scrollTop += event.deltaY;
      }, { passive: false });
      tooltip.append(this.scrollbarHost);
      const scroller = this.scrollbarScroller;
      this.scrollbarApp = createApp({
        setup() {
          return () => h(WorkbenchVerticalScrollbar, {
            scrollerElement: scroller.value,
            alwaysVisible: true
          });
        }
      });
      this.scrollbarApp.mount(this.scrollbarHost);
    }

    if (list === this.attachedList) return;
    this.detachList();
    this.attachedList = list;
    this.scrollbarScroller.value = list;
    this.listWheelHandler = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * (list.firstElementChild?.getBoundingClientRect().height ?? 16)
        : event.deltaY;
      const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
      list.scrollTop = Math.max(0, Math.min(maxScrollTop, list.scrollTop + delta));
    };
    list.addEventListener('wheel', this.listWheelHandler, { passive: false });
  }

  private detachList(): void {
    if (this.attachedList && this.listWheelHandler) {
      this.attachedList.removeEventListener('wheel', this.listWheelHandler);
    }
    this.listWheelHandler = null;
    this.attachedList = null;
    this.scrollbarScroller.value = null;
  }

  private detach(): void {
    this.detachList();
    this.scrollbarApp?.unmount();
    this.scrollbarApp = undefined;
    this.scrollbarHost?.remove();
    this.scrollbarHost = null;
    this.tooltip = null;
  }
}

class EmbedContentLoaderPlugin {
  private readonly view: EditorView;
  private readonly options: EditorWikiLinkEmbedCompletionOptions;
  private readonly pending = new Set<string>();
  private readonly loaded = new Set<string>();

  public constructor(view: EditorView, options: EditorWikiLinkEmbedCompletionOptions) {
    this.view = view;
    this.options = options;
    this.loadMissing(view.state);
  }

  public update(update: { state: EditorState; docChanged: boolean }): void {
    if (update.docChanged) this.loadMissing(update.state);
  }

  public destroy(): void { this.pending.clear(); }

  private loadMissing(state: EditorState): void {
    const files = this.options.getWorkspaceFiles();
    for (const match of collectEditorWikiLinkEmbedMatches(state)) {
      const file = resolveEditorWikiLinkEmbedFile(match.fileName, files);
      if (this.pending.has(match.key) || this.loaded.has(match.key)) continue;
      if (!file) {
        this.loaded.add(match.key);
        queueMicrotask(() => {
          if (!this.view.dom.isConnected) return;
          this.view.dispatch({
            effects: setEditorWikiLinkEmbedContentEffect.of({
              key: match.key,
              content: '文件内容读取失败'
            })
          });
        });
        continue;
      }
      this.pending.add(match.key);
      void this.options.readWorkspaceFile(file.path).then((result) => {
        this.pending.delete(match.key);
        this.loaded.add(match.key);
        if (!this.view.dom.isConnected) return;
        this.view.dispatch({
          effects: setEditorWikiLinkEmbedContentEffect.of({
            key: match.key,
            content: result?.content ?? '文件内容读取失败'
          })
        });
      }).catch(() => {
        this.pending.delete(match.key);
        this.loaded.add(match.key);
        if (!this.view.dom.isConnected) return;
        this.view.dispatch({
          effects: setEditorWikiLinkEmbedContentEffect.of({ key: match.key, content: '文件内容读取失败' })
        });
      });
    }
  }
}

function createEmbedNavigationExtension(field: StateField<EditorWikiLinkEmbedState>) {
  return createEditorBlockNavigationExtension(
    (state) => resolveRenderedEditorBlockLineRanges(state, state.field(field).renderedLineFroms),
    (view, sourceRange) => view.dispatch({ selection: { anchor: sourceRange.to }, userEvent: 'select' })
  );
}

export function createEditorWikiLinkEmbedCompletionExtension(options: EditorWikiLinkEmbedCompletionOptions) {
  const completionSource = (context: CompletionContext) => editorWikiLinkEmbedCompletionSource(context, options);
  const embedStateField = StateField.define<EditorWikiLinkEmbedState>({
    create: (state) => buildEditorWikiLinkEmbedState(state, new Map(), new Map(), new Set(), options),
    update(value, transaction) {
      const contents = new Map(value.contents);
      const measuredHeights = new Map(value.measuredHeights);
      const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
      let sourceKeys = transaction.docChanged
        ? mapEditorWikiLinkEmbedSourceKeys(transaction.state, value, transaction.changes)
        : new Set(value.sourceKeys);
      let changed = transaction.docChanged;
      if (selectionChanged && sourceKeys.size > 0) {
        const activeSourceKeys = new Set(
          collectEditorWikiLinkEmbedMatches(transaction.state)
            .filter((match) => transaction.state.selection.ranges.some((range) => (
              range.head >= match.from && range.head <= match.to
            )))
            .map((match) => match.key)
        );
        const retainedSourceKeys = retainEditorWikiLinkEmbedSourceKeys(sourceKeys, activeSourceKeys);
        if (retainedSourceKeys.size !== sourceKeys.size) changed = true;
        sourceKeys = retainedSourceKeys;
      }
      for (const effect of transaction.effects) {
        if (effect.is(setEditorWikiLinkEmbedContentEffect)) {
          if (!contents.has(effect.value.key) || contents.get(effect.value.key) !== effect.value.content) {
            contents.set(effect.value.key, effect.value.content);
            changed = true;
          }
        } else if (effect.is(setEditorWikiLinkEmbedHeightEffect)) {
          if (measuredHeights.get(effect.value.key) !== effect.value.height) {
            measuredHeights.set(effect.value.key, effect.value.height);
            changed = true;
          }
        } else if (effect.is(toggleEditorWikiLinkEmbedSourceEffect)) {
          sourceKeys = setEditorWikiLinkEmbedSourceMode(
            sourceKeys,
            effect.value,
            !sourceKeys.has(effect.value)
          );
          changed = true;
        }
      }
      return changed
        ? buildEditorWikiLinkEmbedState(transaction.state, contents, measuredHeights, sourceKeys, options)
        : value;
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
    ]
  });

  return [
    EditorState.languageData.of(() => [{ autocomplete: completionSource }]),
    embedStateField,
    createEmbedNavigationExtension(embedStateField),
    createEditorBlockTrailingLineExtension((state) => state.field(embedStateField)),
    ViewPlugin.define((view) => new EmbedContentLoaderPlugin(view, options)),
    ViewPlugin.fromClass(EmbedCompletionPanelPlugin),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (update.transactions.some((transaction) => transaction.annotation(pickedCompletion) !== undefined)) {
        closeCompletion(update.view);
        return;
      }
      if (findEditorWikiLinkEmbedCompletionContext(update.state)) {
        embedCompletionSearchQueries.delete(update.view);
        startCompletion(update.view);
      }
    })
  ];
}

export function isEditorWikiLinkEmbedCompletionState(state: EditorState): boolean {
  return findEditorWikiLinkEmbedCompletionContext(state) !== null;
}
