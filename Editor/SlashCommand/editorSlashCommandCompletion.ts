/**
 * Provides a Markdown slash-command menu through CodeMirror's native completion UI.
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion,
  startCompletion
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { createApp, h, shallowRef } from 'vue';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import { INLINE_CHAT_MARKER } from '@editor/InlineChat/inlineChatLifecycle';
import { insertMarkdownTableSource } from '@editor/Table/tableInsertion';

type SlashCommand = {
  readonly label: string;
  readonly detail: string;
  readonly insert: string;
  readonly section?: string;
  readonly type?: string;
} & (
  | { readonly kind: 'table' }
  | { readonly kind?: undefined; readonly cursorOffset: number }
);

const SLASH_COMMAND_CONTEXT_PATTERN = /^(\s*)\/([^\r\n]*)$/u;
let slashCompletionSearchQuery = '';
const EXCLUDED_SLASH_COMMAND_NODES = new Set([
  'Comment',
  'CommentBlock',
  'FencedCode',
  'HTMLBlock',
  'HTMLTag',
  'InlineCode'
]);

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { label: '内联聊天', detail: '', insert: '<!-- wstudio-inline-chat -->', cursorOffset: 0, section: 'AI', type: 'special-icon ai-chat-icon' },
  { label: '文本', detail: '', insert: '', cursorOffset: 0, type: 'basic-icon text-icon' },
  { label: '标题1', detail: '#', insert: '# ', cursorOffset: 2, type: 'heading-icon heading-1' },
  { label: '标题2', detail: '##', insert: '## ', cursorOffset: 3, type: 'heading-icon heading-2' },
  { label: '标题3', detail: '###', insert: '### ', cursorOffset: 4, type: 'heading-icon heading-3' },
  { label: '标题4', detail: '####', insert: '#### ', cursorOffset: 5, type: 'heading-icon heading-4' },
  { label: '无序列表', detail: '-', insert: '- ', cursorOffset: 2, type: 'basic-icon unordered-list-icon' },
  { label: '有序列表', detail: '1.', insert: '1. ', cursorOffset: 3, type: 'basic-icon ordered-list-icon' },
  { label: '待办事项', detail: '-[]', insert: '- [ ] ', cursorOffset: 6, type: 'basic-icon todo-list-icon' },
  { label: '引用', detail: '>', insert: '> ', cursorOffset: 2, type: 'basic-icon quote-icon' },
  { label: '标注', detail: '', insert: '> [!NOTE] 标注\n> ', cursorOffset: 15, type: 'basic-icon admonition-icon' },
  {
    label: '表格',
    kind: 'table',
    detail: '',
    insert: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |',
    type: 'basic-icon table-icon'
  },
  { label: '分割线', detail: '---', insert: '---\n', cursorOffset: 4, type: 'basic-icon divider-icon' },
  { label: '脚注', detail: '[^]', insert: '[^1]: ', cursorOffset: 6, type: 'basic-icon footnote-icon' },
  { label: '提醒内容', detail: '', insert: '> [!NOTE] 提醒内容\n> ', cursorOffset: 16, section: '重要信息' },
  { label: '建议内容', detail: '', insert: '> [!TIP] 建议内容\n> ', cursorOffset: 15, section: '重要信息' },
  { label: '重要内容', detail: '', insert: '> [!IMPORTANT] 重要内容\n> ', cursorOffset: 22, section: '重要信息' },
  { label: '警告内容', detail: '', insert: '> [!WARNING] 警告内容\n> ', cursorOffset: 20, section: '重要信息' },
  { label: '注意内容', detail: '', insert: '> [!CAUTION] 注意内容\n> ', cursorOffset: 19, section: '重要信息' },
  { label: '图片', detail: '![]()', insert: '![](<>)', cursorOffset: 5, section: '媒体', type: 'basic-icon image-icon' },
  { label: '视频', detail: '![[ ]]', insert: '![[媒体路径]]', cursorOffset: 9, section: '媒体', type: 'basic-icon video-icon' },
  { label: '音频', detail: '![[ ]]', insert: '![[媒体路径]]', cursorOffset: 9, section: '媒体', type: 'basic-icon audio-icon' },
  { label: '代码', detail: '```', insert: '```text\n\n```', cursorOffset: 8, section: '媒体', type: 'basic-icon code-icon' },
  { label: '文件', detail: '[]()', insert: '[](<>)', cursorOffset: 4, section: '媒体', type: 'basic-icon file-icon' },
  { label: '网页书签', detail: '[]()', insert: '[](https://)', cursorOffset: 2, section: '媒体', type: 'basic-icon bookmark-icon' },
  { label: '代码块', detail: '', insert: '```text\n\n```', cursorOffset: 8, section: '高级块' },
  { label: '数学块', detail: '', insert: '$$\n\n$$', cursorOffset: 3, section: '高级块' },
  { label: 'mermaid块', detail: '', insert: '```mermaid\n\n```', cursorOffset: 11, section: '高级块' },
  { label: '默认文本', detail: '', insert: '文本', cursorOffset: 2, section: '文本颜色', type: 'color-swatch color-default' },
  { label: '灰色文本', detail: '', insert: '<span style="color: gray;">文本</span>', cursorOffset: 27, section: '文本颜色', type: 'color-swatch color-gray' },
  { label: '棕色文本', detail: '', insert: '<span style="color: brown;">文本</span>', cursorOffset: 28, section: '文本颜色', type: 'color-swatch color-brown' },
  { label: '橙色文本', detail: '', insert: '<span style="color: orange;">文本</span>', cursorOffset: 29, section: '文本颜色', type: 'color-swatch color-orange' },
  { label: '黄色文本', detail: '', insert: '<span style="color: yellow;">文本</span>', cursorOffset: 29, section: '文本颜色', type: 'color-swatch color-yellow' },
  { label: '绿色文本', detail: '', insert: '<span style="color: green;">文本</span>', cursorOffset: 28, section: '文本颜色', type: 'color-swatch color-green' },
  { label: '蓝色文本', detail: '', insert: '<span style="color: blue;">文本</span>', cursorOffset: 27, section: '文本颜色', type: 'color-swatch color-blue' },
  { label: '紫色文本', detail: '', insert: '<span style="color: purple;">文本</span>', cursorOffset: 29, section: '文本颜色', type: 'color-swatch color-purple' },
  { label: '粉色文本', detail: '', insert: '<span style="color: pink;">文本</span>', cursorOffset: 27, section: '文本颜色', type: 'color-swatch color-pink' },
  { label: '红色文本', detail: '', insert: '<span style="color: red;">文本</span>', cursorOffset: 26, section: '文本颜色', type: 'color-swatch color-red' },
  { label: '默认背景', detail: '', insert: '文本', cursorOffset: 2, section: '背景颜色', type: 'background-swatch background-default' },
  { label: '灰色背景', detail: '', insert: '<span style="background-color: #aaaaaa;">文本</span>', cursorOffset: 38, section: '背景颜色', type: 'background-swatch background-gray' },
  { label: '棕色背景', detail: '', insert: '<span style="background-color: #a36b3d;">文本</span>', cursorOffset: 39, section: '背景颜色', type: 'background-swatch background-brown' },
  { label: '橙色背景', detail: '', insert: '<span style="background-color: #F87D01;">文本</span>', cursorOffset: 40, section: '背景颜色', type: 'background-swatch background-orange' },
  { label: '黄色背景', detail: '', insert: '<span style="background-color: #e7bd12;">文本</span>', cursorOffset: 40, section: '背景颜色', type: 'background-swatch background-yellow' },
  { label: '绿色背景', detail: '', insert: '<span style="background-color: #039E03;">文本</span>', cursorOffset: 39, section: '背景颜色', type: 'background-swatch background-green' },
  { label: '蓝色背景', detail: '', insert: '<span style="background-color: #2786e6;">文本</span>', cursorOffset: 38, section: '背景颜色', type: 'background-swatch background-blue' },
  { label: '紫色背景', detail: '', insert: '<span style="background-color: #a844ff;">文本</span>', cursorOffset: 40, section: '背景颜色', type: 'background-swatch background-purple' },
  { label: '粉色背景', detail: '', insert: '<span style="background-color: #f06fbc;">文本</span>', cursorOffset: 38, section: '背景颜色', type: 'background-swatch background-pink' },
  { label: '红色背景', detail: '', insert: '<span style="background-color: #DE0808;">文本</span>', cursorOffset: 37, section: '背景颜色', type: 'background-swatch background-red' }
];

const SLASH_COMPLETION_LIST_SELECTOR =
  '.cm-tooltip-autocomplete.cm-editor-slash-command-completion > ul[role="listbox"]';

/** Binds the workbench scrollbar to CodeMirror's live completion list without taking over wheel scrolling. */
class SlashCompletionScrollbarPlugin {
  private readonly view: EditorView;
  private attachedList: HTMLElement | null = null;
  private listWheelHandler: ((event: WheelEvent) => void) | null = null;
  private attachedTooltip: HTMLElement | null = null;
  private scrollbarHost: HTMLElement | null = null;
  private searchHost: HTMLElement | null = null;
  private scrollbarApp: ReturnType<typeof createApp> | undefined;
  private readonly scrollbarScroller = shallowRef<HTMLElement | null>(null);
  private syncFrame = 0;
  private detachTimeout = 0;
  private lastScrollTop = 0;
  private readonly mutationObserver: MutationObserver;

