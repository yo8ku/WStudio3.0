/** Renders each inline-chat marker as independent input and response editor blocks. */
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, type WidgetType } from '@codemirror/view';
import { Prec, StateEffect, StateField, type Range } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import { createApp, reactive, watchEffect } from 'vue';
import { createEditorBlockClassName } from '@editor/Block/editorBlockSpacing';
import { EditorBlockWidget } from '@editor/Block/editorBlockWidget';
import { applyEditorBlockVisualState } from '@editor/Block/editorBlockUtils';
import { vuetify } from '@/plugins/vuetify';
import type { WorkspaceFileEntry } from '@/types/ipc';
import type { RecentWorkspaceFile } from '@/store/dockingThree';

import {
  INLINE_CHAT_MARKER,
  INLINE_CHAT_RESPONSE_TYPE,
  INLINE_CHAT_SELECTOR,
  INLINE_CHAT_WIDGET_SELECTOR,
  markInlineChatElement
} from './inlineChatLifecycle';
import type { InlineChatResponseState } from './inlineChatResponseState';
import { createInlineChatResponseState } from './inlineChatResponseState';

interface InlineChatMount {
  readonly apps: Array<ReturnType<typeof createApp>>;
  disposed: boolean;
}

interface InlineChatInstance {
  readonly responseState: InlineChatResponseState;
  selectionContext: string;
  regenerate?: () => void;
  cancel?: () => void;
  accept?: () => void;
  reject?: () => void;
}

const inlineChatMounts = new WeakMap<HTMLElement, InlineChatMount>();

const loadInlineChatPanel = () => import('./InlineChatPanel.vue');
const loadInlineChatResponse = () => import('./InlineChatResponse.vue');

/** Explicitly unmounts inline-chat applications before their owning editor is destroyed. */
export function disposeInlineChatWidgets(container: HTMLElement): void {
  const roots = [
    ...(container.matches(INLINE_CHAT_WIDGET_SELECTOR) ? [container] : []),
    ...Array.from(container.querySelectorAll<HTMLElement>(INLINE_CHAT_WIDGET_SELECTOR))
  ];

  roots.forEach((root) => {
    const mount = inlineChatMounts.get(root);
    if (mount) {
      mount.disposed = true;
      mount.apps.forEach((app) => app.unmount());
      inlineChatMounts.delete(root);
    }
    root.remove();
  });
}

/** Invokes each inline-chat close button while its CodeMirror view is still alive. */
export function closeInlineChatWidgets(view: EditorView): void {
  let root = view.dom.querySelector<HTMLElement>(INLINE_CHAT_SELECTOR);

  while (root) {
    const closeButton = root.querySelector<HTMLButtonElement>('.cm-editor-inline-chat__close');
    if (!closeButton) return;

    closeButton.click();
    const nextRoot = view.dom.querySelector<HTMLElement>(INLINE_CHAT_SELECTOR);
    if (nextRoot === root) return;
    root = nextRoot;
  }
}

/** Prevents child editor events from being interpreted as CodeMirror document edits. */
function ignoreInlineChatWidgetEvent(event: Event): boolean {
  return event.type === 'mousedown'
    || event.type === 'click'
    || event.type === 'dblclick'
    || event.type === 'keydown'
    || event.type === 'keyup'
    || event.type === 'beforeinput'
    || event.type === 'input'
    || event.type === 'paste'
    || event.type === 'cut'
    || event.type === 'drop'
    || event.type.startsWith('composition')
    || event.type.startsWith('pointer');
}

function closeInlineChatWidget(view: EditorView, root: HTMLElement): void {
  if (!root.isConnected) return;

  const from = view.posAtDOM(root, 0);
  view.dispatch({
    changes: { from, to: from + INLINE_CHAT_MARKER.length },
    userEvent: 'delete.inline-chat'
  });
  view.focus();
}

/** Hides the current response while keeping the inline-chat input available. */
function dismissInlineChatResponse(responseState: InlineChatResponseState): void {
  responseState.markdown = '';
  responseState.error = '';
  responseState.isStreaming = false;
}

/** Replaces the transient marker with the accepted Markdown response. */
function acceptInlineChatWidget(
  view: EditorView,
  root: HTMLElement,
  responseState: InlineChatResponseState
): void {
  const markdown = responseState.markdown;
  if (!root.isConnected || !markdown) return;

  const from = view.posAtDOM(root, 0);
  const to = from + INLINE_CHAT_MARKER.length;
  view.dispatch({
    changes: { from, to, insert: markdown },
    effects: acceptedInlineChatRangeEffect.of({
      from,
      to: from + markdown.length
    }),
    userEvent: 'input.inline-chat-accept'
  });
  view.focus();
}

interface InlineChatDecorationState {
  readonly decorations: DecorationSet;
  readonly atomicRanges: DecorationSet;
}

interface AcceptedInlineChatRange {
  readonly from: number;
  readonly to: number;
}

const acceptedInlineChatRangeEffect = StateEffect.define<AcceptedInlineChatRange>();
const clearAcceptedInlineChatDecorationEffect = StateEffect.define<null>();

const acceptedInlineChatDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let nextDecorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(clearAcceptedInlineChatDecorationEffect)) {
        nextDecorations = Decoration.none;
        continue;
      }
      if (!effect.is(acceptedInlineChatRangeEffect)) continue;

      const ranges: Range<Decoration>[] = [];
      const contentEnd = Math.max(effect.value.from, effect.value.to - 1);
      let position = effect.value.from;
      while (position <= contentEnd) {
        const line = transaction.state.doc.lineAt(position);
        ranges.push(Decoration.line({
          attributes: { class: 'cm-editor-inline-chat__accepted-line' }
        }).range(line.from));
        if (line.to >= contentEnd) break;
        position = line.to + 1;
      }
      nextDecorations = nextDecorations.update({ add: ranges });
    }
    return nextDecorations;
  },
  provide: field => EditorView.decorations.from(field)
});

export interface InlineChatExtensionOptions {
  readonly getWorkspaceFiles: () => readonly WorkspaceFileEntry[];
  readonly getRecentFiles: () => readonly RecentWorkspaceFile[];
}

class InlineChatPanelWidget extends EditorBlockWidget {
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    private readonly options: InlineChatExtensionOptions,
    private readonly instance: InlineChatInstance
  ) {
    super(false, false, null);
  }

  override toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div');
    const mount: InlineChatMount = {
      apps: [],
      disposed: false
    };
    inlineChatMounts.set(root, mount);
    root.className = createEditorBlockClassName(['cm-editor-inline-chat'], true, false);
    root.contentEditable = 'false';
    // Keep the async Vue mount from exposing an empty widget that only contains the borders.
    root.hidden = true;
    markInlineChatElement(root);
    applyEditorBlockVisualState(root, this.selected, this.editing);

    const topBorder = document.createElement('div');
    topBorder.className = 'ai-zone-border-top';
    const bottomBorder = document.createElement('div');
    bottomBorder.className = 'ai-zone-border-bottom';
    const content = document.createElement('div');
    content.className = 'cm-editor-inline-chat__mount';

    const { getRecentFiles, getWorkspaceFiles } = this.options;
    void loadInlineChatPanel().then(({ default: InlineChatPanel }) => {
      if (mount.disposed || !root.isConnected) return;

      const chatApp = createApp(InlineChatPanel, {
        onClose: () => closeInlineChatWidget(view, root),
        responseState: this.instance.responseState,
        getSelectionContext: () => this.instance.selectionContext,
        registerRegenerate: (handler: (() => void) | undefined) => {
          this.instance.regenerate = handler;
        },
        registerCancel: (handler: (() => void) | undefined) => {
          this.instance.cancel = handler;
        },
        workspaceFiles: getWorkspaceFiles(),
        recentFiles: getRecentFiles()
      });
      chatApp.use(vuetify);
      chatApp.mount(content);
      mount.apps.push(chatApp);
      this.instance.accept = () => acceptInlineChatWidget(view, root, this.instance.responseState);
      this.instance.reject = () => dismissInlineChatResponse(this.instance.responseState);
      root.hidden = false;
      view.requestMeasure();
    }).catch((error: unknown) => {
      if (!mount.disposed) console.error('Failed to load inline chat editor.', error);
    });

    root.append(topBorder, content, bottomBorder);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (root.isConnected) view.requestMeasure();
    });
    this.resizeObserver.observe(root);
    return root;
  }

  override eq(widget: WidgetType): boolean {
    return widget instanceof InlineChatPanelWidget
      && widget.options === this.options
      && widget.instance === this.instance;
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreInlineChatWidgetEvent(event);
  }

  override destroy(dom: HTMLElement): void {
    this.instance.cancel?.();
    this.instance.accept = undefined;
    this.instance.reject = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    disposeInlineChatWidgets(dom);
  }
}

class InlineChatResponseWidget extends EditorBlockWidget {
  private resizeObserver: ResizeObserver | null = null;
  private stopStateEffect: (() => void) | null = null;

  constructor(private readonly instance: InlineChatInstance) {
    super(false, false, null);
  }