  constructor(view: EditorView) {
    this.view = view;
    this.mutationObserver = new MutationObserver(() => {
      this.scheduleSync();
    });
    this.mutationObserver.observe(view.dom, {
      childList: true,
      subtree: true
    });
    this.scheduleSync();
  }

  update(): void {
    this.scheduleSync();
  }

  destroy(): void {
    if (this.syncFrame !== 0) {
      window.cancelAnimationFrame(this.syncFrame);
      this.syncFrame = 0;
    }
    if (this.detachTimeout !== 0) {
      window.clearTimeout(this.detachTimeout);
      this.detachTimeout = 0;
    }
    this.mutationObserver.disconnect();
    this.detach();
  }

  private scheduleSync(): void {
    if (this.syncFrame !== 0) return;

    this.syncFrame = window.requestAnimationFrame(() => {
      this.syncFrame = 0;
      this.sync();
    });
  }

  private sync(): void {
    const list = this.view.dom.querySelector<HTMLElement>(
      SLASH_COMPLETION_LIST_SELECTOR
    );

    if (!list) {
      this.scheduleDetach();
      return;
    }

    if (this.detachTimeout !== 0) {
      window.clearTimeout(this.detachTimeout);
      this.detachTimeout = 0;
    }

    const tooltip = list.closest<HTMLElement>(
      '.cm-tooltip-autocomplete.cm-editor-slash-command-completion'
    );
    if (!tooltip) return;

    if (tooltip !== this.attachedTooltip) {
      this.detach();
      this.attachedTooltip = tooltip;
      this.searchHost = document.createElement('div');
      this.searchHost.className = 'cm-editor-slash-command-completion__search';
      const searchIcon = document.createElement('span');
      searchIcon.className = 'cm-editor-slash-command-completion__search-icon';
      searchIcon.setAttribute('aria-hidden', 'true');
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.className = 'cm-editor-slash-command-completion__search-input';
      searchInput.placeholder = '搜索补全选项';
      searchInput.setAttribute('aria-label', '搜索补全选项');
      searchInput.value = slashCompletionSearchQuery;
      searchInput.addEventListener('input', () => {
        slashCompletionSearchQuery = searchInput.value;
        startCompletion(this.view);
      });
      searchInput.addEventListener('mousedown', (event) => {
        event.stopPropagation();
      });
      searchInput.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          this.view.focus();
        }
      });
      this.searchHost.append(searchIcon, searchInput);
      tooltip.prepend(this.searchHost);
      this.scrollbarHost = document.createElement('div');
      this.scrollbarHost.className = 'cm-editor-slash-command-completion__scrollbar';
      this.scrollbarHost.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      this.scrollbarHost.addEventListener('wheel', (event: WheelEvent) => {
        const target = this.attachedList;
        if (!target || event.deltaY === 0) return;

        event.preventDefault();
        event.stopPropagation();
        target.scrollTop += event.deltaY;
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

    // CodeMirror may remove the old list before this observer callback runs,
    // which resets that detached node's scrollTop to zero. Prefer the last
    // value observed from its scroll event when restoring a replacement list.
    const previousScrollTop = Math.max(this.lastScrollTop, this.attachedList?.scrollTop ?? 0);
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
    list.addEventListener('scroll', this.handleListScroll, { passive: true });

    if (previousScrollTop > 0) {
      window.requestAnimationFrame(() => {
        if (this.attachedList !== list) return;
        const maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
        list.scrollTop = Math.min(previousScrollTop, maxScrollTop);
        this.lastScrollTop = list.scrollTop;
      });
    }
  }

  private readonly handleListScroll = (event: Event): void => {
    const list = event.currentTarget;
    if (list instanceof HTMLElement) {
      this.lastScrollTop = list.scrollTop;
    }
  };

  private detachList(): void {
    if (this.attachedList && this.listWheelHandler) {
      this.attachedList.removeEventListener('wheel', this.listWheelHandler);
      this.attachedList.removeEventListener('scroll', this.handleListScroll);
    }
    this.listWheelHandler = null;
    if (this.attachedList) {
      this.lastScrollTop = this.attachedList.scrollTop;
    }
    this.attachedList = null;
  }

  private scheduleDetach(): void {
    if (this.detachTimeout !== 0) return;

    this.detachTimeout = window.setTimeout(() => {
      this.detachTimeout = 0;
      if (!this.view.dom.querySelector(
        SLASH_COMPLETION_LIST_SELECTOR
      )) {
        this.detach();
      }
    }, 120);
  }

  private detach(): void {
    this.detachList();
    this.scrollbarScroller.value = null;
    this.scrollbarApp?.unmount();
    this.scrollbarApp = undefined;
    this.scrollbarHost?.remove();
    this.scrollbarHost = null;
    this.searchHost?.remove();
    this.searchHost = null;
    this.attachedTooltip = null;
  }
}