  override toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('section');
    const mount: InlineChatMount = {
      apps: [],
      disposed: false
    };
    inlineChatMounts.set(root, mount);
    root.className = createEditorBlockClassName(['cm-editor-inline-chat-response'], false, true);
    root.contentEditable = 'false';
    markInlineChatElement(root, INLINE_CHAT_RESPONSE_TYPE);
    applyEditorBlockVisualState(root, this.selected, this.editing);
    root.hidden = true;
    const content = document.createElement('div');
    content.className = 'cm-editor-inline-chat-response__mount';

    this.stopStateEffect = watchEffect(() => {
      const state = this.instance.responseState;
      const visible = state.isStreaming || Boolean(state.markdown) || Boolean(state.error);
      if (root.hidden === !visible) return;
      root.hidden = !visible;
      if (root.isConnected) view.requestMeasure();
    });

    void loadInlineChatResponse().then(({ default: InlineChatResponse }) => {
      if (mount.disposed || !root.isConnected) return;

      const responseApp = createApp(InlineChatResponse, {
        responseState: this.instance.responseState,
        onRegenerate: () => {
          this.instance.regenerate?.();
        },
        onAccept: () => {
          this.instance.accept?.();
        },
        onReject: () => {
          this.instance.reject?.();
        }
      });
      responseApp.use(vuetify);
      responseApp.mount(content);
      mount.apps.push(responseApp);
    }).catch((error: unknown) => {
      if (!mount.disposed) console.error('Failed to load inline chat response.', error);
    });

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (root.isConnected) view.requestMeasure();
    });
    this.resizeObserver.observe(root);
    root.append(content);
    return root;
  }

  override eq(widget: WidgetType): boolean {
    return widget instanceof InlineChatResponseWidget
      && widget.instance === this.instance;
  }

  override ignoreEvent(event: Event): boolean {
    return ignoreInlineChatWidgetEvent(event);
  }

  override destroy(dom: HTMLElement): void {
    this.instance.cancel?.();
    this.stopStateEffect?.();
    this.stopStateEffect = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    disposeInlineChatWidgets(dom);
  }
}

/** Removes duplicate inline-chat markers so each editor can host only one live chat. */
const inlineChatSingleInstanceExtension = EditorView.updateListener.of((update) => {
  if (!update.docChanged || !update.view.dom.isConnected) return;

  const markerPositions = findInlineChatMarkerPositions(update.state.doc.toString());
  if (markerPositions.length <= 1) return;

  update.view.dispatch({
    changes: markerPositions.slice(1).map(from => ({
      from,
      to: from + INLINE_CHAT_MARKER.length
    })),
    userEvent: 'delete.inline-chat-duplicate'
  });
});

function findInlineChatMarkerPositions(content: string): number[] {
  const positions: number[] = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const markerFrom = content.indexOf(INLINE_CHAT_MARKER, searchFrom);
    if (markerFrom < 0) break;
    positions.push(markerFrom);
    searchFrom = markerFrom + INLINE_CHAT_MARKER.length;
  }
  return positions;
}

/**
 * Keeps CodeMirror's native selection highlight visible while the Tiptap input has focus.
 *
 * The class is supplied through CodeMirror's attribute facet instead of being mutated by a
 * DOM plugin. That makes it part of the editor state and keeps it stable while widgets are
 * rebuilt during focus changes, pointer drags, and asynchronous Vue mounts.
 */
const inlineChatContextSelectionAttributes = EditorView.editorAttributes.compute(
  ['doc'],
  (state) => ({
    class: state.doc.toString().includes(INLINE_CHAT_MARKER)
      ? 'cm-editor-inline-chat-context-active'
      : ''
  })
);