function isExcludedSyntaxPosition(state: EditorState, position: number): boolean {
  if (state.doc.length === 0) return false;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(
    Math.max(0, Math.min(state.doc.length - 1, position - 1)),
    -1
  );

  while (node) {
    if (EXCLUDED_SLASH_COMMAND_NODES.has(node.name)) return true;
    node = node.parent;
  }

  const sourceBeforeCursor = state.sliceDoc(0, position);
  return sourceBeforeCursor.lastIndexOf('<!--') > sourceBeforeCursor.lastIndexOf('-->');
}

function findSlashCommandContext(
  state: EditorState,
  position = state.selection.main.head
): { from: number; to: number } | null {
  if (state.selection.ranges.some(range => !range.empty)) return null;
  const line = state.doc.lineAt(position);
  const cursorOffset = position - line.from;
  const beforeCursor = line.text.slice(0, cursorOffset);
  const match = SLASH_COMMAND_CONTEXT_PATTERN.exec(beforeCursor);

  if (!match || line.text.slice(cursorOffset).length > 0) return null;
  if (isExcludedSyntaxPosition(state, position)) return null;

  const slashOffset = match[1].length;
  return {
    from: line.from + slashOffset + 1,
    to: position
  };
}

/** Closes existing inline-chat widgets before opening a replacement in this editor. */
function closeExistingInlineChatMarkers(view: EditorView): void {
  const content = view.state.doc.toString();
  const changes: Array<{ from: number; to: number }> = [];
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const markerFrom = content.indexOf(INLINE_CHAT_MARKER, searchFrom);
    if (markerFrom < 0) break;
    changes.push({
      from: markerFrom,
      to: markerFrom + INLINE_CHAT_MARKER.length
    });
    searchFrom = markerFrom + INLINE_CHAT_MARKER.length;
  }

  if (changes.length === 0) return;

  view.dispatch({
    changes,
    userEvent: 'delete.inline-chat-reopen'
  });
}

function createSlashCommandCompletion(command: SlashCommand): Completion {
  return {
    label: command.label,
    detail: command.detail,
    type: command.type ?? 'keyword',
    section: command.section ?? '基础块',
    apply(view, completion, from, to) {
      if (command.insert === INLINE_CHAT_MARKER) {
        closeExistingInlineChatMarkers(view);
        const refreshedContext = findSlashCommandContext(view.state);
        if (refreshedContext) {
          from = refreshedContext.from;
          to = refreshedContext.to;
        }
      }

      const slashFrom = Math.max(0, from - 1);
      if (command.kind === 'table') {
        insertMarkdownTableSource(view, command.insert, { from: slashFrom, to }, pickedCompletion.of(completion));
        view.focus();
        return;
      }
      const cursor = slashFrom + command.cursorOffset;
      view.dispatch({
        changes: { from: slashFrom, to, insert: command.insert },
        selection: { anchor: cursor },
        annotations: pickedCompletion.of(completion),
        scrollIntoView: true,
        userEvent: 'input.complete'
      });
      view.focus();
    }
  };
}

/** Returns slash commands only for a paragraph-level slash query. */
export function editorSlashCommandCompletionSource(
  context: CompletionContext
): CompletionResult | null {
  const completionContext = findSlashCommandContext(context.state, context.pos);
  if (!completionContext) return null;

  const editorQuery = context.state.sliceDoc(completionContext.from, completionContext.to).toLocaleLowerCase();
  const searchQuery = slashCompletionSearchQuery.trim().toLocaleLowerCase();
  const query = searchQuery || editorQuery;
  const options = SLASH_COMMANDS
    .filter((command) => query.length === 0 || command.label.toLocaleLowerCase().includes(query))
    .map(createSlashCommandCompletion);

  if (options.length === 0) {
    options.push({
      label: '无匹配选项',
      detail: '',
      type: 'text',
      apply(view) {
        view.focus();
      }
    });
  }

  return {
    from: completionContext.from,
    to: completionContext.to,
    options,
    // Keep the authored order for the 基础块 group instead of CodeMirror's default sorting.
    filter: false,
  };
}

/** Opens the native completion panel immediately after a slash is typed. */
const slashCommandTriggerExtension = EditorView.updateListener.of(update => {
  if (!update.docChanged) return;
  const typedSlash = update.transactions.some(transaction => {
    if (!transaction.isUserEvent('input')) return false;
    let insertedSlash = false;
    transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
      if (inserted.toString().includes('/')) insertedSlash = true;
    });
    return insertedSlash;
  });
  if (typedSlash && findSlashCommandContext(update.state)) {
    slashCompletionSearchQuery = '';
    startCompletion(update.view);
  }
});

export const editorSlashCommandCompletionExtension = [
  EditorState.languageData.of(() => [{
    autocomplete: editorSlashCommandCompletionSource
  }]),
  ViewPlugin.fromClass(SlashCompletionScrollbarPlugin),
  slashCommandTriggerExtension
];

export function isEditorSlashCommandCompletionState(state: EditorState): boolean {
  return findSlashCommandContext(state) !== null;
}