/** Redirects clicks in the editor margin to a stable position around either chat block. */
const inlineChatMouseSelectionExtension = Prec.highest(
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false;

      const target = event.target;
      if (
        target instanceof Element
        && target.closest('.cm-editor-inline-chat, .cm-editor-inline-chat-response, .ws-dropdown-menu, button, input, textarea')
      ) {
        return false;
      }

      const acceptedDecorations = view.state.field(acceptedInlineChatDecorationField);
      const isEditorSurface = target instanceof Element
        && target.closest('.cm-content, .cm-gutters, .cm-gutter');
      const lineElement = target instanceof Element ? target.closest('.cm-line') : null;
      const effects = [];

      if (
        acceptedDecorations.size > 0
        && isEditorSurface
      ) {
        const clickedPosition = view.posAtCoords({
          x: event.clientX,
          y: event.clientY
        }, false);
        const clickedLine = view.state.doc.lineAt(clickedPosition);
        let clickedAcceptedLine = lineElement?.classList.contains('cm-editor-inline-chat__accepted-line') ?? false;
        if (!clickedAcceptedLine) {
          acceptedDecorations.between(clickedLine.from, clickedLine.from, () => {
            clickedAcceptedLine = true;
            return false;
          });
        }

        if (!clickedAcceptedLine) {
          effects.push(clearAcceptedInlineChatDecorationEffect.of(null));
        }
      }

      if (effects.length > 0) {
        view.dispatch({
          effects,
          userEvent: 'clear.inline-chat-context-selection'
        });
      }

      const root = Array.from(view.dom.querySelectorAll<HTMLElement>(INLINE_CHAT_WIDGET_SELECTOR))
        .find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return event.clientY >= bounds.top && event.clientY <= bounds.bottom;
        });
      if (!root) return false;

      const widgetPosition = view.posAtDOM(root, 0);
      const line = view.state.doc.lineAt(widgetPosition);
      const previousLineEnd = line.from > 0 ? line.from - 1 : null;
      const nextLineStart = line.to < view.state.doc.length ? line.to + 1 : null;
      const bounds = root.getBoundingClientRect();
      const position = previousLineEnd !== null
        && (nextLineStart === null || event.clientY < bounds.top + bounds.height / 2)
        ? previousLineEnd
        : nextLineStart ?? previousLineEnd ?? 0;

      event.preventDefault();
      view.dispatch({
        selection: { anchor: position },
        userEvent: 'select.inline-chat-edge'
      });
      view.focus();
      return true;
    }
  })
);

function createInlineChatStateField(options: InlineChatExtensionOptions) {
  const instance: InlineChatInstance = {
    responseState: reactive(createInlineChatResponseState()),
    selectionContext: ''
  };
  let markerPresent = false;

  function syncSelectionContext(state: EditorState, markerFound: boolean): void {
    if (!markerFound) {
      instance.selectionContext = '';
      return;
    }

    const selectedText = state.selection.ranges
      .filter(range => !range.empty)
      .map(range => state.sliceDoc(range.from, range.to).split(INLINE_CHAT_MARKER).join(''))
      .join('\n')
      .trim();
    if (selectedText) instance.selectionContext = selectedText;
  }

  function buildInlineChatDecorations(state: EditorState) {
    const decorationRanges: Range<Decoration>[] = [];
    let foundMarker = false;
    let searchFrom = 0;
    while (searchFrom < state.doc.length) {
      const markerFrom = state.doc.sliceString(searchFrom).indexOf(INLINE_CHAT_MARKER);
      if (markerFrom < 0) break;
      if (foundMarker) break;
      const from = searchFrom + markerFrom;
      const to = from + INLINE_CHAT_MARKER.length;
      foundMarker = true;
      const inputDecoration = Decoration.replace({
        widget: new InlineChatPanelWidget(options, instance),
        block: true
      }).range(from, to);
      const responseDecoration = Decoration.widget({
        widget: new InlineChatResponseWidget(instance),
        block: true,
        side: 1
      }).range(to);
      decorationRanges.push(inputDecoration, responseDecoration);
      searchFrom = to;
    }
    if (!foundMarker && markerPresent) {
      instance.responseState.markdown = '';
      instance.responseState.error = '';
      instance.responseState.isStreaming = false;
    }
    syncSelectionContext(state, foundMarker);
    markerPresent = foundMarker;
    const decorations = Decoration.set(decorationRanges, true);
    return {
      decorations,
      atomicRanges: decorations
    } satisfies InlineChatDecorationState;
  }

  return StateField.define<InlineChatDecorationState>({
    create: buildInlineChatDecorations,
    update(decorations, transaction) {
      if (transaction.docChanged) {
        return buildInlineChatDecorations(transaction.state);
      }
      if (transaction.selection) {
        if (transaction.state.selection.ranges.some(range => !range.empty)) {
          syncSelectionContext(transaction.state, markerPresent);
        } else if (transaction.isUserEvent('select.pointer')) {
          instance.selectionContext = '';
        }
      }
      return decorations;
    },
    provide: (field) => [
      EditorView.decorations.from(field, value => value.decorations),
      EditorView.atomicRanges.of(view => view.state.field(field).atomicRanges)
    ]
  });
}

export function createEditorInlineChatExtension(options: InlineChatExtensionOptions) {
  return [
    createInlineChatStateField(options),
    inlineChatContextSelectionAttributes,
    acceptedInlineChatDecorationField,
    inlineChatSingleInstanceExtension,
    inlineChatMouseSelectionExtension
  ];
}
