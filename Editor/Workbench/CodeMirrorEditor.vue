<script setup lang="ts">
/**
 * 文件说明：封装工作台使用的 CodeMirror 编辑器，并同步自定义滚动条与运行时主题。 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { storeToRefs } from 'pinia';
import type {
  UpdateWorkspaceMarkdownFileResult,
  WorkspaceFileEntry,
  WorkspaceMarkdownFile,
  WorkspaceMarkdownFileMetadata
} from '@/types/ipc';
import { workspaceApi } from '@/api/workspace';
import { isWindowsLocalMediaPath, pickLocalImageFile, resolveRelativeMediaPath } from '@/api/media';
import WorkbenchDialog from '@/components/workbench/WorkbenchDialog.vue';
import WsInput from '@/components/WsInput/WsInput.vue';
import { useNotificationStore } from '@/store/notification';
import type { PluginEditorVerticalAlignment } from '../../plugin/sdk';
import { Compartment, EditorSelection, EditorState, Prec, countColumn, type Range } from '@codemirror/state';
import {
  defaultKeymap,
  history,
  historyKeymap
} from '@codemirror/commands';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete';
import {
  bracketMatching,
  foldKeymap,
  indentOnInput,
  ensureSyntaxTree,
  syntaxTree,
  syntaxHighlighting
} from '@codemirror/language';
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkupCommand,
  markdownLanguage,
  markdown
} from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, search as createSearchExtension, searchKeymap } from '@codemirror/search';
import { Strikethrough } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';
import {
  Decoration,
  DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  scrollPastEnd,
  ViewPlugin,
  ViewUpdate,
} from '@codemirror/view';

const arrowForwardIcon = '<span class="icon icon-arrow-forward"></span>';
const checkedIcon = '<span class="icon icon-check-gou-xuan"></span>';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import ProjectColorPicker from '@/components/workbench/ProjectColorPicker.vue';
import { DEFAULT_CUSTOM_PROJECT_COLOR, normalizeHexColor, recordColorHistory } from '@/utils/colorPalette';
import CodeMirrorContextMenu from './CodeMirrorContextMenu.vue';
import { useThemeStore } from '@/store/theme';
import { useEditorSettingsStore } from '@/store/editorSettings';
import { announceContextMenuOpen, registerContextMenu } from '@/utils/contextMenuCoordinator';
import { getWorkspaceFileExtension, resolveWorkspaceFileKind } from '../../plugin/sdk/fileTypes';
import {
  codeMirrorContextMenuItems,
  type CodeMirrorContextMenuActionId
} from '@editor/Core/codeMirrorContextMenu';
import { disableSetextHeadingExtension } from '@editor/Markdown/disableSetextHeadingExtension';
import { bracketExpressionExtension } from '@editor/Markdown/bracketExpressionExtension';
import { createEditorBlockClassName } from '@editor/Block/editorBlockSpacing';
import { editorBlockCursorExtension } from '@editor/Block/editorBlockCursorExtension';
import {
  createEditorFoldGutterExtension
} from '@editor/Block/editorFoldGutterExtension';
import {
  editorCodeBlockExtension,
  isEditorCodeBlockFenceLine,
  isEditorCodeBlockLine
} from '@editor/CodeBlock/editorCodeBlockExtension';
import {
  editorCodeBlockHighlightStyle,
  editorCodeBlockLanguages
} from '@editor/CodeBlock/editorCodeBlockSyntaxHighlight';
import {
  createEditorImageBlockExtension,
  refreshEditorImageBlockResourcesEffect
} from '@editor/ImageBlock/editorImageBlockExtension';
import { imageBlockContextMenuItems } from '@editor/ImageBlock/imageBlockContextMenu';
import { createEditorAudioBlockExtension } from '@editor/AudioBlock/editorAudioBlockExtension';
import { refreshEditorPlayableMediaBlockResourcesEffect } from '@editor/MediaBlock/editorPlayableMediaBlockExtension';
import { emptyInlineCodeExtension } from '@editor/Markdown/emptyInlineCodeExtension';
import { emptyTildeFenceExtension } from '@editor/Markdown/emptyTildeFenceExtension';
import { indentedOrderedListExtension } from '@editor/Markdown/indentedOrderedListExtension';
import {
  createIndentationGuideExtension,
  type IndentationGuideStyle
} from '@editor/IndentationGuides/indentationGuideExtension';
import { INDENTATION_COLUMNS } from '@editor/IndentationGuides/indentationGuideModel';
import { listItemHeadingExtension } from '@editor/Markdown/listItemHeadingExtension';
import { markdownHighlightExtension } from '@editor/Markdown/markdownHighlightExtension';
import {
  editorMarkdownHeadingDecorationsExtension,
  editorMarkdownHeadingTheme,
  editorMarkdownDocumentTheme,
  editorMarkdownHighlightStyle
} from '@editor/Markdown/editorMarkdownRenderExtensions';
import { editorSelectionTheme } from '@editor/Core/editorSelectionTheme';
import { editorSpaceWidthExtension } from '@editor/Core/editorSpaceWidthExtension';
import { createMarkdownInlineLinkPreviewExtension } from '@editor/Markdown/markdownInlineLinkPreviewExtension';
import type { MarkdownInlineLinkNavigationTarget } from '@editor/Markdown/markdownInlineLinkPreview';
import {
  markdownInlineFormattingExtension,
  markdownInlineFormattingTheme
} from '@editor/Markdown/markdownInlineFormattingExtension';
import { isSelectionOnDocumentLine } from '@editor/Markdown/markdownSelectionState';
import { getMarkdownQuoteIndentLength } from '@editor/Markdown/markdownQuoteIndent';
import { collectMarkdownInlineLinkRanges } from '@editor/Markdown/markdownInlineLink';
import {
  markdownListMarkerFallbackExtension,
  markdownListMarkerHighlightExtension
} from '@editor/Markdown/markdownListMarkerHighlightExtension';
import { createEditorMediaDropExtension } from '@editor/Core/mediaDropExtension';
import { editorMathBlockExtension, insertMathBlock } from '@editor/Core/mathBlockExtension';
import {
  editorMermaidBlockExtension,
  refreshEditorMermaidThemeEffect
} from '@editor/MermaidBlock/editorMermaidBlockExtension';
import { orderedListContinuationExtension } from '@editor/Markdown/orderedListContinuationExtension';
import { tagHighlightExtension } from '@editor/Markdown/tagHighlightExtension';
import {
  createEditorTableBlockExtension,
  canInsertEditorTableCellImage,
  insertEditorTableCellImage,
  getEditorTableCellImage,
  updateEditorTableCellImage,
  editorTableMarkdownExtension,
  executeTableContextAction,
  getEditorTableColumnBackground,
  getEditorTableRowBackground,
  resolveEditorTableCellView,
  setEditorTableColumnBackground,
  setEditorTableRowBackground,
  setTableContextHighlight,
  setTableImageContextTargetEffect,
  type EditorTableContextTarget
} from '@editor/Table/editorTableExtension';
import {
  isTableCellImageDimension,
  resolveTableCellImageSize,
  resolveTableCellImageLayout,
  resolveTableCellImageLayoutAction,
  TABLE_CELL_IMAGE_MAX_SIZE,
  getTableCellImageContextMenuItems,
  type TableCellImage
} from '@editor/Table/tableCellImages';
import {
  tableCellContextMenuItems,
  tableColumnContextMenuItems,
  tableRowContextMenuItems,
  type TableContextMenuActionId
} from '@editor/Table/tableColumnContextMenu';
import { insertMarkdownTable } from '@editor/Table/tableInsertion';
import { createEditorVideoBlockExtension } from '@editor/VideoBlock/editorVideoBlockExtension';
import {
  closeInlineChatWidgets,
  createEditorInlineChatExtension,
  disposeInlineChatWidgets
} from '@editor/InlineChat/editorInlineChatExtension';
import type { RecentWorkspaceFile } from '@/store/dockingThree';
import { parseNoteDocument } from '@editor/NoteProperties/noteProperties';
import {
  EDITOR_NOTE_PROPERTIES_BLOCK_CLASS,
  createEditorNotePropertiesBlockExtension,
  resolveEditorNotePropertiesBlockExpanded,
  setEditorNotePropertiesBlockExpandedEffect,
  setEditorNotePropertiesBlockVisibilityEffect,
  toggleEditorNotePropertiesBlockExpandedEffect,
  type EditorNotePropertiesBlockHost
} from '@editor/NotePropertiesBlock/editorNotePropertiesBlockExtension';
import {
  createEditorNotePropertiesDocumentChange
} from '@editor/NotePropertiesBlock/editorNotePropertiesBlockTransaction';
import { insertEditorWikiLink } from '@editor/WikiLink/editorWikiLink';
import {
  editorWikiLinkCompletionExtension,
  isEditorWikiLinkHeadingCompletionState
} from '@editor/WikiLink/editorWikiLinkCompletionExtension';
import {
  createEditorWikiLinkBlockCompletionExtension,
  isEditorWikiLinkBlockCompletionState
} from '@editor/WikiLink/editorWikiLinkBlockCompletionExtension';
import {
  createEditorWikiLinkEmbedCompletionExtension,
  isEditorWikiLinkEmbedCompletionState
} from '@editor/WikiLinkEmbed/editorWikiLinkEmbedExtension';
import { editorHtmlBlockExtension } from '@editor/HtmlBlock/editorHtmlBlockExtension';
import { editorHtmlSourceHighlightExtension } from '@editor/HtmlBlock/editorHtmlSourceHighlightExtension';
import {
  editorHtmlHighlightStyle,
  editorHtmlLanguageSupport
} from '@editor/HtmlBlock/editorHtmlSyntaxHighlight';
import { editorAdmonitionExtension } from '@editor/Admonition/editorAdmonitionExtension';
import {
  editorFootnoteCompletionExtension,
  isEditorFootnoteCompletionState
} from '@editor/Footnote/editorFootnoteCompletionExtension';
import {
  continueTaskListFromSource,
  taskListExtension,
  taskListThemeExtension
} from '@editor/Markdown/taskListExtension';
import {
  editorSlashCommandCompletionExtension,
  isEditorSlashCommandCompletionState
  } from '@editor/SlashCommand/editorSlashCommandCompletion';
import { createWsEditorlineSearchPanel } from '@/components/WsEditorlineSearch/editorlineSearchPanel';

const AsyncTableSizePicker = defineAsyncComponent(
  () => import('@editor/Table/TableSizePicker.vue')
);
const imageNotificationStore = useNotificationStore();
const AsyncNotePropertiesPanel = defineAsyncComponent(
  () => import('@editor/NoteProperties/NotePropertiesPanel.vue')
);

interface CodeMirrorEditorProps {
  autofocus?: boolean;
  dateNoteCreationPending?: boolean;
  filePath?: string;
  modelValue?: string;
  notePropertiesMenuRequestId?: number;
  notePropertiesVisible?: boolean;
  pathNavigationVisible?: boolean;
  recentWorkspaceFiles?: readonly RecentWorkspaceFile[];
  workspaceFiles?: readonly WorkspaceFileEntry[];
  workspaceMarkdownFiles?: readonly WorkspaceMarkdownFileMetadata[];
  persistWikiLinkTarget?: (
    filePath: string,
    expectedContent: string,
    content: string
  ) => Promise<UpdateWorkspaceMarkdownFileResult>;
  readWorkspaceFile?: (filePath: string) => Promise<WorkspaceMarkdownFile | undefined>;
  navigationRequest?: {
    readonly id: number;
    readonly position: number;
    readonly selectionEnd?: number;
    readonly verticalAlignment?: PluginEditorVerticalAlignment;
  };
}

const EDITOR_UPPER_CENTER_VIEWPORT_RATIO = 0.32;

const props = withDefaults(defineProps<CodeMirrorEditorProps>(), {
  autofocus: false,
  dateNoteCreationPending: false,
  modelValue: '',
  notePropertiesMenuRequestId: 0,
  notePropertiesVisible: false,
  pathNavigationVisible: true,
  recentWorkspaceFiles: () => [],
  workspaceFiles: () => [],
  workspaceMarkdownFiles: () => []
});

const emit = defineEmits<{
  'create-date-note': [date: string];
  'open-external-link': [url: string];
  'open-file-in-new-tab': [filePath: string];
  'navigate-markdown-link': [target: MarkdownInlineLinkNavigationTarget];
  'toggle-note-properties': [visible: boolean];
  'toggle-path-navigation': [visible: boolean];
  'selection-change': [start: number, end: number];
  'update:modelValue': [value: string];
}>();

const editorHost = ref<HTMLElement | null>(null);
const editorView = shallowRef<EditorView>();
let isDisposingEditor = false;
const scrollerElement = shallowRef<HTMLElement>();
let editorScrollElement: HTMLElement | undefined;
let editorPageLayoutObserver: ResizeObserver | undefined;
let disposeWorkspaceDirectoryChanged: (() => void) | undefined;
const localMediaInput = ref<HTMLInputElement | null>(null);
const editorThemeCompartment = new Compartment();
const editorLanguageCompartment = new Compartment();
const indentationGuideCompartment = new Compartment();
const themeStore = useThemeStore();
const { activeAppearance, activeTheme } = storeToRefs(themeStore);
const editorSettingsStore = useEditorSettingsStore();
const { editorFontFamily, editorFontSize } = storeToRefs(editorSettingsStore);
const editorLineHeight = computed(() => `${Number(editorFontSize.value) * 1.6}px`);
const editorHeadingFontSize = computed(() => `${Number(editorFontSize.value) * (1.25 / 0.9)}px`);
const isDarkTheme = computed(() => activeAppearance.value !== 'light');

/** 将键盘焦点交给当前 CodeMirror 编辑实例。 */
function focusEditor(): void {
  editorView.value?.focus();
}

defineExpose({
  focus: focusEditor
});
const isJsonDocument = computed(() => {
  const extension = getWorkspaceFileExtension(props.filePath ?? '');
  return extension === '.json' || extension === '.jsonc';
});
const notePropertiesBlockTarget = shallowRef<HTMLElement>();
const notePropertiesBlockExpanded = ref(true);
const notePropertiesBlockVisible = computed(() => (
  props.notePropertiesVisible && !isJsonDocument.value
));
const notePropertiesBlockHost: EditorNotePropertiesBlockHost = {
  /** 将当前 Vue 属性视图挂载到 CodeMirror 创建的块节点。 */
  attach(target) {
    notePropertiesBlockTarget.value = target;
  },
  /** 仅清除仍指向被销毁块节点的挂载目标。 */
  detach(target) {
    if (notePropertiesBlockTarget.value === target) {
      notePropertiesBlockTarget.value = undefined;
    }
  },
  /** 将 CodeMirror StateField 的展开状态同步到属性视图。 */
  setExpanded(expanded) {
    notePropertiesBlockExpanded.value = expanded;
  }
};
const notePropertiesBlockExtension = createEditorNotePropertiesBlockExtension({
  host: notePropertiesBlockHost,
  initialVisible: notePropertiesBlockVisible.value
});
const NOTE_PROPERTIES_FOLD_MARKER_CLASS = 'cm-fold-marker--note-properties';
const editorFoldGutterExtension = createEditorFoldGutterExtension({
  /** 将笔记属性块 Widget 映射为统一 gutter 控制状态。 */
  resolveBlockControl(widget) {
    const expanded = resolveEditorNotePropertiesBlockExpanded(widget);
    return expanded === null
      ? null
      : {
        className: NOTE_PROPERTIES_FOLD_MARKER_CLASS,
        expanded
      };
  },
  /** 点击笔记属性 gutter 图标时切换块状态。 */
  toggleBlock(view, _block, controlClassName) {
    if (controlClassName !== NOTE_PROPERTIES_FOLD_MARKER_CLASS) {
      return false;
    }

    view.dispatch({
      effects: toggleEditorNotePropertiesBlockExpandedEffect.of(null)
    });
    return true;
  },
  /** 仅在属性块展开事务发生时刷新块 gutter 标记。 */
  blockStateChanged(update) {
    return update.transactions.some(transaction => (
      transaction.effects.some(effect => (
        effect.is(toggleEditorNotePropertiesBlockExpandedEffect)
        || effect.is(setEditorNotePropertiesBlockExpandedEffect)
      ))
    ));
  }
});
const editorAudioBlockExtension = createEditorAudioBlockExtension(() => props.filePath);
const editorVideoBlockExtension = createEditorVideoBlockExtension(() => props.filePath);
const editorImageBlockExtension = createEditorImageBlockExtension(() => props.filePath);
const editorMediaDropExtension = createEditorMediaDropExtension({
  getCurrentFilePath: () => props.filePath
});
const MARKDOWN_TASK_LIST_PATTERN = /^\s*[-+*]\s+\[[ xX]\](?=\s|$)/;
const contextMenuOverlayClass = 'code-mirror-editor__context-menu-overlay';
const imageContextMenuOverlayClass = `${contextMenuOverlayClass} code-mirror-editor__image-context-menu-overlay`;
const isContextMenuVisible = ref(false);
const isImageContextMenuVisible = ref(false);
/** 图片菜单和尺寸窗口保留文档快照，避免异步关闭或文档切换后修改其他附件。 */
interface TableImageMenuTarget {
  readonly view: EditorView;
  readonly document: EditorState['doc'];
  readonly filePath: string | undefined;
  readonly cell: EditorTableContextTarget;
  readonly imageIndex: number;
  readonly image: TableCellImage;
  readonly width: number;
  readonly height: number;
}
const tableImageMenuTarget = shallowRef<TableImageMenuTarget | null>(null);
/** 表格 Widget 渲染可能同步刷新 Vue，延后描边事务以避开 CodeMirror 更新重入。 */
watch([isImageContextMenuVisible, tableImageMenuTarget], async ([, target], [, previousTarget]) => {
  await nextTick();
  const visible = isImageContextMenuVisible.value;
  target = tableImageMenuTarget.value;
  const view = target?.view ?? previousTarget?.view;
  if (!view || view !== editorView.value) return;
  const cellFrom = visible && target
    ? view.dom.querySelector<HTMLTableElement>(`.cm-editor-table[data-table-from="${target.cell.tableFrom}"]`)
      ?.rows.item(target.cell.rowIndex === null ? 0 : target.cell.rowIndex + 1)
      ?.cells.item(target.cell.columnIndex)?.dataset.tableCellFrom
    : undefined;
  view.dispatch({ effects: setTableImageContextTargetEffect.of(cellFrom !== undefined && target
    ? { cellFrom: Number(cellFrom), imageIndex: target.imageIndex } : null) });
}, { flush: 'post' });
const tableImageSizeTarget = shallowRef<TableImageMenuTarget | null>(null);
const isTableImageSizeVisible = ref(false);
const tableImageWidth = ref<string | number>('');
const tableImageHeight = ref<string | number>('');
const imageContextMenuItems = computed(() => tableImageMenuTarget.value
  ? getTableCellImageContextMenuItems(tableImageMenuTarget.value.image.position) : imageBlockContextMenuItems);
const imageSizeButtonProps = { variant: 'text' } as const;
const isTableImageSizeValid = computed(() => isTableCellImageDimension(Number(tableImageWidth.value))
  && isTableCellImageDimension(Number(tableImageHeight.value)));
const isTableColumnContextMenuVisible = ref(false);
const isGutterContextMenuVisible = ref(false);
const isGutterHeadingSubmenuVisible = ref(false);
const isGutterPageWidthSubmenuVisible = ref(false);
const isGutterIndentationSubmenuVisible = ref(false);
const gutterContextMenuTarget = ref<[number, number]>([0, 0]);
const headingAlignment = ref<'left' | 'center' | 'right'>('left');
const hideInlineHeading = ref(false);
const showLineNumbers = ref(true);
type IndentationGuideOption = IndentationGuideStyle | 'none';
const indentationGuideStyle = ref<IndentationGuideOption>('solid');
const indentationGuideOptions: readonly {
  readonly id: IndentationGuideOption;
  readonly label: string;
}[] = [
  { id: 'solid', label: '实线' },
  { id: 'dotted', label: '点状' },
  { id: 'none', label: '不显示' }
];
const editorPageWidth = ref(100);
const contextMenuOwner = {};
let disposeContextMenuRegistration: (() => void) | undefined;
const tableColumnContextTarget = ref<EditorTableContextTarget | null>(null);
const tableBackgroundColor = ref(DEFAULT_CUSTOM_PROJECT_COLOR);
const tableBackgroundColors = ref<string[]>([]);
const tableHandleContextMenuItems = computed(() => tableColumnContextTarget.value?.axis === 'row'
  ? tableRowContextMenuItems
  : tableColumnContextMenuItems);
/** 单元格菜单使用独立图像插入入口替代本地媒体入口。 */
const editorContextMenuItems = computed(() => tableColumnContextTarget.value?.axis === 'cell'
  ? codeMirrorContextMenuItems.map((item) => item.id === 'local-media'
    ? { id: 'insert-image', kind: 'action' as const, label: '插入图像', actionId: 'insert-image' as const }
    : item)
  : codeMirrorContextMenuItems);
const activeContextSubmenuId = ref<string | null>(null);
const contextMenuTarget = ref<[number, number]>([0, 0]);
let contextMenuCellEditorView: EditorView | null = null;
const editorContextMenuListProps = {
  density: 'compact',
  nav: true
} as const;
const editorContextMenuItemProps = {
  ripple: false
} as const;
const contextSubmenuParentById = new Map<string, string>([
  ['insert-admonition', 'insert-content'],
  ['insert-table', 'insert-content']
]);

/** 判断菜单项自身或其当前活动子菜单是否仍处于展开状态。 */
function isContextSubmenuVisible(itemId: string): boolean {
  const activeItemId = activeContextSubmenuId.value;
  return activeItemId === itemId
    || (activeItemId !== null && contextSubmenuParentById.get(activeItemId) === itemId);
}

/** 与标题栏一致，关闭色板时才记录最终颜色，忽略拖动过程中的中间值。 */
watch(
  () => isTableColumnContextMenuVisible.value && isContextSubmenuVisible('column-highlight'),
  (visible, previousVisible) => {
    if (visible || !previousVisible) return;
    tableBackgroundColors.value = recordColorHistory(tableBackgroundColors.value, tableBackgroundColor.value);
  },
  { flush: 'sync' }
);
/**
 * 创建 Markdown 续行命令，让空列表项再次回车时直接退出列表。
 */
const continueMarkdownMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false
});

/** 为标准 Markdown 命令未识别的深缩进引用续行，并保留标记后的间距。 */
function continueQuoteFromSource(view: EditorView): boolean {
  if (view.state.readOnly) {
    return false;
  }

  const prefixes = view.state.selection.ranges.map((range) => {
    if (
      !range.empty
      || (!markdownLanguage.isActiveAt(view.state, range.head, -1)
        && !markdownLanguage.isActiveAt(view.state, range.head, 1))
    ) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);
    const prefix = /^[\t ]*(?:>[\t ]*)+/.exec(line.text)?.[0];

    if (
      !prefix
      || range.head < line.from + prefix.length
      || line.text.slice(prefix.length).trim().length === 0
      || isEditorCodeBlockLine(view.state, line.number)
    ) {
      return null;
    }

    // 未闭合围栏也属于代码文本，保持普通换行。
    for (
      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(range.head, -1);
      node;
      node = node.parent
    ) {
      if (node.name === 'FencedCode') {
        return null;
      }
    }

    return prefix;
  });

  if (prefixes.some((prefix) => prefix === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const prefix = prefixes[view.state.selection.ranges.indexOf(range)] ?? '';
    const insert = `\n${prefix}`;
    return {
      changes: { from: range.head, insert },
      range: EditorSelection.cursor(range.head + insert.length)
    };
  });

  view.dispatch({ ...transaction, scrollIntoView: true, userEvent: 'input' });
  return true;
}

/**
 * 在任意缩进层级的有序列表行末回车时，按原缩进续写下一个编号。
 */
function continueOrderedListFromSource(view: EditorView): boolean {
  const nextPrefixes = view.state.selection.ranges.map((range) => {
    if (!range.empty) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);

    if (range.head !== line.to) {
      return null;
    }

    const orderedListMatch = /^(\s*)(\d{1,9})([.)])\s+(?=\S)/.exec(line.text);

    if (!orderedListMatch) {
      return null;
    }

    const nextNumber = Number.parseInt(orderedListMatch[2], 10) + 1;
    return `${orderedListMatch[1]}${nextNumber}${orderedListMatch[3]} `;
  });

  if (nextPrefixes.some((prefix) => prefix === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const rangeIndex = view.state.selection.ranges.indexOf(range);
    const nextPrefix = nextPrefixes[rangeIndex] ?? '';

    return {
      changes: {
        from: range.head,
        insert: `\n${nextPrefix}`
      },
      range: EditorSelection.cursor(range.head + 1 + nextPrefix.length)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });

  return true;
}

/**
 * 计算 Markdown 前导空白的视觉列数，让空格与制表符可用于层级比较。
 */
function measureMarkdownIndent(indent: string): number {
  return Array.from(indent).reduce(
    (columns, character) => columns + (character === '\t' ? 4 : 1),
    0
  );
}

/**
 * 从当前空标记行向上查找最近的更浅层列表，并生成应恢复的父级前缀。
 */
function resolveParentListPrefix(
  state: EditorState,
  lineNumber: number,
  currentIndent: number
): string {
  for (let previousLineNumber = lineNumber - 1; previousLineNumber >= 1; previousLineNumber -= 1) {
    const previousLine = state.doc.line(previousLineNumber);

    if (previousLine.text.trim().length === 0) {
      continue;
    }

    const orderedMatch = /^(\s*)(\d{1,9})([.)])\s+\S/.exec(previousLine.text);
    const unorderedMatch = /^(\s*)([-+*])\s+\S/.exec(previousLine.text);
    const leadingWhitespace = /^\s*/.exec(previousLine.text)?.[0] ?? '';
    const previousIndent = measureMarkdownIndent(leadingWhitespace);

    if (previousIndent >= currentIndent) {
      continue;
    }

    if (orderedMatch) {
      const nextNumber = Number.parseInt(orderedMatch[2], 10) + 1;
      return `${orderedMatch[1]}${nextNumber}${orderedMatch[3]} `;
    }

    if (unorderedMatch) {
      return `${unorderedMatch[1]}${unorderedMatch[2]} `;
    }

    return '';
  }

  return '';
}

/**
 * 在空引用或空列表项回车时，按缩进逐级恢复父列表，最外层才退出到普通段落。
 */
function exitEmptyMarkdownLevel(view: EditorView): boolean {
  const replacements = view.state.selection.ranges.map((range) => {
    if (!range.empty) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);

    if (range.head !== line.to) {
      return null;
    }

    // 围栏内的空任务或空列表标记属于代码内容，交给普通换行处理。
    for (let node = syntaxTree(view.state).resolveInner(range.head, -1); node; ) {
      if (node.name === 'FencedCode') return null;
      if (!node.parent) break;
      node = node.parent;
    }
    const emptyMarkupMatch = /^(\s*)(?:(?:>\s*)+|(?:[-+*]|\d{1,9}[.)])\s+\[[ xX]\]\s*|[-+*]\s*|\d{1,9}[.)]\s*)$/.exec(line.text);

    if (!emptyMarkupMatch) {
      return null;
    }

    return resolveParentListPrefix(
      view.state,
      line.number,
      measureMarkdownIndent(emptyMarkupMatch[1])
    );
  });

  if (replacements.some((replacement) => replacement === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const rangeIndex = view.state.selection.ranges.indexOf(range);
    const line = view.state.doc.lineAt(range.head);
    const replacement = replacements[rangeIndex] ?? '';

    return {
      changes: {
        from: line.from,
        to: line.to,
        insert: replacement
      },
      range: EditorSelection.cursor(line.from + replacement.length)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });

  return true;
}

/**
 * 在引用内的无序列表回车时退出引用，并续写为独立无序列表项。
 */
function continueBlockquoteListAsStandaloneList(view: EditorView): boolean {
  const listPrefixes = view.state.selection.ranges.map((range) => {
    if (!range.empty) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);
    const quoteListMatch = /^(\s*)(?:>\s*)+([-+*])\s+(?=\S)/.exec(line.text);

    if (!quoteListMatch) {
      return null;
    }

    return `${quoteListMatch[1]}${quoteListMatch[2]} `;
  });

  if (listPrefixes.some((prefix) => prefix === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const rangeIndex = view.state.selection.ranges.indexOf(range);
    const listPrefix = listPrefixes[rangeIndex] ?? '';

    return {
      changes: {
        from: range.head,
        insert: `\n${listPrefix}`
      },
      range: EditorSelection.cursor(range.head + 1 + listPrefix.length)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });

  return true;
}

/** 在无序列表的普通 `>` 文本后回车时继续相同格式的列表项。 */
function continueUnorderedListWithPlainQuote(view: EditorView): boolean {
  const listPrefixes = view.state.selection.ranges.map((range) => {
    if (!range.empty) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);

    if (range.head !== line.to) {
      return null;
    }

    const listMatch = /^(\s*)([-+*])\s+>\s+(?=\S)/.exec(line.text);
    return listMatch ? `${listMatch[1]}${listMatch[2]} > ` : null;
  });

  if (listPrefixes.some((prefix) => prefix === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const rangeIndex = view.state.selection.ranges.indexOf(range);
    const listPrefix = listPrefixes[rangeIndex] ?? '';

    return {
      changes: {
        from: range.head,
        insert: `\n${listPrefix}`
      },
      range: EditorSelection.cursor(range.head + 1 + listPrefix.length)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });

  return true;
}

/** 在无序列表的普通列表符号文本后回车时继续外层真实列表。 */
function continueUnorderedListWithPlainMarker(view: EditorView): boolean {
  const listPrefixes = view.state.selection.ranges.map((range) => {
    if (!range.empty) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);

    if (range.head !== line.to) {
      return null;
    }

    const listMatch = /^(\s*)([-+*])\s+(?:[-+*]|\d{1,9}[.)])(?:\s+.*)?$/.exec(line.text);
    return listMatch ? `${listMatch[1]}${listMatch[2]} ` : null;
  });

  if (listPrefixes.some((prefix) => prefix === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const rangeIndex = view.state.selection.ranges.indexOf(range);
    const listPrefix = listPrefixes[rangeIndex] ?? '';

    return {
      changes: {
        from: range.head,
        insert: `\n${listPrefix}`
      },
      range: EditorSelection.cursor(range.head + 1 + listPrefix.length)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });

  return true;
}

function getLeadingIndentColumns(value: string, tabSize: number): number {
  let columns = 0;

  for (const character of value) {
    if (character === ' ' || character === '\u00a0') {
      columns += 1;
    } else if (character === '\t') {
      columns += tabSize - (columns % tabSize);
    }
  }

  return columns;
}

interface IndentDeletion {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

const MARKDOWN_LINE_CONTENT_PREFIX = /^[ \t\u00a0]*(?:(?:[-+*]|\d{1,9}[.)]|>)[ \t\u00a0]+)+/;

function isLineContentStart(lineText: string, lineFrom: number, position: number): boolean {
  const leading = /^[ \t\u00a0]*/.exec(lineText)?.[0] ?? '';
  if (position === lineFrom + leading.length) {
    return true;
  }

  const markupPrefix = MARKDOWN_LINE_CONTENT_PREFIX.exec(lineText)?.[0];
  return markupPrefix !== undefined && position === lineFrom + markupPrefix.length;
}

/** 光标在正文前时，仅删除行首末尾的一个四列缩进单元。 */
function deleteSingleIndentBackward(view: EditorView): boolean {
  const tabSize = Math.max(1, view.state.tabSize);
  const deletionRanges = view.state.selection.ranges.map((range): IndentDeletion | null => {
    if (!range.empty) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);
    const leading = /^[ \t\u00a0]*/.exec(line.text)?.[0] ?? '';
    const contentStart = line.from + leading.length;
    if (leading.length === 0 || !isLineContentStart(line.text, line.from, range.head)) {
      return null;
    }

    const columns = getLeadingIndentColumns(leading, tabSize);
    if (columns < INDENTATION_COLUMNS) {
      return null;
    }

    const targetColumns = columns - INDENTATION_COLUMNS;
    let currentColumns = 0;

    for (let index = 0; index < leading.length; index += 1) {
      const character = leading[index];
      const width = character === '\t'
        ? tabSize - (currentColumns % tabSize)
        : 1;
      const nextColumns = currentColumns + width;

      if (nextColumns === targetColumns) {
        return {
          from: line.from + index + 1,
          to: contentStart,
          insert: ''
        };
      }

      if (currentColumns === targetColumns) {
        return {
          from: line.from + index,
          to: contentStart,
          insert: ''
        };
      }

      if (currentColumns < targetColumns && targetColumns < nextColumns) {
        return {
          from: line.from + index,
          to: contentStart,
          insert: ' '.repeat(targetColumns - currentColumns)
        };
      }

      currentColumns = nextColumns;
    }

    return null;
  });

  if (deletionRanges.some((range) => range === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const rangeIndex = view.state.selection.ranges.indexOf(range);
    const deletionRange = deletionRanges[rangeIndex];
    if (!deletionRange) {
      return { range };
    }

    const insertedLength = deletionRange.insert.length;
    const deletedLength = deletionRange.to - deletionRange.from;
    return {
      changes: deletionRange,
      range: EditorSelection.cursor(range.head - deletedLength + insertedLength)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'delete.backward'
  });

  return true;
}

/** 将列表同行的第二个普通数字序号按单个字符退格删除。 */
function deletePlainNestedOrderedMarkerBackward(view: EditorView): boolean {
  const deletionRanges = view.state.selection.ranges.map((range) => {
    if (!range.empty) {
      return null;
    }

    const line = view.state.doc.lineAt(range.head);
    const markerMatch = /^((?:\s*[-+*]|\s*\d{1,9}[.)])\s+)(\d{1,9}[.)]\s*)/.exec(line.text);

    if (!markerMatch) {
      return null;
    }

    const markerFrom = line.from + markerMatch[1].length;
    const markerTo = markerFrom + markerMatch[2].length;

    return range.head > markerFrom && range.head <= markerTo
      ? { from: range.head - 1, to: range.head }
      : null;
  });

  if (deletionRanges.some((range) => range === null)) {
    return false;
  }

  const transaction = view.state.changeByRange((range) => {
    const rangeIndex = view.state.selection.ranges.indexOf(range);
    const deletionRange = deletionRanges[rangeIndex];

    if (!deletionRange) {
      return { range };
    }

    return {
      changes: deletionRange,
      range: EditorSelection.cursor(deletionRange.from)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'delete.backward'
  });

  return true;
}

/**
 * 合并上下文菜单项与 Vuetify activator 属性。
 */
function buildContextMenuActivatorProps(activatorProps: Record<string, unknown>): Record<string, unknown> {
  return {
    ...editorContextMenuItemProps,
    ...activatorProps
  };
}

/**
 * 将渲染态行内语法内容末尾的位置解析为隐藏结束标记之后的位置。
 */
function resolveRenderedInlineMarkEnd(view: EditorView, position: number): number | null {
  const line = view.state.doc.lineAt(position);

  if (isSelectionOnDocumentLine(view, line.from)) {
    return null;
  }

  const renderedLink = collectMarkdownInlineLinkRanges(view.state.doc.toString()).find((link) => (
    position >= link.labelFrom && position <= link.labelTo
  ));

  if (renderedLink) {
    return renderedLink.to;
  }

  let resolvedEnd: number | null = null;

  syntaxTree(view.state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (
        node.type.name !== 'StrongEmphasis'
        && node.type.name !== 'Emphasis'
        && node.type.name !== 'Strikethrough'
        && node.type.name !== 'Highlight'
        && node.type.name !== 'InlineCode'
      ) {
        return;
      }

      const closingMark = node.node.lastChild;

      if (closingMark && position === closingMark.from) {
        resolvedEnd = closingMark.to;
        return false;
      }
    }
  });

  return resolvedEnd;
}

/**
 * 修正首次点击渲染态行内语法末尾时的光标位置。
 */
const markdownInlineMarkMouseSelectionExtension = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) {
      return false;
    }

    const position = view.posAtCoords({
      x: event.clientX,
      y: event.clientY
    });

    if (position === null) {
      return false;
    }

    const resolvedEnd = resolveRenderedInlineMarkEnd(view, position);

    if (resolvedEnd === null) {
      return false;
    }

    event.preventDefault();
    view.dispatch({
      selection: EditorSelection.cursor(resolvedEnd),
      scrollIntoView: true
    });
    view.focus();
    return true;
  }
});

/** 将当前位置的 Markdown 行内链接解析为受限的 HTTP(S) 地址。 */
function resolveExternalLinkAtPosition(view: EditorView, position: number): string | null {
  const link = collectMarkdownInlineLinkRanges(view.state.doc.toString()).find((candidate) => (
    position >= candidate.labelFrom && position < candidate.labelTo
  ));

  if (!link) {
    return null;
  }

  const isEditing = view.state.selection.ranges.some((range) => (
    range.from <= link.to && range.to >= link.from
  ));

  if (isEditing) {
    return null;
  }

  const destination = view.state.doc
    .sliceString(link.destinationFrom, link.destinationTo)
    .trim();

  try {
    const url = new URL(destination);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** 在编辑态单击外部 Markdown 链接时交给工作台网页视图路由。 */
let pendingExternalLinkUrl: string | null = null;
const markdownExternalLinkMouseExtension = EditorView.domEventHandlers({
  mousedown(event, view) {
    pendingExternalLinkUrl = null;

    if (event.button !== 0) {
      return false;
    }

    const position = view.posAtCoords({
      x: event.clientX,
      y: event.clientY
    });

    if (position === null) {
      return false;
    }

    const url = resolveExternalLinkAtPosition(view, position);

    if (!url) {
      return false;
    }

    event.preventDefault();
    pendingExternalLinkUrl = url;
    return true;
  },
  click(event) {
    const url = pendingExternalLinkUrl;
    pendingExternalLinkUrl = null;

    if (event.button !== 0 || !url) {
      return false;
    }

    event.preventDefault();
    emit('open-external-link', url);
    return true;
  }
});

/** 判断引用标记前是否存在同一物理行的列表标记。 */
function isQuoteMarkAfterListMarkerOnSameLine(
  state: EditorState,
  node: SyntaxNode
): boolean {
  const quoteLineFrom = state.doc.lineAt(node.from).from;
  let ancestor: SyntaxNode | null = node.parent;

  while (ancestor) {
    if (ancestor.name === 'ListItem') {
      const listMark = ancestor.firstChild;

      if (
        listMark?.name === 'ListMark'
        && state.doc.lineAt(listMark.from).from === quoteLineFrom
      ) {
        return true;
      }
    }

    ancestor = ancestor.parent;
  }

  return false;
}

/**
 * 为当前可见区域构建 Markdown 列表标记与分割线装饰。
 */
function buildMarkdownSyntaxDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // 统一收集并排序装饰，避免行首装饰回写时破坏 RangeSet 的位置顺序。
  const builder = {
    /** 收集一个尚未排序的装饰范围。 */
    add(from: number, to: number, decoration: Decoration): void {
      ranges.push(decoration.range(from, to));
    },
    /** 按文档位置排序并生成最终装饰集合。 */
    finish(): DecorationSet {
      return Decoration.set(ranges, true);
    }
  };
  const decoratedQuoteLines = new Set<number>();
  const decoratedUnorderedListLines = new Set<number>();
  // 限制初始化同步解析时间，避免大文档阻塞编辑器首屏绘制。
  const parsedTree = ensureSyntaxTree(view.state, view.state.doc.length, 80) ?? syntaxTree(view.state);

  /** 为单个引用行添加背景、行首竖线与块起始间距。 */
  const decorateQuoteLine = (
    lineFrom: number,
    lineNumber: number,
    isEditing: boolean
  ): void => {
    if (decoratedQuoteLines.has(lineFrom)) {
      return;
    }

    const isQuoteBlockStart = lineNumber === 1
      || !/^\s*>/.test(view.state.doc.line(lineNumber - 1).text);
    const quoteLine = view.state.doc.line(lineNumber);
    const quoteIndentLength = getMarkdownQuoteIndentLength(quoteLine.text);
    const quotePrefix = /^(?:>[\t ]*)+/.exec(quoteLine.text.slice(quoteIndentLength))?.[0] ?? '';
    const markerColumns = quotePrefix.match(/>/g)?.length ?? 0;
    const spaceColumns = countColumn(quotePrefix, view.state.tabSize) - markerColumns;
    // 两种状态共享正文宽度，隐藏标记后仍保留实际字宽，避免切换改变换行与右侧留白。
    const spaceOffset = spaceColumns > 0
      ? `calc(${spaceColumns} * var(--workbench-editor-space-width, 1ch))`
      : '0px';
    const bodyOffset = markerColumns > 0
      ? `calc(${markerColumns} * var(--workbench-editor-quote-marker-width, 1ch) + ${spaceOffset})`
      : spaceOffset;
    const prefixOffset = isEditing ? bodyOffset : spaceOffset;

    decoratedQuoteLines.add(lineFrom);
    // 两种状态都折叠标记前的源码缩进，正文随标记一起回到行首。
    if (quoteIndentLength > 0) {
      builder.add(lineFrom, lineFrom + quoteIndentLength, Decoration.mark({
        class: 'cm-markdown-quote-leading-indent'
      }));
    }

    builder.add(lineFrom, lineFrom, Decoration.line({
      attributes: {
        class: createEditorBlockClassName([
          'cm-markdown-quote-line',
          ...(isEditing ? [] : ['cm-markdown-quote-line--rendered'])
        ], isQuoteBlockStart),
        // 引用标记前的缩进属于源码内容，竖线始终固定在编辑行行首。
        style: `--workbench-editor-quote-inline-offset: 0ch; --workbench-editor-quote-body-offset: ${bodyOffset}; --workbench-editor-quote-prefix-offset: ${prefixOffset}`
      }
    }));
  };

  view.visibleRanges.forEach((range) => {
    parsedTree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.type.name === 'Image') {
          const imageLine = view.state.doc.lineAt(node.from);
          const imageSource = view.state.sliceDoc(node.from, node.to);

          if (imageLine.text.trim() === imageSource) {
            builder.add(node.from, node.to, Decoration.mark({
              class: 'cm-markdown-image-source'
            }));
          }

          return;
        }

        if (node.type.name === 'URL' && node.node.parent?.name === 'Image') {
          const imageNode = node.node.parent;
          const imageLine = view.state.doc.lineAt(imageNode.from);
          const imageSource = view.state.sliceDoc(imageNode.from, imageNode.to);

          if (imageLine.text.trim() === imageSource) {
            builder.add(node.from, node.to, Decoration.mark({
              class: 'cm-markdown-image-url'
            }));
          }

          return false;
        }

        if (node.type.name === 'EmptyInlineCode') {
          const line = view.state.doc.lineAt(node.from);

          if (isEditorCodeBlockFenceLine(line.text)) {
            return false;
          }

          builder.add(node.from, node.to, Decoration.mark({
            class: 'cm-markdown-empty-inline-code'
          }));
          return false;
        }

        if (node.type.name === 'QuoteMark') {
          if (isQuoteMarkAfterListMarkerOnSameLine(view.state, node.node)) {
            builder.add(node.from, node.to, Decoration.mark({
              class: 'cm-markdown-quote-source'
            }));
            return;
          }

          const quoteLine = view.state.doc.lineAt(node.from);
          const lineFrom = quoteLine.from;
          const isEditing = isSelectionOnDocumentLine(view, lineFrom);
          decorateQuoteLine(lineFrom, quoteLine.number, isEditing);

          builder.add(node.from, node.to, Decoration.mark({
            class: isEditing
              ? 'cm-markdown-quote-source'
              : 'cm-markdown-quote-source cm-markdown-quote-source--rendered'
          }));

          return;
        }

        if (node.type.name === 'HorizontalRule') {
          const horizontalRuleSource = view.state.sliceDoc(node.from, node.to).trim();

          if (horizontalRuleSource !== '---') {
            return;
          }

          const lineFrom = view.state.doc.lineAt(node.from).from;
          const isRangeSelected = view.state.selection.ranges.some((range) => (
            !range.empty && range.from < node.to && range.to > node.from
          ));
          const isEditing = isSelectionOnDocumentLine(view, lineFrom) || isRangeSelected;

          if (!isEditing) {
            builder.add(lineFrom, lineFrom, Decoration.line({
              attributes: {
                class: 'cm-markdown-horizontal-rule'
              }
            }));
          }

          builder.add(node.from, node.to, Decoration.mark({
            class: isEditing
              ? 'cm-markdown-horizontal-rule-source'
              : 'cm-markdown-horizontal-rule-source cm-markdown-horizontal-rule-source--hidden'
          }));

          return;
        }

        const listItem = node.node.parent;
        const list = listItem?.parent;

        if (node.type.name !== 'ListMark' || listItem?.name !== 'ListItem') {
          return;
        }

        const markerLine = view.state.doc.lineAt(node.from);
        const characterAfterMarker = view.state.sliceDoc(node.to, Math.min(node.to + 1, markerLine.to));

        if (!/^\s$/.test(characterAfterMarker)) {
          return;
        }

        const unorderedPrefixMatch = /^(\s*)[-+*]\s+\d{1,9}[.)]\s+/.exec(markerLine.text);
        const orderedPrefixMatch = /^(\s*\d{1,9}[.)]\s+)\d{1,9}[.)]\s+/.exec(markerLine.text);
        const isPlainOrderedMarkerAfterList = list?.name === 'OrderedList'
          && (
            unorderedPrefixMatch !== null
            || (
              orderedPrefixMatch !== null
              && node.from >= markerLine.from + orderedPrefixMatch[1].length
            )
          );

        if (isPlainOrderedMarkerAfterList) {
          builder.add(node.from, node.to, Decoration.mark({
            class: 'cm-markdown-plain-list-marker'
          }));
          return;
        }

        if (list?.name === 'BulletList') {
          const markerSource = view.state.sliceDoc(node.from, node.to);
          const isHyphenListInBlockquote = markerSource === '-' && list.parent?.name === 'Blockquote';
          const isTaskList = MARKDOWN_TASK_LIST_PATTERN.test(markerLine.text);
          const orderedPrefixMatch = /^(\s*\d{1,9}[.)])\s+/.exec(markerLine.text);
          const isPlainMarkerAfterOrderedList = orderedPrefixMatch !== null
            && node.from > markerLine.from + orderedPrefixMatch[0].length - 1;

          if (isPlainMarkerAfterOrderedList) {
            builder.add(node.from, node.to, Decoration.mark({
              class: 'cm-markdown-plain-list-marker'
            }));
            return;
          }

          if (decoratedUnorderedListLines.has(markerLine.from)) {
            builder.add(node.from, node.to, Decoration.mark({
              class: 'cm-markdown-plain-list-marker'
            }));
            return;
          }

          decoratedUnorderedListLines.add(markerLine.from);

          if (isTaskList) {
            // 任务列表扩展统一处理标记隐藏，兼容语法树未识别的深缩进行。
            return;
          }

          if (isHyphenListInBlockquote) {
            return;
          }

          builder.add(node.from, node.to, Decoration.mark({
            class: 'cm-markdown-unordered-list-marker'
          }));
        }
      }
    });

    let fallbackPosition = range.from;

    while (fallbackPosition <= range.to) {
      const line = view.state.doc.lineAt(fallbackPosition);
      const quoteMatch = /^(\s*)((?:>\s*)+)/.exec(line.text);

      if (
        quoteMatch
        && !decoratedQuoteLines.has(line.from)
        && !isEditorCodeBlockLine(view.state, line.number)
      ) {
        const quoteFrom = line.from + quoteMatch[1].length;
        const quoteTo = quoteFrom + quoteMatch[2].length;
        const isEditing = isSelectionOnDocumentLine(view, line.from);

        decorateQuoteLine(line.from, line.number, isEditing);
        // 只装饰 > 本身；标记后的空格属于用户正文间距，保留其宽度。
        for (let markerFrom = quoteFrom; markerFrom < quoteTo; markerFrom += 1) {
          if (view.state.sliceDoc(markerFrom, markerFrom + 1) !== '>') {
            continue;
          }

          builder.add(markerFrom, markerFrom + 1, Decoration.mark({
            class: isEditing
              ? 'cm-markdown-quote-source'
              : 'cm-markdown-quote-source cm-markdown-quote-source--rendered'
          }));
        }
      }

      if (line.to >= range.to) {
        break;
      }

      fallbackPosition = line.to + 1;
    }
  });

  return builder.finish();
}

/**
 * 监听文档、选择与视口变化并刷新 Markdown 语法装饰。
 */
const markdownSyntaxDecorationsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    /**
     * 根据当前可见区域初始化 Markdown 语法装饰。
     */
    constructor(view: EditorView) {
      this.decorations = buildMarkdownSyntaxDecorations(view);
    }

    /**
     * 在文档、选择、焦点或视口变化时刷新 Markdown 语法装饰。
     */
    update(update: ViewUpdate): void {
      if (
        update.docChanged
        || update.selectionSet
        || update.focusChanged
        || update.viewportChanged
      ) {
        this.decorations = buildMarkdownSyntaxDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations
  }
);

/** 同步主编辑器是否存在非空选区，供活动行视觉状态使用。 */
class EditorSelectionVisualState {
  /** 初始化选区视觉状态。 */
  public constructor(private readonly view: EditorView) {
    this.sync();
  }

  /** 选区变化时更新编辑器状态类。 */
  public update(update: ViewUpdate): void {
    if (update.selectionSet) {
      this.sync();
    }
  }

  /** 销毁扩展时移除选区状态类。 */
  public destroy(): void {
    this.view.dom.classList.remove('cm-editor-has-selection');
  }

  /** 根据当前所有选区同步非空选区状态。 */
  private sync(): void {
    const hasNonEmptySelection = this.view.state.selection.ranges.some((range) => !range.empty);
    this.view.dom.classList.toggle('cm-editor-has-selection', hasNonEmptySelection);
  }
}

/** 暴露主编辑器非空选区视觉状态。 */
const editorSelectionVisualStateExtension = ViewPlugin.fromClass(EditorSelectionVisualState);

/**
 * 创建与当前主题外观一致的编辑器基础主题。 */
function createWorkbenchEditorTheme(isDark: boolean) {
  return EditorView.theme({
    '&': {
      height: '100%',
      color: 'var(--workbench-editor-text)',
      backgroundColor: 'var(--workbench-editor-background)'
    },
    '&.cm-focused': {
      outline: 'none'
    },
    '.cm-cursor': {
      width: 'var(--workbench-editor-cursor-width)',
      marginLeft: '0',
      borderLeft: 'none',
      backgroundColor: 'var(--workbench-editor-cursor)'
    },
    '.cm-scroller': {
      overflow: 'auto'
    },
    '.cm-content': {
      minHeight: '100%',
      padding: 'var(--workbench-editor-padding) 0',
      caretColor: 'transparent',
      paddingRight: 'var(--workbench-editor-content-padding-inline-end)',
      maxWidth: 'var(--workbench-editor-page-width)',
      marginInline: 'auto'
    },
    '.cm-line': {
      caretColor: 'transparent',
      padding:'0'
    },
    // 引用行按可见的引用前缀单独计算悬挂缩进。
    '.cm-markdown-hanging-line:not(.cm-markdown-quote-line)': {
      paddingInlineStart: 'var(--workbench-editor-line-content-offset)',
      textIndent: 'calc(var(--workbench-editor-line-content-offset) * -1)'
    },
    '.cm-markdown-unordered-list-marker': {
      // 保持普通行内文本，让原生选区连续覆盖标记与后续空格。
      position: 'relative',
      color: 'transparent !important',
      textAlign: 'center',
      textIndent: '0'
    },
    '.cm-markdown-unordered-list-marker *': {
      color: 'transparent !important'
    },
    '.cm-markdown-ordered-list-marker-fallback': {
      color: 'var(--ws-editor-orderedListMarkerForeground) !important'
    },
    '.cm-markdown-plain-list-marker, .cm-markdown-plain-list-marker *': {
      color: 'var(--ws-editor-foreground) !important'
    },
    '.cm-markdown-unordered-list-marker::before': {
      position: 'absolute',
      insetInlineStart: '0',
      width: '100%',
      color: 'var(--ws-editor-unorderedListMarkerForeground)',
      content: '"•"',
      fontSize: 'var(--workbench-editor-font-size)',
      pointerEvents: 'none'
    },
    '.cm-markdown-image-source, .cm-markdown-image-source *': {
      textDecorationLine: 'none !important'
    },
    '.cm-markdown-image-url, .cm-markdown-image-url *': {
      color: 'var(--ws-markdown-ImgForeground) !important',
      textDecorationLine: 'underline !important'
    },
    '.cm-markdown-image-url:hover, .cm-markdown-image-url:hover *': {
      color: 'var(--ws-markdown-ImgHoverForeground) !important'
    },
    '.cm-markdown-quote-line--rendered': {
      color: 'var(--ws-markdown-quoteTextForeground) !important',
      backgroundColor: 'var(--ws-markdown-quoteBackground)'
    },
    '.cm-markdown-quote-line': {
      paddingInlineStart: 'var(--workbench-editor-quote-body-offset)',
      paddingInlineEnd: 'var(--workbench-editor-quote-content-padding-inline)',
      textIndent: 'calc(var(--workbench-editor-quote-prefix-offset) * -1)',
      // 长数字和连续字母在当前行剩余空间断行，避免只留下引用标记。
      wordBreak: 'break-all',
      backgroundImage: 'linear-gradient(to right, transparent 0 var(--workbench-editor-quote-inline-offset), var(--ws-markdown-quoteForeground) var(--workbench-editor-quote-inline-offset) calc(var(--workbench-editor-quote-inline-offset) + var(--workbench-editor-quote-line-width)), var(--ws-markdown-quoteBackground) calc(var(--workbench-editor-quote-inline-offset) + var(--workbench-editor-quote-line-width)) 100%)'
    },
    '.cm-editor-block--start': {
      borderBlockStart: 'var(--workbench-editor-block-gap) solid transparent'
    },
    '.cm-editor-block--end': {
      borderBlockEnd: 'var(--workbench-editor-block-gap) solid transparent'
    },
    '.cm-editor-block--start, .cm-editor-block--end': {
      backgroundClip: 'padding-box'
    },
    '.cm-markdown-quote-source, .cm-markdown-quote-source *': {
      color: 'var(--ws-foreground) !important'
    },
    // 折叠字符同时清零行高，避免零字号行内盒撑大引用行。
    '.cm-markdown-quote-leading-indent, .cm-markdown-quote-source--rendered': {
      fontSize: '0',
      lineHeight: '0'
    },
    '.cm-markdown-quote-leading-indent': {
      whiteSpace: 'nowrap',
      tabSize: '0'
    },
    '.cm-markdown-quote-source--rendered': {
      color: 'transparent !important'
    },
    '.cm-markdown-quote-source--rendered *': {
      color: 'transparent !important'
    },
    '.cm-markdown-horizontal-rule': {
      position: 'relative'
    },
    '.cm-markdown-horizontal-rule-source, .cm-markdown-horizontal-rule-source *': {
      color: 'var(--ws-foreground) !important'
    },
    '.cm-markdown-horizontal-rule-source--hidden, .cm-markdown-horizontal-rule-source--hidden *': {
      color: 'transparent !important'
    },
    '.cm-markdown-horizontal-rule::before': {
      position: 'absolute',
      insetInline: '0',
      top: 'var(--workbench-editor-horizontal-rule-position)',
      borderTop: 'var(--workbench-editor-horizontal-rule-width) solid var(--ws-editor-horizontalRuleForeground)',
      content: '""',
      pointerEvents: 'none'
    },
    '.cm-markdown-empty-inline-code, .cm-markdown-empty-inline-code *': {
      paddingInline: 'var(--workbench-editor-inline-code-padding-x)',
      color: 'var(--ws-foreground) !important',
      backgroundColor: 'var(--ws-editor-inlineCodeBackground)',
      borderRadius: 'var(--workbench-editor-inline-code-radius)'
    },
    '.cm-lineNumbers': {
      fontSize: 'var(--workbench-editor-gutter-font-size)',
      color: 'var(--ws-editor-lineForeground)',
      backgroundColor: 'var(--ws-editor-background)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 var(--workbench-editor-line-number-gutter-padding-inline-end) 0 var(--workbench-editor-line-number-gutter-padding-inline-start)',
      lineHeight: 'var(--workbench-editor-line-height)'
    },
    '.cm-gutters': {
      border: 'none',
      color: 'var(--workbench-editor-gutter-text)',
      backgroundColor: 'var(--ws-editor-background)',
      insetInlineStart: 'var(--workbench-editor-gutter-inline-offset)'
    },
    '.cm-foldGutter .cm-gutterElement': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0'
    },
    '.cm-fold-marker': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 'var(--workbench-editor-fold-icon-size)',
      height: 'var(--workbench-editor-fold-icon-size)',
      color: 'var(--workbench-editor-gutter-text)'
    },
    '.cm-fold-marker svg': {
      display: 'block',
      width: '100%',
      height: '100%'
    },
    '.cm-foldPlaceholder': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'transparent',
      border: 'none',
      borderRadius: '0',
      margin: '0',
      padding: '0',
      color: 'var(--workbench-editor-text)',
      verticalAlign: 'middle',
      pointerEvents: 'none'
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: 'var(--ws-editor-lineActiveForeground)'
    },
    '.cm-activeLine': {
      backgroundColor: 'transparent'
    },
    '.cm-activeLine::after': {
      content: '""',
      position: 'absolute',
      inset: '0',
      backgroundColor: 'var(--ws-editor-activeHighlightBackground)',
      pointerEvents: 'none',
      zIndex: '-2'
    },
    '&.cm-editor-has-selection > .cm-scroller > .cm-content > .cm-activeLine': {
      backgroundColor: 'transparent'
    },
    '&.cm-editor-has-selection > .cm-scroller > .cm-content > .cm-activeLine::after': {
      display: 'none'
    },
    '.cm-dropCursor': {
      borderLeft: '1.2px solid var(--workbench-editor-cursor)',
      marginLeft: '-0.6px',
      pointerEvents: 'none'
    },
    '.cm-panels, .cm-tooltip': {
      color: 'var(--workbench-editor-text)',
      backgroundColor: 'var(--workbench-editor-overlay-background)',
      borderColor: 'var(--workbench-editor-border)'
    }
  }, { dark: isDark });
}

/**
 * 组合当前主题外观下需要注入到编辑器的主题扩展。 */
function createEditorThemeExtensions() {
  return createWorkbenchEditorTheme(isDarkTheme.value);
}

/**
 * 在独立三反引号行后自动插入空行与匹配的 Markdown 闭合围栏。
 */
const markdownFenceAutoCloseExtension = EditorView.inputHandler.of((view, from, to, text) => {
  if (!view.state.selection.main.empty || text.toString() !== '`') {
    return false;
  }

  const line = view.state.doc.lineAt(from);
  const nextLineText = `${line.text.slice(0, from - line.from)}${text.toString()}${line.text.slice(to - line.from)}`;

  if (!/^\s*```$/.test(nextLineText) || from !== to || to !== line.to) {
    return false;
  }

  if (/^\s*```\s*$/m.test(view.state.doc.sliceString(line.to))) {
    return false;
  }

  const insertedText = `${text}\n` + '```';
  const cursorPosition = from + text.length;

  view.dispatch({
    changes: { from, to, insert: insertedText },
    selection: { anchor: cursorPosition }
  });
  return true;
});

/** 根据当前文件扩展名选择宿主编辑器的语法语言支持。 */
function createEditorLanguageExtension() {
  const extension = getWorkspaceFileExtension(props.filePath ?? '');

  return extension === '.json' || extension === '.jsonc'
    ? json()
    : markdown({
      addKeymap: false,
      codeLanguages: editorCodeBlockLanguages,
      htmlTagLanguage: editorHtmlLanguageSupport,
      extensions: [
        disableSetextHeadingExtension,
        emptyInlineCodeExtension,
        emptyTildeFenceExtension,
        Strikethrough,
        indentedOrderedListExtension,
        listItemHeadingExtension,
        markdownListMarkerHighlightExtension,
        orderedListContinuationExtension,
        editorTableMarkdownExtension,
        markdownHighlightExtension
      ]
    });
}

/**
 * 组合编辑器基础扩展，并使用 CodeMirror 官方选区层显示选区末端光标。
 */
const editorBaseExtensions = [
  lineNumbers(),
  drawSelection({ drawRangeCursor: true }),
  editorBlockCursorExtension,
  editorSelectionTheme,
  editorSpaceWidthExtension,
  editorSelectionVisualStateExtension,
  highlightActiveLine(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  indentationGuideCompartment.of(createIndentationGuideExtension('solid')),
  history(),
  editorFoldGutterExtension,
  dropCursor(),
  indentOnInput(),
  markdownFenceAutoCloseExtension,
  editorLanguageCompartment.of(createEditorLanguageExtension()),
  editorMediaDropExtension,
  editorMathBlockExtension,
  editorMermaidBlockExtension,
  bracketExpressionExtension,
  tagHighlightExtension,
  createEditorTableBlockExtension(() => props.filePath),
  notePropertiesBlockExtension,
  editorCodeBlockExtension,
  editorImageBlockExtension,
  editorAudioBlockExtension,
  editorVideoBlockExtension,
  createEditorInlineChatExtension({
    getWorkspaceFiles: () => props.workspaceFiles,
    getRecentFiles: () => props.recentWorkspaceFiles
  }),
  editorHtmlBlockExtension,
  editorHtmlSourceHighlightExtension,
  editorAdmonitionExtension,
  editorFootnoteCompletionExtension,
  editorSlashCommandCompletionExtension,
  editorWikiLinkCompletionExtension,
  createEditorWikiLinkBlockCompletionExtension({
    getCurrentFilePath: () => props.filePath,
    getWorkspaceFiles: () => props.workspaceMarkdownFiles,
    readWorkspaceFile: (filePath) => props.readWorkspaceFile?.(filePath) ?? Promise.resolve(undefined),
    persistTarget: props.persistWikiLinkTarget
  }),
  createEditorWikiLinkEmbedCompletionExtension({
    getWorkspaceFiles: () => props.workspaceMarkdownFiles,
    readWorkspaceFile: (filePath) => props.readWorkspaceFile?.(filePath) ?? Promise.resolve(undefined),
    onOpenFileInNewTab: (filePath) => emit('open-file-in-new-tab', filePath)
  }),
  editorMarkdownHeadingDecorationsExtension,
  editorMarkdownHeadingTheme,
  editorMarkdownDocumentTheme,
  markdownSyntaxDecorationsExtension,
  markdownInlineFormattingExtension,
  markdownInlineFormattingTheme,
  createMarkdownInlineLinkPreviewExtension({
    getCurrentFilePath: () => props.filePath,
    getWorkspaceFiles: () => props.workspaceMarkdownFiles,
    readWorkspaceFile: (filePath) => props.readWorkspaceFile?.(filePath) ?? Promise.resolve(undefined),
    onNavigateToFile: (target) => emit('navigate-markdown-link', target)
  }),
  markdownListMarkerFallbackExtension,
  taskListExtension,
  taskListThemeExtension,
  markdownExternalLinkMouseExtension,
  markdownInlineMarkMouseSelectionExtension,
  editorMarkdownHighlightStyle,
  syntaxHighlighting(editorCodeBlockHighlightStyle),
  syntaxHighlighting(editorHtmlHighlightStyle),
  bracketMatching(),
  closeBrackets(),
  autocompletion({
    // Keep completion panels unselected on open. CodeMirror scrolls the
    // selected item into view, which otherwise fights wheel/track scrolling.
    selectOnOpen: false,
    closeOnBlur: false,
    tooltipClass: (state) => {
      if (isEditorWikiLinkEmbedCompletionState(state)) {
        return 'cm-editor-wiki-link-embed-completion';
      }

      if (isEditorSlashCommandCompletionState(state)) {
        return 'cm-editor-slash-command-completion';
      }

      if (isEditorFootnoteCompletionState(state)) {
        return 'cm-editor-footnote-completion';
      }

      return isEditorWikiLinkBlockCompletionState(state)
        || isEditorWikiLinkHeadingCompletionState(state)
        ? 'cm-editor-wiki-link-completion'
        : '';
    }
  }),
  createSearchExtension({
    top: true,
    createPanel: createWsEditorlineSearchPanel
  }),
  highlightSelectionMatches(),
  Prec.highest(keymap.of([
    { key: 'Backspace', run: deleteSingleIndentBackward }
  ])),
  keymap.of([
    ...closeBracketsKeymap,
    { key: 'Enter', run: exitEmptyMarkdownLevel },
    { key: 'Enter', run: continueTaskListFromSource },
    { key: 'Enter', run: continueOrderedListFromSource },
    { key: 'Enter', run: continueUnorderedListWithPlainMarker },
    { key: 'Enter', run: continueUnorderedListWithPlainQuote },
    { key: 'Enter', run: continueBlockquoteListAsStandaloneList },
    { key: 'Enter', run: continueMarkdownMarkup },
    { key: 'Enter', run: continueQuoteFromSource },
    { key: 'Backspace', run: deletePlainNestedOrderedMarkerBackward },
    { key: 'Backspace', run: deleteMarkupBackward },
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap
  ])
];

/**
 * 创建编辑器状态，并将当前主题外观放入可动态重配置的 `compartment` 中。 */
function createEditorState(): EditorState {
  const initialSnapshot = parseNoteDocument(props.modelValue);
  const initialSelectionPosition = notePropertiesBlockVisible.value
    && !initialSnapshot.invalidFrontmatter
    ? initialSnapshot.bodyStart
    : 0;

  return EditorState.create({
    doc: props.modelValue,
    selection: EditorSelection.cursor(initialSelectionPosition),
    extensions: [
      editorBaseExtensions,
      editorThemeCompartment.of(createEditorThemeExtensions()),
      EditorView.lineWrapping,
      scrollPastEnd(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isDisposingEditor) {
          emit('update:modelValue', update.state.doc.toString());
        }

        if (!isDisposingEditor && (update.docChanged || update.selectionSet)) {
          const selection = update.state.selection.main;
          emit('selection-change', selection.from, selection.to);
        }
      })
    ]
  });
}

/** 将属性视图生成的完整 Markdown 作为最小 CodeMirror 事务写回。 */
function handleNotePropertiesDocumentUpdate(nextValue: string): void {
  const view = editorView.value;
  if (!view) {
    return;
  }

  const change = createEditorNotePropertiesDocumentChange(
    view.state.doc.toString(),
    nextValue
  );
  if (!change) {
    return;
  }

  view.dispatch({
    changes: change,
    userEvent: 'input'
  });
}

/** 将焦点从笔记属性块交还给 Frontmatter 后的正文起点。 */
function handleNotePropertiesExit(): void {
  const view = editorView.value;
  if (!view) {
    return;
  }

  const snapshot = parseNoteDocument(view.state.doc.toString());
  view.dispatch({
    selection: EditorSelection.cursor(snapshot.bodyStart),
    scrollIntoView: true,
    userEvent: 'select'
  });
  view.focus();
}

/** 将属性块隐藏请求转发给标签级布局状态。 */
function handleNotePropertiesHideRequest(): void {
  emit('toggle-note-properties', false);
}

/** 将日期笔记创建请求转发给工作台业务层。 */
function handleDateNoteCreation(date: string): void {
  emit('create-date-note', date);
}

/** 响应属性视图请求，确保块在创建临时属性行前处于展开状态。 */
function handleNotePropertiesExpandRequest(): void {
  editorView.value?.dispatch({
    effects: setEditorNotePropertiesBlockExpandedEffect.of(true)
  });
}

/**
 * 描述一次基于当前选区的文本替换结果以及替换后的高亮范围。 */
interface CodeMirrorSelectionReplacement {
  insert: string;
  selectionFrom: number;
  selectionTo: number;
}

/**
 * 将当前选区统一替换为指定内容，并同步恢复到期望的光标或选区范围。 */
function applySelectionReplacement(
  view: EditorView,
  buildReplacement: (selectedText: string) => CodeMirrorSelectionReplacement
): void {
  const transaction = view.state.changeByRange((range) => {
    const selectedText = view.state.sliceDoc(range.from, range.to);
    const replacement = buildReplacement(selectedText);

    return {
      changes: {
        from: range.from,
        to: range.to,
        insert: replacement.insert
      },
      range: EditorSelection.range(
        range.from + replacement.selectionFrom,
        range.from + replacement.selectionTo
      )
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });
  view.focus();
}

/**
 * 用 Markdown 包裹当前选区，适用于粗体、斜体等行内格式。 */
function wrapSelectionWithMarkdownSyntax(
  view: EditorView,
  prefix: string,
  suffix: string,
  placeholder: string
): void {
  applySelectionReplacement(view, (selectedText) => {
    const content = selectedText || placeholder;

    return {
      insert: `${prefix}${content}${suffix}`,
      selectionFrom: prefix.length,
      selectionTo: prefix.length + content.length
    };
  });
}

/**
 * 为当前选区插入 Markdown 链接，并优先高亮 URL 占位内容。 */
function insertMarkdownLink(view: EditorView, url: string): void {
  applySelectionReplacement(view, (selectedText) => {
    const content = selectedText || '链接文本';
    const insert = `[${content}](${url})`;
    const urlStart = content.length + 3;

    return {
      insert,
      selectionFrom: urlStart,
      selectionTo: urlStart + url.length
    };
  });
}

/**
 * 为当前选区插入带颜色的 HTML 包裹，兼容 Markdown 内嵌 HTML 写法。 */
function insertColorSpan(view: EditorView, color: string): void {
  applySelectionReplacement(view, (selectedText) => {
    const content = selectedText || '彩色文本';
    const prefix = `<span style="color: ${color};">`;
    const suffix = '</span>';

    return {
      insert: `${prefix}${content}${suffix}`,
      selectionFrom: prefix.length,
      selectionTo: prefix.length + content.length
    };
  });
}

/**
 * 移除单行已有的 Markdown 段落前缀，保留正文内容。
 */
function stripMarkdownParagraphPrefix(lineText: string): string {
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lineText)) {
    return '';
  }

  return lineText.replace(
    /^\s*(?:#{1,6}\s+|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s?)/,
    ''
  );
}

/**
 * 将当前选中行转换为指定 Markdown 段落格式，避免重复叠加块级前缀。
 */
function formatSelectedParagraphs(
  view: EditorView,
  buildLine: (content: string, lineIndex: number) => string
): void {
  const transaction = view.state.changeByRange((range) => {
    const firstLine = view.state.doc.lineAt(range.from);
    const lastLine = view.state.doc.lineAt(range.to);
    const nextLines: string[] = [];

    for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      const content = stripMarkdownParagraphPrefix(line.text);
      nextLines.push(buildLine(content, lineNumber - firstLine.number));
    }

    const insert = nextLines.join('\n');

    return {
      changes: {
        from: firstLine.from,
        to: lastLine.to,
        insert
      },
      range: EditorSelection.cursor(firstLine.from + insert.length)
    };
  });

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'input'
  });
  view.focus();
}

/**
 * 插入 Markdown 代码块，优先保留当前选中的文本作为代码内容。 */
function insertCodeBlock(view: EditorView): void {
  applySelectionReplacement(view, (selectedText) => {
    const content = selectedText || '代码内容';
    const prefix = '```text\n';
    const suffix = '\n```';

    return {
      insert: `${prefix}${content}${suffix}`,
      selectionFrom: prefix.length + content.length,
      selectionTo: prefix.length + content.length
    };
  });
}

/** 插入 GitHub 风格消息框，并保留当前选区作为内容。 */
function insertAdmonition(view: EditorView, type: 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION', title: string): void {
  applySelectionReplacement(view, (selectedText) => {
    const content = selectedText || title;
    const prefix = `> [!${type}] ${title}\n> `;
    const insert = `${prefix}${content.replace(/\n/g, '\n> ')}\n`;
    const sourceEnd = insert.length - 1;
    return {
      insert,
      selectionFrom: sourceEnd,
      selectionTo: sourceEnd
    };
  });
}

/**
 * 获取当前编辑器内所有选区拼接后的文本，用于复制与剪切。 */
function getJoinedSelectionText(view: EditorView): string {
  return view.state.selection.ranges.map((range) => (
    view.state.sliceDoc(range.from, range.to)
  )).join('\n');
}

/**
 * 判断当前编辑器是否存在至少一个非空选区。 */
function hasSelection(view: EditorView | undefined): boolean {
  return Boolean(view?.state.selection.ranges.some((range) => !range.empty));
}

/**
 * 剪切当前所有选区中的文本内容。 */
function cutSelectedText(view: EditorView): void {
  const transaction = view.state.changeByRange((range) => ({
    changes: {
      from: range.from,
      to: range.to,
      insert: ''
    },
    range: EditorSelection.cursor(range.from)
  }));

  view.dispatch({
    ...transaction,
    scrollIntoView: true,
    userEvent: 'delete.cut'
  });
  view.focus();
}

/**
 * 尝试通过原生剪贴板 API 写入文本。 */
async function writeClipboardText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试通过原生剪贴板 API 读取文本。 */
async function readClipboardText(): Promise<string | null> {
  if (!navigator.clipboard?.readText) {
    return null;
  }

  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/**
 * 在剪贴板 API 不可用时回退到浏览器命令，保留基础可用性。 */
function tryExecuteDocumentCommand(command: 'copy' | 'cut' | 'paste'): boolean {
  editorView.value?.focus();

  try {
    return document.execCommand(command);
  } catch {
    return false;
  }
}

/**
 * 用纯文本替换当前选区，适配粘贴场景。 */
function insertPlainText(view: EditorView, text: string): void {
  applySelectionReplacement(view, () => ({
    insert: text,
    selectionFrom: text.length,
    selectionTo: text.length
  }));
}

/**
 * 基于文件名生成本地媒体插入时的默认文案。 */
function buildMediaLabel(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || '媒体';
}

/**
 * 为当前选区插入本地媒体 Markdown 或 HTML 占位引用。 */
function insertLocalMediaReference(
  view: EditorView,
  file: File
): void {
  const fileName = file.name;
  const fileReference = `./${fileName}`;

  applySelectionReplacement(view, (selectedText) => {
    const content = selectedText || buildMediaLabel(fileName);

    if (file.type.startsWith('image/')) {
      const insert = `![${content}](${fileReference})`;
      const altStart = 2;

      return {
        insert,
        selectionFrom: altStart,
        selectionTo: altStart + content.length
      };
    }

    if (file.type.startsWith('video/')) {
      const prefix = `<video controls src="${fileReference}">`;
      const suffix = '</video>';

      return {
        insert: `${prefix}${content}${suffix}`,
        selectionFrom: prefix.length,
        selectionTo: prefix.length + content.length
      };
    }

    if (file.type.startsWith('audio/')) {
      const prefix = `<audio controls src="${fileReference}">`;
      const suffix = '</audio>';

      return {
        insert: `${prefix}${content}${suffix}`,
        selectionFrom: prefix.length,
        selectionTo: prefix.length + content.length
      };
    }

    const insert = `[${content}](${fileReference})`;
    const labelStart = 1;

    return {
      insert,
      selectionFrom: labelStart,
      selectionTo: labelStart + content.length
    };
  });
}

/**
 * 关闭编辑器右键菜单。 */
function closeEditorContextMenu(): void {
  activeContextSubmenuId.value = null;
  isContextMenuVisible.value = false;
  contextMenuCellEditorView = null;
  closeTableColumnContextMenu();
}

/** 关闭图片块右键菜单。 */
function closeImageContextMenu(): void {
  isImageContextMenuVisible.value = false;
  tableImageMenuTarget.value = null;
  activeContextSubmenuId.value = null;
}

/** 使用当前附件的保存值标记布局菜单，兼容尚未保存布局的旧图片。 */
function isTableImageLayoutActionSelected(action: string): boolean {
  const image = tableImageMenuTarget.value?.image;
  const layout = resolveTableCellImageLayoutAction(action);
  if (!image || !layout) return false;
  return layout.alignment !== undefined
    ? (image.alignment ?? 'center') === layout.alignment
    : (image.position ?? 'left') === layout.position;
}

/** 菜单或尺寸窗口仅对打开时的文档生效。 */
function isTableImageTargetCurrent(target: TableImageMenuTarget): boolean {
  return editorView.value === target.view && props.filePath === target.filePath
    && target.view.state.doc.eq(target.document);
}

/** 本地附件复用渲染时的相对路径基准，协议图片不传入文件系统接口。 */
function resolveTableImageFilePath(target: TableImageMenuTarget): string | undefined {
  const source = target.image.source.trim();
  if (!isWindowsLocalMediaPath(source) && (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//'))) {
    return undefined;
  }
  return resolveRelativeMediaPath(source, target.filePath);
}

/** 只读图片仍可在系统中打开；未加载尺寸或非本地图片禁用相应操作。 */
function isTableImageActionDisabled(action: string): boolean {
  const target = tableImageMenuTarget.value;
  if (!target) return false;
  if (action === 'preview-image') return true;
  if (action === 'replace-image') return target.view.state.readOnly || !target.filePath;
  if (action === 'open-with-default-app' || action === 'show-in-explorer') {
    return !resolveTableImageFilePath(target);
  }
  return target.view.state.readOnly || (action === 'image-size' && !(target.width > 0 && target.height > 0));
}

/** 按右键命中的附件执行图片变换或宿主文件操作。 */
async function handleImageContextAction(action: string): Promise<void> {
  const target = tableImageMenuTarget.value;
  if (!target || isTableImageActionDisabled(action) || !isTableImageTargetCurrent(target)) return;
  closeImageContextMenu();
  if (action === 'replace-image') {
    await replaceTableCellImage(target);
    return;
  }
  if (action === 'image-size') {
    tableImageSizeTarget.value = target;
    tableImageWidth.value = target.width;
    tableImageHeight.value = target.height;
    isTableImageSizeVisible.value = true;
    return;
  }
  if (action === 'open-with-default-app' || action === 'show-in-explorer') {
    const path = resolveTableImageFilePath(target);
    if (!path) return;
    try {
      const opened = await (action === 'open-with-default-app'
        ? workspaceApi.openWithSystem(path) : workspaceApi.revealInFileManager(path));
      if (!opened) imageNotificationStore.error('打开图片失败，请检查图片文件是否存在。');
    } catch (error: unknown) {
      console.error('打开图片失败', error);
      imageNotificationStore.error('打开图片失败，请检查图片文件是否存在。');
    }
    return;
  }
  const layout = resolveTableCellImageLayoutAction(action);
  if (layout) {
    updateEditorTableCellImage(target.view, target.cell, target.imageIndex, {
      ...target.image, ...resolveTableCellImageLayout({ ...target.image, ...layout })
    });
    return;
  }
  if (action !== 'delete-image' && action !== 'rotate-clockwise' && action !== 'rotate-counterclockwise') return;
  const image = action === 'delete-image' ? null : {
    ...target.image,
    rotation: ((target.image.rotation ?? 0) + (action === 'rotate-clockwise' ? 90 : 270)) % 360
  };
  updateEditorTableCellImage(target.view, target.cell, target.imageIndex, image);
}

/** 复用单元格图片导入通道，仅替换附件来源，保留尺寸、旋转和布局设置。 */
async function replaceTableCellImage(target: TableImageMenuTarget): Promise<void> {
  const filePath = target.filePath;
  const isCurrentTarget = (): boolean => isTableImageTargetCurrent(target) && !target.view.state.readOnly;
  if (!filePath || !isCurrentTarget()) return;
  try {
    const sourcePath = await pickLocalImageFile();
    if (!sourcePath || resolveWorkspaceFileKind(sourcePath) !== 'image' || !isCurrentTarget()) return;
    const result = await workspaceApi.importExternalMediaFile({ sourcePath, markdownFilePath: filePath });
    if (result.status !== 'copied' || typeof result.referencePath !== 'string'
      || !result.referencePath.trim() || !isCurrentTarget()) return;
    updateEditorTableCellImage(target.view, target.cell, target.imageIndex, {
      ...target.image, source: result.referencePath, title: result.title
    });
  } catch (error: unknown) {
    console.error('替换图片失败', error);
    imageNotificationStore.error('替换图片失败，请检查图片文件是否存在。');
  }
}

/** 在输入时同步修正超限数值与显示，包含当前已为上限时的再次输入。 */
function clampTableImageSizeInput(dimension: 'width' | 'height', event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !(input.valueAsNumber > TABLE_CELL_IMAGE_MAX_SIZE)) return;
  input.value = String(TABLE_CELL_IMAGE_MAX_SIZE);
  if (dimension === 'width') tableImageWidth.value = TABLE_CELL_IMAGE_MAX_SIZE;
  else tableImageHeight.value = TABLE_CELL_IMAGE_MAX_SIZE;
}

/** 保存图片原始方向的宽高，旋转后由布局交换占用尺寸。 */
function applyTableImageSize(): void {
  const target = tableImageSizeTarget.value;
  if (!target || !isTableImageSizeValid.value || !isTableImageTargetCurrent(target)) return;
  updateEditorTableCellImage(target.view, target.cell, target.imageIndex, {
    ...target.image, width: Number(tableImageWidth.value), height: Number(tableImageHeight.value)
  });
  isTableImageSizeVisible.value = false;
  tableImageSizeTarget.value = null;
}

/** 关闭表格行列拖拽手柄菜单，并清除对应框选。 */
function closeTableColumnContextMenu(): void {
  const view = editorView.value;
  const target = tableColumnContextTarget.value;
  if (view && target) {
    setTableContextHighlight(view, target, false);
  }
  isTableColumnContextMenuVisible.value = false;
  tableColumnContextTarget.value = null;
}

/** 关闭当前编辑器实例的全部上下文菜单。 */
function closeAllEditorContextMenus(): void {
  closeEditorContextMenu();
  closeImageContextMenu();
  isGutterContextMenuVisible.value = false;
  isGutterHeadingSubmenuVisible.value = false;
  isGutterIndentationSubmenuVisible.value = false;
  isGutterPageWidthSubmenuVisible.value = false;
}

/** 应用行号区域右键菜单动作。 */
function handleGutterContextAction(action: string): void {
  isGutterContextMenuVisible.value = false;
  if (action === 'hide-heading') hideInlineHeading.value = !hideInlineHeading.value;
  if (action === 'toggle-path-navigation') {
    emit('toggle-path-navigation', !props.pathNavigationVisible);
  }
  if (action === 'toggle-line-numbers') showLineNumbers.value = !showLineNumbers.value;
  if (action.startsWith('indentation-style-')) {
    const style = action.replace('indentation-style-', '');
    indentationGuideStyle.value = style as IndentationGuideStyle | 'none';
    isGutterIndentationSubmenuVisible.value = false;
    editorView.value?.dispatch({
      effects: indentationGuideCompartment.reconfigure(
        indentationGuideStyle.value === 'none'
          ? []
          : createIndentationGuideExtension(indentationGuideStyle.value)
      )
    });
  }
  if (action.startsWith('heading-align-')) {
    headingAlignment.value = action.replace('heading-align-', '') as typeof headingAlignment.value;
  }
  if (action.startsWith('page-width-')) {
    editorPageWidth.value = Number(action.replace('page-width-', ''));
  }
}

/** 在行号 gutter 上打开专用右键菜单。 */
function handleGutterContextMenu(event: MouseEvent, view: EditorView): boolean {
  const target = event.target instanceof Element
    ? event.target
    : event.target instanceof Node
      ? event.target.parentElement
      : null;
  const gutter = view.dom.querySelector<HTMLElement>('.cm-lineNumbers, .cm-gutter');
  const gutterRect = gutter?.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const isInsideGutter = Boolean(
    gutterRect
      && event.clientX >= gutterRect.left
      && event.clientX <= gutterRect.right
      && event.clientY >= gutterRect.top
      && event.clientY <= gutterRect.bottom
  );
  const isBeforeContent = event.clientX < contentRect.left
    && event.clientY >= contentRect.top
    && event.clientY <= contentRect.bottom;
  if (!isInsideGutter && !isBeforeContent && !target?.closest('.cm-lineNumbers, .cm-gutter, .cm-gutters')) return false;
  event.preventDefault();
  announceContextMenuOpen(contextMenuOwner);
  gutterContextMenuTarget.value = [event.clientX, event.clientY];
  isGutterContextMenuVisible.value = true;
  return true;
}

/** 文档级兜底捕获行号区域右键事件，兼容 CodeMirror 阻断内部冒泡的情况。 */
function handleDocumentGutterContextMenu(event: MouseEvent): void {
  const view = editorView.value;
  if (!view || event.defaultPrevented) return;
  const gutter = view.dom.querySelector<HTMLElement>('.cm-lineNumbers, .cm-gutter');
  const rect = gutter?.getBoundingClientRect();
  if (!rect) return;
  if (
    event.clientX < rect.left
    || event.clientX > rect.right
    || event.clientY < rect.top
    || event.clientY > rect.bottom
  ) return;
  handleGutterContextMenu(event, view);
}

/**
 * 统一维护当前唯一展开的二级菜单，打开新菜单时立即关闭旧菜单。
 */
function handleContextSubmenuVisibility(
  itemId: string,
  isVisible: boolean,
  parentItemId: string | null = null
): void {
  if (isVisible) {
    activeContextSubmenuId.value = itemId;
    return;
  }

  if (activeContextSubmenuId.value === itemId) {
    activeContextSubmenuId.value = parentItemId;
  }
}

/**
 * 在编辑器发生滚动或滚轮操作时关闭右键菜单，避免菜单悬浮在错误位置。
 */
function handleEditorScroll(): void {
  closeEditorContextMenu();
  closeImageContextMenu();
  closeTableColumnContextMenu();
  isGutterContextMenuVisible.value = false;
}

/**
 * 依据当前右键位置打开编辑器菜单，仅允许编辑正文内容区域触发。 */
async function handleEditorContextMenu(event: MouseEvent): Promise<void> {
  const view = editorView.value;
  const targetNode = event.target;

  if (!view || event.defaultPrevented) return;
  const targetElement = targetNode instanceof Element
    ? targetNode
    : targetNode instanceof Node
      ? targetNode.parentElement
      : null;
  if (targetElement?.closest(`.${EDITOR_NOTE_PROPERTIES_BLOCK_CLASS}`)) return;
  if (!(targetNode instanceof Node) || !view.contentDOM.contains(targetNode)) {
    handleGutterContextMenu(event, view);
    return;
  }

  event.preventDefault();
  announceContextMenuOpen(contextMenuOwner);
  contextMenuTarget.value = [event.clientX, event.clientY];
  const isImageContextTarget = targetNode instanceof Element
    && targetNode.closest('.cm-editor-image-block') !== null;
  const tableCell = targetNode instanceof Element
    ? targetNode.closest<HTMLTableCellElement>('.cm-editor-table th, .cm-editor-table td')
    : null;
  const table = tableCell?.closest<HTMLTableElement>('.cm-editor-table');
  const tableCellEditorView = resolveEditorTableCellView(targetNode);

  closeEditorContextMenu();
  closeImageContextMenu();
  closeTableColumnContextMenu();
  contextMenuCellEditorView = tableCellEditorView;

  if (tableCell && table) {
    const tableRow = tableCell.parentElement as HTMLTableRowElement | null;
    const body = tableRow?.parentElement instanceof HTMLTableSectionElement
      && tableRow.parentElement.tagName === 'TBODY'
      ? tableRow.parentElement
      : null;
    tableColumnContextTarget.value = {
      tableFrom: Number(table.dataset.tableFrom),
      rowIndex: body && tableRow ? Array.from(body.rows).indexOf(tableRow) : null,
      columnIndex: tableCell.cellIndex,
      axis: targetElement?.closest('.cm-editor-table__row-drag-handle') && body
        ? 'row'
        : targetElement?.closest('.cm-editor-table__drag-handle') ? 'column' : 'cell'
    };
    const target = tableColumnContextTarget.value;
    const cellImage = targetElement?.closest<HTMLImageElement>('.cm-editor-table__image[data-table-cell-image]');
    if (target.axis === 'cell' && cellImage) {
      const imageIndex = Number(cellImage.dataset.tableCellImage);
      const image = getEditorTableCellImage(view, target, imageIndex);
      if (!image) return;
      tableImageMenuTarget.value = {
        view, document: view.state.doc, filePath: props.filePath, cell: target, imageIndex, image,
        ...resolveTableCellImageSize(image)
      };
      closeTableColumnContextMenu();
      await nextTick();
      isImageContextMenuVisible.value = true;
      return;
    }
    tableBackgroundColor.value = (target.axis === 'row' && target.rowIndex !== null
      ? getEditorTableRowBackground(view, target.tableFrom, target.rowIndex)
      : getEditorTableColumnBackground(view, target.tableFrom, target.columnIndex)
    ) ?? DEFAULT_CUSTOM_PROJECT_COLOR;
    setTableContextHighlight(view, target, true);
    // 行列专属菜单仅由拖拽手柄触发，单元格统一使用编辑器菜单。
    if (target.axis !== 'cell') {
      isTableColumnContextMenuVisible.value = true;
      await nextTick();
      return;
    }
  }

  if (isImageContextTarget) {
    await nextTick();
    isImageContextMenuVisible.value = true;
    return;
  }

  activeContextSubmenuId.value = null;
  isContextMenuVisible.value = true;
  await nextTick();
}

/** 在单元格拦截鼠标事件前关闭菜单。 */
function handleEditorMouseDownCapture(event: MouseEvent): void {
  if (event.button === 0) {
    closeAllEditorContextMenus();
  }
}

/** 单元格右键时禁用基础菜单中的段落设置和插入功能。 */
function isTableBaseMenuItemDisabled(itemId: string): boolean {
  return tableColumnContextTarget.value !== null
    && (itemId === 'paragraph-settings' || itemId === 'insert-content');
}

/** 执行表格列右键菜单动作。 */
function handleTableColumnContextMenuAction(actionId: TableContextMenuActionId): void {
  const view = editorView.value;
  const target = tableColumnContextTarget.value;
  isContextMenuVisible.value = false;
  activeContextSubmenuId.value = null;
  closeTableColumnContextMenu();
  if (view && target) {
    executeTableContextAction(
      view,
      target.tableFrom,
      target.rowIndex,
      target.columnIndex,
      actionId
    );
  }
}

/** 按菜单手柄方向应用行列高亮，并保持颜色选择器打开。 */
function handleTableBackgroundColor(color: string | null): void {
  const view = editorView.value;
  const target = tableColumnContextTarget.value;
  if (!view || !target) return;
  const normalized = color === null ? null : normalizeHexColor(color);
  if (normalized === undefined) return;
  if (target.axis === 'row' && target.rowIndex !== null) {
    setEditorTableRowBackground(view, target.tableFrom, target.rowIndex, normalized);
  } else {
    setEditorTableColumnBackground(view, target.tableFrom, target.columnIndex, normalized);
  }
  if (normalized) {
    // 修改颜色会重建表格 Widget，菜单仍打开时同步恢复框选和手柄状态。
    setTableContextHighlight(view, target, true);
    tableBackgroundColor.value = normalized;
  } else {
    activeContextSubmenuId.value = null;
    closeTableColumnContextMenu();
  }
}

/** 表头右键时禁用仅适用于数据行的菜单动作。 */
function isTableContextMenuActionDisabled(actionId: TableContextMenuActionId): boolean {
  return actionId.includes('-row-') || actionId.endsWith('-row')
    ? tableColumnContextTarget.value?.rowIndex === null
    : false;
}

/**
 * 判断某个菜单动作当前是否需要禁用。 */
function isContextMenuActionDisabled(actionId: CodeMirrorContextMenuActionId): boolean {
  const view = editorView.value;

  switch (actionId) {
    case 'insert-image': {
      const target = tableColumnContextTarget.value;
      return !view || !target || !props.filePath || !canInsertEditorTableCellImage(view, target);
    }
    case 'clipboard-cut':
    case 'clipboard-copy':
      return !hasSelection(view);
    default:
      return false;
  }
}

/** 插入所选尺寸的 Markdown 表格，并关闭完整上下文菜单。 */
function handleTableSizeSelect(selection: { readonly rows: number; readonly columns: number }): void {
  const view = editorView.value;
  closeEditorContextMenu();
  if (view) {
    insertMarkdownTable(view, selection.rows, selection.columns);
  }
}

/**
 * 触发系统文件选择器，为本地媒体菜单提供文件引用插入能力。 */
async function openLocalMediaPicker(): Promise<void> {
  await nextTick();
  if (!localMediaInput.value) {
    return;
  }

  localMediaInput.value.value = '';
  localMediaInput.value.click();
}

/**
 * 处理本地媒体选择结果，并按媒体类型写回合适的 Markdown 或 HTML 引用。 */
function handleLocalMediaSelect(event: Event): void {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files?.[0];
  const view = editorView.value;

  if (!input) {
    return;
  }

  input.value = '';

  if (!file || !view) {
    return;
  }

  insertLocalMediaReference(view, file);
}

/** 导入系统所选图片，再通过单元格独立附件通道直接展示图片。 */
async function insertTableCellImage(
  view: EditorView,
  target: EditorTableContextTarget,
  cellView: EditorView | null
): Promise<void> {
  if (!props.filePath || !canInsertEditorTableCellImage(view, target)) return;
  const filePath = props.filePath;
  cellView?.contentDOM.blur();
  await nextTick();
  if (editorView.value !== view || props.filePath !== filePath || !canInsertEditorTableCellImage(view, target)) return;
  const originalDocument = view.state.doc;
  const isCurrentTarget = (): boolean => editorView.value === view
    && props.filePath === filePath && !view.state.readOnly && view.state.doc.eq(originalDocument);

  try {
    const sourcePath = await pickLocalImageFile();
    if (!sourcePath || resolveWorkspaceFileKind(sourcePath) !== 'image' || !isCurrentTarget()) return;
    const result = await workspaceApi.importExternalMediaFile({ sourcePath, markdownFilePath: filePath });
    if (result.status !== 'copied' || typeof result.referencePath !== 'string'
      || !result.referencePath.trim() || !isCurrentTarget()) return;
    insertEditorTableCellImage(view, target, {
      source: result.referencePath,
      title: result.title
    });
  } catch (error: unknown) {
    console.error('插入图像失败', error);
  }
}

/**
 * 根据菜单动作分发对应的 Markdown 编辑命令。 */
async function handleContextMenuAction(actionId: CodeMirrorContextMenuActionId): Promise<void> {
  const view = editorView.value;
  const cellEditorView = contextMenuCellEditorView;
  const tableTarget = tableColumnContextTarget.value;

  closeEditorContextMenu();

  if (actionId === 'local-media') {
    if (tableTarget?.axis === 'cell') return;
    await openLocalMediaPicker();
    return;
  }

  if (!view) {
    return;
  }

  switch (actionId) {
    case 'insert-image': {
      if (tableTarget?.axis !== 'cell') return;
      await insertTableCellImage(view, tableTarget, cellEditorView);
      return;
    }
    case 'insert-link':
      insertEditorWikiLink(view);
      return;
    case 'insert-external-link':
      insertMarkdownLink(view, 'https://example.com');
      return;
    case 'insert-bold':
      wrapSelectionWithMarkdownSyntax(view, '**', '**', '');
      return;
    case 'insert-italic':
      wrapSelectionWithMarkdownSyntax(view, '*', '*', '');
      return;
    case 'insert-strikethrough':
      wrapSelectionWithMarkdownSyntax(view, '~~', '~~', '');
      return;
    case 'insert-highlight':
      wrapSelectionWithMarkdownSyntax(view, '==', '==', '');
      return;
    case 'insert-inline-code':
      wrapSelectionWithMarkdownSyntax(view, '`', '`', '');
      return;
    case 'paragraph-unordered-list':
      formatSelectedParagraphs(view, (content) => `- ${content}`);
      return;
    case 'paragraph-ordered-list':
      formatSelectedParagraphs(view, (content, lineIndex) => `${lineIndex + 1}. ${content}`);
      return;
    case 'paragraph-task-list':
      formatSelectedParagraphs(view, (content) => `- [ ] ${content}`);
      return;
    case 'paragraph-heading-1':
      formatSelectedParagraphs(view, (content) => `# ${content}`);
      return;
    case 'paragraph-heading-2':
      formatSelectedParagraphs(view, (content) => `## ${content}`);
      return;
    case 'paragraph-heading-3':
      formatSelectedParagraphs(view, (content) => `### ${content}`);
      return;
    case 'paragraph-heading-4':
      formatSelectedParagraphs(view, (content) => `#### ${content}`);
      return;
    case 'paragraph-heading-5':
      formatSelectedParagraphs(view, (content) => `##### ${content}`);
      return;
    case 'paragraph-heading-6':
      formatSelectedParagraphs(view, (content) => `###### ${content}`);
      return;
    case 'paragraph-body':
      formatSelectedParagraphs(view, (content) => content);
      return;
    case 'paragraph-quote':
      formatSelectedParagraphs(view, (content) => `> ${content}`);
      return;
    case 'insert-code-block-menu':
      insertCodeBlock(view);
      return;
    case 'insert-math-block':
      insertMathBlock(view);
      return;
    case 'insert-admonition-note':
      insertAdmonition(view, 'NOTE', '提醒内容');
      return;
    case 'insert-admonition-tip':
      insertAdmonition(view, 'TIP', '建议内容');
      return;
    case 'insert-admonition-important':
      insertAdmonition(view, 'IMPORTANT', '重要内容');
      return;
    case 'insert-admonition-warning':
      insertAdmonition(view, 'WARNING', '警告内容');
      return;
    case 'insert-admonition-caution':
      insertAdmonition(view, 'CAUTION', '注意内容');
      return;
    case 'color':
      insertColorSpan(view, 'var(--ws-editor-heading-foreground)');
      return;
    case 'clipboard-cut': {
      const selectionText = getJoinedSelectionText(view);
      const didWriteClipboard = await writeClipboardText(selectionText);

      if (!didWriteClipboard && !tryExecuteDocumentCommand('cut')) {
        return;
      }

      if (didWriteClipboard) {
        cutSelectedText(view);
      }
      return;
    }
    case 'clipboard-copy': {
      const selectionText = getJoinedSelectionText(view);
      const didWriteClipboard = await writeClipboardText(selectionText);

      if (!didWriteClipboard) {
        tryExecuteDocumentCommand('copy');
      }
      return;
    }
    case 'clipboard-paste': {
      const clipboardText = await readClipboardText();

      if (clipboardText === null) {
        tryExecuteDocumentCommand('paste');
        return;
      }

      insertPlainText(view, clipboardText);
      return;
    }
    case 'selection-select-all':
      (cellEditorView ?? view).dispatch({
        selection: EditorSelection.range(0, (cellEditorView ?? view).state.doc.length),
        scrollIntoView: true
      });
      (cellEditorView ?? view).focus();
      return;
    default:
      return;
  }
}

/**
 * 根据内容区与 gutter 的真实尺寸同步行号横向位置。 */
function syncEditorPageLayout(view: EditorView): void {
  const host = editorHost.value;
  const gutter = view.scrollDOM.querySelector<HTMLElement>('.cm-gutters');
  const lineNumberGutter = gutter?.querySelector<HTMLElement>('.cm-lineNumbers');

  if (!host || !gutter) {
    return;
  }

  const scrollerRect = view.scrollDOM.getBoundingClientRect();
  const contentRect = view.contentDOM.getBoundingClientRect();
  const gutterWidth = gutter.getBoundingClientRect().width;
  const lineNumberGutterWidth = lineNumberGutter?.getBoundingClientRect().width ?? 0;
  const contentLayoutLeft = contentRect.left - scrollerRect.left + view.scrollDOM.scrollLeft;
  const gutterOffset = Math.max(0, contentLayoutLeft - gutterWidth);

  host.style.setProperty('--workbench-editor-gutter-width', `${gutterWidth}px`);
  host.style.setProperty(
    '--workbench-editor-line-number-gutter-width',
    `${lineNumberGutterWidth}px`
  );
  host.style.setProperty('--workbench-editor-gutter-inline-offset', `${gutterOffset}px`);
}

/**
 * 监听编辑器、内容区与 gutter 尺寸变化，保持行号和正文相邻。 */
function observeEditorPageLayout(view: EditorView): void {
  const gutter = view.scrollDOM.querySelector<HTMLElement>('.cm-gutters');

  editorPageLayoutObserver?.disconnect();
  editorPageLayoutObserver = undefined;

  if (!gutter) {
    return;
  }

  editorPageLayoutObserver = new ResizeObserver(() => syncEditorPageLayout(view));
  editorPageLayoutObserver.observe(view.scrollDOM);
  editorPageLayoutObserver.observe(view.contentDOM);
  editorPageLayoutObserver.observe(gutter);
  syncEditorPageLayout(view);
}

/**
 * 记录当前编辑器滚动容器，供通用滚动条组件直接复用。 */
function attachScroller(view: EditorView): void {
  editorScrollElement?.removeEventListener('scroll', handleEditorScroll);
  scrollerElement.value = view.scrollDOM as HTMLElement;
  editorScrollElement = scrollerElement.value;
  editorScrollElement?.addEventListener('scroll', handleEditorScroll, { passive: true });
  observeEditorPageLayout(view);
}

/**
 * 初始化 CodeMirror 实例并在需要时自动聚焦。 */
onMounted(() => {
  void editorSettingsStore.initialize().catch(() => undefined);
  disposeContextMenuRegistration = registerContextMenu(contextMenuOwner, closeAllEditorContextMenus);
  if (!editorHost.value) {
    return;
  }

  editorView.value = new EditorView({
    parent: editorHost.value,
    state: createEditorState()
  });
  disposeWorkspaceDirectoryChanged = workspaceApi.onDirectoryChanged(() => {
    const view = editorView.value;
    if (!view || !view.dom.isConnected) {
      return;
    }

    view.dispatch({
      effects: [
        refreshEditorImageBlockResourcesEffect.of(undefined),
        refreshEditorPlayableMediaBlockResourcesEffect.of(undefined)
      ]
    });
  });
  editorView.value.dom.addEventListener('contextmenu', handleEditorContextMenu, true);
  editorHost.value.addEventListener('contextmenu', handleEditorContextMenu, true);
  document.addEventListener('contextmenu', handleDocumentGutterContextMenu, true);
  attachScroller(editorView.value);
  applyEditorNavigationRequest(props.navigationRequest);

  if (props.autofocus) {
    editorView.value.focus();
  }
});

/** 将导航请求应用到已经创建的 CodeMirror 实例。 */
function applyEditorNavigationRequest(
  request: CodeMirrorEditorProps['navigationRequest']
): void {
  const view = editorView.value;

  if (!request || !view) {
    return;
  }

  const position = Math.max(0, Math.min(view.state.doc.length, request.position));
  const selectionEnd = Math.max(
    position,
    Math.min(view.state.doc.length, request.selectionEnd ?? position)
  );
  const selection = EditorSelection.range(position, selectionEnd);
  const verticalAlignment = request.verticalAlignment ?? 'nearest';
  if (verticalAlignment === 'nearest') {
    view.dispatch({ selection, scrollIntoView: true });
  } else {
    const scrollOptions = verticalAlignment === 'center'
      ? { y: 'center' as const }
      : {
          y: 'start' as const,
          yMargin: Math.min(
            Math.max(0, view.scrollDOM.clientHeight - 1),
            Math.round(view.scrollDOM.clientHeight * EDITOR_UPPER_CENTER_VIEWPORT_RATIO)
          )
        };
    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(selection, scrollOptions)
    });
  }
  view.focus();
}

/**
 * 当外部文档值变更时，将内容同步回编辑器实例。 */
watch(() => props.modelValue, (nextValue) => {
  const view = editorView.value;

  if (!view) {
    return;
  }

  const currentValue = view.state.doc.toString();
  if (nextValue === currentValue) {
    return;
  }

  view.dispatch({
    changes: {
      from: 0,
      to: currentValue.length,
      insert: nextValue
    }
  });
});

/** 字体设置变化后重新测量行块，确保折叠 gutter 与放大后的标题行保持垂直居中。 */
watch(
  [editorFontFamily, editorFontSize],
  async () => {
    await nextTick();
    editorView.value?.requestMeasure();
  },
  { flush: 'post' }
);

/** 同步标签页属性块可见状态，避免重建整个编辑器实例。 */
watch(notePropertiesBlockVisible, (visible) => {
  editorView.value?.dispatch({
    effects: setEditorNotePropertiesBlockVisibilityEffect.of(visible)
  });
});

/** 响应外部文件导航请求，移动选区、滚动并聚焦目标位置。 */
watch(() => props.navigationRequest, async (request) => {
  if (!request) {
    return;
  }

  await nextTick();
  applyEditorNavigationRequest(request);
}, { immediate: true });

/**
 * 在全局主题变化时，动态重配置编辑器主题扩展并刷新 Mermaid 图表。 */
watch([isDarkTheme, activeTheme], () => {
  const view = editorView.value;

  if (!view) {
    return;
  }

  view.dispatch({
    effects: [
      editorThemeCompartment.reconfigure(createEditorThemeExtensions()),
      refreshEditorMermaidThemeEffect.of(null)
    ]
  });
});

/** 当编辑器切换到其他文件标签时，重新配置对应的语法高亮语言。 */
watch(() => props.filePath, () => {
  closeAllEditorContextMenus();
  isTableImageSizeVisible.value = false;
  const view = editorView.value;

  if (!view) {
    return;
  }

  view.dispatch({
    effects: editorLanguageCompartment.reconfigure(createEditorLanguageExtension())
  });
});

/** 页面宽度变化后重新计算 gutter 偏移，避免覆盖正文行首。 */
watch(editorPageWidth, async () => {
  await nextTick();

  const view = editorView.value;
  if (view) {
    syncEditorPageLayout(view);
  }
});

/**
 * 菜单被 Vuetify 外部点击关闭时同步清除目标列边框。
 */
watch(isTableColumnContextMenuVisible, (isVisible) => {
  if (!isVisible && tableColumnContextTarget.value) {
    closeTableColumnContextMenu();
  }
});

/**
 * 基础菜单被外部点击关闭时同步清除表格上下文状态。
 */
watch(isContextMenuVisible, (isVisible) => {
  if (!isVisible && tableColumnContextTarget.value) {
    closeTableColumnContextMenu();
  }
});

/** 尺寸窗口关闭后释放文档快照和目标编辑器引用。 */
watch(isTableImageSizeVisible, isVisible => {
  if (!isVisible) tableImageSizeTarget.value = null;
});

/**
 * 释放动画帧、滚动监听与编辑器实例，防止组件卸载后残留副作用。 */
onBeforeUnmount(() => {
  disposeContextMenuRegistration?.();
  disposeContextMenuRegistration = undefined;
  disposeWorkspaceDirectoryChanged?.();
  disposeWorkspaceDirectoryChanged = undefined;
  editorPageLayoutObserver?.disconnect();
  editorPageLayoutObserver = undefined;
  editorScrollElement?.removeEventListener('scroll', handleEditorScroll);
  editorScrollElement = undefined;
  scrollerElement.value = undefined;
  editorView.value?.dom.removeEventListener('contextmenu', handleEditorContextMenu, true);
  editorHost.value?.removeEventListener('contextmenu', handleEditorContextMenu, true);
  document.removeEventListener('contextmenu', handleDocumentGutterContextMenu, true);
  const editor = editorView.value;
  if (editor) {
    isDisposingEditor = true;
    closeInlineChatWidgets(editor);
    disposeInlineChatWidgets(editor.dom);
  }
  editor?.destroy();
  editorView.value = undefined;
});
</script>

<template>
  <div
    :class="['code-mirror-editor', { 'code-mirror-editor--json': isJsonDocument }]"
    :style="{
      '--workbench-editor-font-family': editorFontFamily,
      '--workbench-editor-font-size': `${editorFontSize}px`,
      '--workbench-editor-line-height': editorLineHeight,
      '--workbench-editor-strong-font-size': `${editorFontSize}px`,
      '--workbench-editor-heading-fontSize': editorHeadingFontSize
    }"
    @wheel.passive="handleEditorScroll"
    @contextmenu.capture="handleEditorContextMenu"
  >
    <div
      ref="editorHost"
      :class="[
        'code-mirror-editor__host',
        { 'code-mirror-editor--hide-inline-heading': hideInlineHeading,
          'code-mirror-editor--hide-line-numbers': !showLineNumbers }
      ]"
      :style="{ '--workbench-editor-heading-align': headingAlignment, '--workbench-editor-page-width': `${editorPageWidth}%` }"
      @mousedown.capture="handleEditorMouseDownCapture"
    />
    <Teleport
      v-if="notePropertiesBlockTarget"
      :to="notePropertiesBlockTarget"
    >
      <!-- S = 笔记属性块 -->
      <AsyncNotePropertiesPanel
        :date-note-creation-pending="dateNoteCreationPending"
        :expanded="notePropertiesBlockExpanded"
        :menu-request-id="notePropertiesMenuRequestId"
        :model-value="modelValue"
        @create-date-note="handleDateNoteCreation"
        @exit-properties="handleNotePropertiesExit"
        @request-expand="handleNotePropertiesExpandRequest"
        @request-hide="handleNotePropertiesHideRequest"
        @update:model-value="handleNotePropertiesDocumentUpdate"
      />
      <!-- E = 笔记属性块 -->
    </Teleport>
    <input
      ref="localMediaInput"
      accept="*/*"
      class="code-mirror-editor__media-input"
      type="file"
      @change="handleLocalMediaSelect"
    >
    <!-- S = 图片块右键菜单 -->
    <CodeMirrorContextMenu
      v-model="isImageContextMenuVisible"
      :content-class="imageContextMenuOverlayClass"
      :close-on-content-click="tableImageMenuTarget === null"
      :target="contextMenuTarget"
    >
      <div class="code-mirror-editor__context-menu">
        <v-list
          v-bind="editorContextMenuListProps"
          class="code-mirror-editor__context-menu-list"
        >
          <template v-for="item in imageContextMenuItems" :key="item.id">
            <v-divider
              v-if="item.kind === 'divider'"
              class="code-mirror-editor__context-menu-divider"
            />
            <!-- S = 单元格图片布局子菜单 -->
            <CodeMirrorContextMenu
              v-else-if="item.kind === 'submenu'"
              submenu
              :content-class="contextMenuOverlayClass"
              :model-value="isContextSubmenuVisible(item.id)"
              @update:model-value="handleContextSubmenuVisibility(item.id, $event)"
            >
              <template #activator="{ props: submenuActivatorProps }">
                <v-list-item
                  v-bind="buildContextMenuActivatorProps(submenuActivatorProps)"
                  class="code-mirror-editor__context-menu-item"
                  :title="item.label"
                  :disabled="isTableImageActionDisabled(item.id)"
                  :active="isContextSubmenuVisible(item.id)"
                >
                  <template #append>
                    <span class="code-mirror-editor__context-menu-arrow" v-html="arrowForwardIcon" />
                  </template>
                </v-list-item>
              </template>
              <div class="code-mirror-editor__context-menu">
                <v-list v-bind="editorContextMenuListProps" class="code-mirror-editor__context-menu-list">
                  <template v-for="option in item.children" :key="option.id">
                    <v-list-item
                      v-bind="editorContextMenuItemProps"
                      class="code-mirror-editor__context-menu-item"
                      :title="option.label"
                      role="menuitemradio"
                      :aria-checked="isTableImageLayoutActionSelected(option.id)"
                      :active="isTableImageLayoutActionSelected(option.id)"
                      :disabled="isTableImageActionDisabled(option.id)"
                      @mousedown.prevent
                      @click="handleImageContextAction(option.id)"
                    >
                      <template #prepend>
                        <span class="code-mirror-editor__context-menu-check" aria-hidden="true">
                          <span v-if="isTableImageLayoutActionSelected(option.id)" v-html="checkedIcon" />
                        </span>
                      </template>
                    </v-list-item>
                  </template>
                </v-list>
              </div>
            </CodeMirrorContextMenu>
            <!-- E = 单元格图片布局子菜单 -->
            <v-list-item
              v-else
              v-bind="editorContextMenuItemProps"
              class="code-mirror-editor__context-menu-item"
              :title="item.label"
              :class="{ 'code-mirror-editor__image-delete': item.id === 'delete-image' }"
              :disabled="isTableImageActionDisabled(item.id)"
              @click="handleImageContextAction(item.id)"
            />
          </template>
        </v-list>
    </div>
    </CodeMirrorContextMenu>
    <!-- E = 图片块右键菜单 -->
    <!-- S = 单元格图片尺寸窗口 -->
    <WorkbenchDialog v-model="isTableImageSizeVisible" title="图片尺寸">
      <label class="code-mirror-editor__image-size-field">
        <span>宽度</span>
        <!-- S = 图片宽度输入框 -->
        <WsInput v-model="tableImageWidth" class="code-mirror-editor__image-size-input" aria-label="宽度（像素）" type="number" min="1" :max="TABLE_CELL_IMAGE_MAX_SIZE" autofocus @input="clampTableImageSizeInput('width', $event)" @keydown.enter.prevent="applyTableImageSize" />
        <!-- E = 图片宽度输入框 -->
      </label>
      <label class="code-mirror-editor__image-size-field">
        <span>高度</span>
        <!-- S = 图片高度输入框 -->
        <WsInput v-model="tableImageHeight" class="code-mirror-editor__image-size-input" aria-label="高度（像素）" type="number" min="1" :max="TABLE_CELL_IMAGE_MAX_SIZE" @input="clampTableImageSizeInput('height', $event)" @keydown.enter.prevent="applyTableImageSize" />
        <!-- E = 图片高度输入框 -->
      </label>
      <template #actions>
        <v-spacer />
        <v-btn v-bind="imageSizeButtonProps" @click="isTableImageSizeVisible = false">取消</v-btn>
        <v-btn v-bind="imageSizeButtonProps" :disabled="!isTableImageSizeValid" @click="applyTableImageSize">确定</v-btn>
      </template>
    </WorkbenchDialog>
    <!-- E = 单元格图片尺寸窗口 -->
    <!-- S = 行号区域右键菜单 -->
    <CodeMirrorContextMenu
      v-model="isGutterContextMenuVisible"
      content-class="code-mirror-editor__context-menu-overlay code-mirror-editor__gutter-context-menu"
      :target="gutterContextMenuTarget"
    >
      <div class="code-mirror-editor__context-menu">
      <v-list v-bind="editorContextMenuListProps" class="code-mirror-editor__context-menu-list">
        <CodeMirrorContextMenu
          v-model="isGutterHeadingSubmenuVisible"
          submenu
          :content-class="contextMenuOverlayClass"
        >
          <template #activator="{ props: submenuProps }">
            <v-list-item
              v-bind="{ ...submenuProps, ...editorContextMenuItemProps }"
              class="code-mirror-editor__context-menu-item"
              title="行内标题"
              :active="isGutterHeadingSubmenuVisible"
            >
              <template #append>
                <span
                  class="code-mirror-editor__context-menu-arrow"
                  v-html="arrowForwardIcon"
                />
              </template>
            </v-list-item>
          </template>
          <div class="code-mirror-editor__context-menu">
          <v-list v-bind="editorContextMenuListProps" class="code-mirror-editor__context-menu-list">
            <v-list-item v-bind="editorContextMenuItemProps" class="code-mirror-editor__context-menu-item" title="居中" @click="handleGutterContextAction('heading-align-center')" />
            <v-list-item v-bind="editorContextMenuItemProps" class="code-mirror-editor__context-menu-item" title="左对齐" @click="handleGutterContextAction('heading-align-left')" />
            <v-list-item v-bind="editorContextMenuItemProps" class="code-mirror-editor__context-menu-item" title="右对齐" @click="handleGutterContextAction('heading-align-right')" />
          </v-list>
          </div>
        </CodeMirrorContextMenu>
        <v-list-item
          v-bind="editorContextMenuItemProps"
          class="code-mirror-editor__context-menu-item"
          :title="hideInlineHeading ? '显示行内标题' : '隐藏行内标题'"
          @click="handleGutterContextAction('hide-heading')"
        />
        <v-list-item
          v-bind="editorContextMenuItemProps"
          class="code-mirror-editor__context-menu-item"
          title="路径导航"
          role="checkbox"
          :aria-checked="props.pathNavigationVisible"
          @click="handleGutterContextAction('toggle-path-navigation')"
        />
        <CodeMirrorContextMenu
          v-model="isGutterIndentationSubmenuVisible"
          submenu
          :content-class="contextMenuOverlayClass"
        >
          <template #activator="{ props: submenuProps }">
            <v-list-item
              v-bind="{ ...submenuProps, ...editorContextMenuItemProps }"
              class="code-mirror-editor__context-menu-item"
              title="缩进线"
              :active="isGutterIndentationSubmenuVisible"
            >
              <template #append>
                <span
                  class="code-mirror-editor__context-menu-arrow"
                  v-html="arrowForwardIcon"
                />
              </template>
            </v-list-item>
          </template>
          <div class="code-mirror-editor__context-menu">
            <v-list v-bind="editorContextMenuListProps" class="code-mirror-editor__context-menu-list">
              <v-list-item
                v-for="option in indentationGuideOptions"
                :key="option.id"
                v-bind="editorContextMenuItemProps"
                class="code-mirror-editor__context-menu-item"
                :title="option.label"
                :active="indentationGuideStyle === option.id"
                :aria-checked="indentationGuideStyle === option.id"
                role="menuitemradio"
                @click="handleGutterContextAction(`indentation-style-${option.id}`)"
              >
                <template #prepend>
                  <span class="code-mirror-editor__context-menu-check" aria-hidden="true">
                    <span v-if="indentationGuideStyle === option.id" v-html="checkedIcon" />
                  </span>
                </template>
              </v-list-item>
            </v-list>
          </div>
        </CodeMirrorContextMenu>
        <v-list-item
          v-bind="editorContextMenuItemProps"
          class="code-mirror-editor__context-menu-item"
          title="行号"
          :aria-checked="showLineNumbers"
          role="checkbox"
          @click="handleGutterContextAction('toggle-line-numbers')"
        />
        <v-divider class="code-mirror-editor__context-menu-divider" />
        <CodeMirrorContextMenu
          v-model="isGutterPageWidthSubmenuVisible"
          submenu
          :content-class="contextMenuOverlayClass"
        >
          <template #activator="{ props: submenuProps }">
            <v-list-item
              v-bind="{ ...submenuProps, ...editorContextMenuItemProps }"
              class="code-mirror-editor__context-menu-item"
              title="页面宽度"
              :active="isGutterPageWidthSubmenuVisible"
            >
              <template #append>
                <span
                  class="code-mirror-editor__context-menu-arrow"
                  v-html="arrowForwardIcon"
                />
              </template>
            </v-list-item>
          </template>
          <div class="code-mirror-editor__context-menu">
          <v-list v-bind="editorContextMenuListProps" class="code-mirror-editor__context-menu-list">
            <v-list-item
              v-for="width in [50, 60, 70, 80, 90, 100]"
              :key="width"
              v-bind="editorContextMenuItemProps"
              class="code-mirror-editor__context-menu-item"
              :title="`${width}%`"
              :active="editorPageWidth === width"
              @click="handleGutterContextAction(`page-width-${width}`)"
            />
          </v-list>
          </div>
        </CodeMirrorContextMenu>
      </v-list>
      </div>
    </CodeMirrorContextMenu>
    <!-- E = 行号区域右键菜单 -->
    <!-- S = 表格行列拖拽手柄右键菜单 -->
    <CodeMirrorContextMenu
      v-model="isTableColumnContextMenuVisible"
      :content-class="contextMenuOverlayClass"
      :close-on-content-click="false"
      :target="contextMenuTarget"
    >
      <div class="code-mirror-editor__context-menu">
        <v-list
          v-bind="editorContextMenuListProps"
          class="code-mirror-editor__context-menu-list"
        >
          <template v-for="item in tableHandleContextMenuItems" :key="item.id">
            <v-divider
              v-if="item.kind === 'divider'"
              class="code-mirror-editor__context-menu-divider"
            />
            <v-list-item
              v-else-if="item.kind === 'item'"
              v-bind="editorContextMenuItemProps"
              class="code-mirror-editor__context-menu-item"
              :class="{ 'code-mirror-editor__row-delete': item.actionId === 'delete-row' }"
              :disabled="isTableContextMenuActionDisabled(item.actionId)"
              :title="item.label"
              @mousedown.prevent
              @click="handleTableColumnContextMenuAction(item.actionId)"
            />
            <CodeMirrorContextMenu
              v-else
              submenu
              :content-class="item.kind === 'highlight' ? 'code-mirror-editor__color-picker-overlay' : contextMenuOverlayClass"
              :close-on-content-click="item.kind !== 'highlight'"
              :model-value="isContextSubmenuVisible(item.id)"
              @update:model-value="handleContextSubmenuVisibility(item.id, $event)"
            >
              <template #activator="{ props: submenuActivatorProps }">
                <v-list-item
                  v-bind="buildContextMenuActivatorProps(submenuActivatorProps)"
                  class="code-mirror-editor__context-menu-item"
                  :disabled="isTableBaseMenuItemDisabled(item.id)"
                  :title="item.label"
                  :active="isContextSubmenuVisible(item.id)"
                >
                  <template #append>
                    <span
                      class="code-mirror-editor__context-menu-arrow"
                      v-html="arrowForwardIcon"
                    />
                  </template>
                </v-list-item>
              </template>
              <!-- S = 行列高亮颜色选择器 -->
              <ProjectColorPicker
                v-if="item.kind === 'highlight'"
                borderless
                hide-arrow
                :custom-colors="tableBackgroundColors"
                :model-value="tableBackgroundColor"
                @update:model-value="handleTableBackgroundColor"
              >
                <template #footer>
                  <v-list
                    v-bind="editorContextMenuListProps"
                    class="code-mirror-editor__context-menu-list code-mirror-editor__highlight-footer"
                  >
                    <v-list-item
                      v-bind="editorContextMenuItemProps"
                      class="code-mirror-editor__context-menu-item code-mirror-editor__clear-highlight"
                      title="清除高亮"
                      @click="handleTableBackgroundColor(null)"
                    />
                  </v-list>
                </template>
              </ProjectColorPicker>
              <!-- E = 行列高亮颜色选择器 -->
              <div v-else class="code-mirror-editor__context-menu">
                <v-list
                  v-bind="editorContextMenuListProps"
                  class="code-mirror-editor__context-menu-list"
                >
                  <template v-for="child in item.children" :key="child.id">
                    <v-divider
                      v-if="child.kind === 'divider'"
                      class="code-mirror-editor__context-menu-divider"
                    />
                    <v-list-item
                      v-else
                      v-bind="editorContextMenuItemProps"
                      class="code-mirror-editor__context-menu-item"
                      :class="{ 'code-mirror-editor__row-delete': child.actionId === 'delete-row' }"
                      :disabled="isTableContextMenuActionDisabled(child.actionId)"
                      :title="child.label"
                      @mousedown.prevent
                      @click="handleTableColumnContextMenuAction(child.actionId)"
                    />
                  </template>
                </v-list>
              </div>
            </CodeMirrorContextMenu>
          </template>
        </v-list>
      </div>
    </CodeMirrorContextMenu>
    <!-- E = 表格行列拖拽手柄右键菜单 -->
    <CodeMirrorContextMenu
      v-model="isContextMenuVisible"
      :content-class="contextMenuOverlayClass"
      :close-on-content-click="tableColumnContextTarget === null"
      :target="contextMenuTarget"
    >
      <div class="code-mirror-editor__context-menu">
        <v-list
          v-bind="editorContextMenuListProps"
          class="code-mirror-editor__context-menu-list"
        >
          <template v-for="item in editorContextMenuItems" :key="item.id">
            <v-divider
              v-if="item.kind === 'divider'"
              class="code-mirror-editor__context-menu-divider"
            />

            <v-list-item
              v-else-if="item.kind === 'action'"
              v-bind="editorContextMenuItemProps"
              class="code-mirror-editor__context-menu-item"
              :disabled="isContextMenuActionDisabled(item.actionId) || isTableBaseMenuItemDisabled(item.id)"
              :title="item.label"
              @mousedown.prevent
              @click="handleContextMenuAction(item.actionId)"
            />

            <CodeMirrorContextMenu
              v-else
              submenu
              :content-class="contextMenuOverlayClass"
              :model-value="isContextSubmenuVisible(item.id)"
              @update:model-value="handleContextSubmenuVisibility(item.id, $event)"
            >
              <template #activator="{ props: submenuActivatorProps }">
                <v-list-item
                  v-bind="buildContextMenuActivatorProps(submenuActivatorProps)"
                  class="code-mirror-editor__context-menu-item"
                  :disabled="isTableBaseMenuItemDisabled(item.id)"
                  :title="item.label"
                  :active="isContextSubmenuVisible(item.id)"
                >
                  <template #append>
                    <span
                      class="code-mirror-editor__context-menu-arrow"
                      v-html="arrowForwardIcon"
                    />
                  </template>
                </v-list-item>
              </template>

              <div class="code-mirror-editor__context-menu">
                <v-list
                  v-bind="editorContextMenuListProps"
                  class="code-mirror-editor__context-menu-list"
                >
                  <template v-for="child in item.children" :key="child.id">
                    <v-divider
                      v-if="child.kind === 'divider'"
                      class="code-mirror-editor__context-menu-divider"
                    />

                    <CodeMirrorContextMenu
                      v-else-if="child.kind === 'submenu'"
                      submenu
                      :content-class="contextMenuOverlayClass"
                      :model-value="activeContextSubmenuId === child.id"
                      @update:model-value="handleContextSubmenuVisibility(child.id, $event, item.id)"
                    >
                      <template #activator="{ props: childSubmenuActivatorProps }">
                        <v-list-item
                          v-bind="buildContextMenuActivatorProps(childSubmenuActivatorProps)"
                          class="code-mirror-editor__context-menu-item"
                          :title="child.label"
                          :active="activeContextSubmenuId === child.id"
                        >
                          <template #append>
                            <span
                              class="code-mirror-editor__context-menu-arrow"
                              v-html="arrowForwardIcon"
                            />
                          </template>
                        </v-list-item>
                      </template>
                      <div class="code-mirror-editor__context-menu">
                        <v-list
                          v-bind="editorContextMenuListProps"
                          class="code-mirror-editor__context-menu-list"
                        >
                          <v-list-item
                            v-for="grandchild in child.children"
                            :key="grandchild.id"
                            v-bind="editorContextMenuItemProps"
                            class="code-mirror-editor__context-menu-item"
                            :title="grandchild.kind === 'action' ? grandchild.label : ''"
                            @mousedown.prevent
                            @click="grandchild.kind === 'action' && handleContextMenuAction(grandchild.actionId)"
                          />
                        </v-list>
                      </div>
                    </CodeMirrorContextMenu>

                    <CodeMirrorContextMenu
                      v-else-if="child.kind === 'action' && child.actionId === 'insert-table'"
                      submenu
                      :close-on-content-click="false"
                      :model-value="activeContextSubmenuId === child.id"
                      @update:model-value="handleContextSubmenuVisibility(child.id, $event, item.id)"
                    >
                      <template #activator="{ props: tablePickerActivatorProps }">
                        <v-list-item
                          v-bind="buildContextMenuActivatorProps(tablePickerActivatorProps)"
                          class="code-mirror-editor__context-menu-item"
                          :title="child.label"
                          :active="activeContextSubmenuId === child.id"
                        >
                          <template #append>
                            <span
                              class="code-mirror-editor__context-menu-arrow"
                              v-html="arrowForwardIcon"
                            />
                          </template>
                        </v-list-item>
                      </template>
                      <!-- S = 表格尺寸选择器 -->
                      <AsyncTableSizePicker @select="handleTableSizeSelect" />
                      <!-- E = 表格尺寸选择器 -->
                    </CodeMirrorContextMenu>

                    <v-list-item
                      v-else
                      v-bind="editorContextMenuItemProps"
                      class="code-mirror-editor__context-menu-item"
                      :disabled="isContextMenuActionDisabled(child.actionId)"
                      :title="child.label"
                      @mousedown.prevent
                      @click="handleContextMenuAction(child.actionId)"
                    />
                  </template>
                </v-list>
              </div>
            </CodeMirrorContextMenu>
          </template>
          <template v-if="tableColumnContextTarget">
            <v-divider class="code-mirror-editor__context-menu-divider" />
            <template v-for="item in tableCellContextMenuItems" :key="'base-table-' + item.id">
              <v-divider
                v-if="item.kind === 'divider'"
                class="code-mirror-editor__context-menu-divider"
              />
              <v-list-item
                v-else-if="item.kind === 'item'"
                v-bind="editorContextMenuItemProps"
                class="code-mirror-editor__context-menu-item"
                :title="item.label"
                :active="isContextSubmenuVisible(item.id)"
                @mousedown.prevent
                @click="handleTableColumnContextMenuAction(item.actionId)"
              />
              <CodeMirrorContextMenu
                v-else-if="item.kind === 'submenu'"
                submenu
                :content-class="contextMenuOverlayClass"
                :model-value="activeContextSubmenuId === 'base-table-' + item.id"
                @update:model-value="handleContextSubmenuVisibility('base-table-' + item.id, $event)"
              >
                <template #activator="{ props: submenuActivatorProps }">
                  <v-list-item
                    v-bind="buildContextMenuActivatorProps(submenuActivatorProps)"
                    class="code-mirror-editor__context-menu-item"
                    :title="item.label"
                    :active="activeContextSubmenuId === 'base-table-' + item.id"
                  >
                    <template #append>
                      <span
                        class="code-mirror-editor__context-menu-arrow"
                        v-html="arrowForwardIcon"
                      />
                    </template>
                  </v-list-item>
                </template>
                <div class="code-mirror-editor__context-menu">
                  <v-list
                    v-bind="editorContextMenuListProps"
                    class="code-mirror-editor__context-menu-list"
                  >
                    <template v-for="child in item.children" :key="'base-table-' + child.id">
                      <v-divider
                        v-if="child.kind === 'divider'"
                        class="code-mirror-editor__context-menu-divider"
                      />
                      <v-list-item
                        v-else
                        v-bind="editorContextMenuItemProps"
                        class="code-mirror-editor__context-menu-item"
                        :class="{ 'code-mirror-editor__row-delete': child.actionId === 'delete-row' }"
                        :disabled="isTableContextMenuActionDisabled(child.actionId)"
                        :title="child.label"
                        @mousedown.prevent
                        @click="handleTableColumnContextMenuAction(child.actionId)"
                      />
                    </template>
                  </v-list>
                </div>
              </CodeMirrorContextMenu>
            </template>
          </template>
        </v-list>
      </div>
    </CodeMirrorContextMenu>
    <WorkbenchVerticalScrollbar :scroller-element="scrollerElement" />
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;
@use '@/assets/styles/mixins' as *;
@use '../Block/editorBlock' as editor-block;
@use '../CodeBlock/codeBlock' as code-block;
@use '../Footnote/footnote' as footnote;
@use '../WikiLink/wikiLink' as wiki-link;
@use '../WikiLinkEmbed/wikiLinkEmbed' as wiki-link-embed;
@use '../Markdown/markdownInlineLinkPreview' as markdown-inline-link-preview;
@use '../SlashCommand/slashCommand' as slash-command;
@use '../HtmlBlock/htmlBlock' as html-block;
@use '../Admonition/admonition' as admonition;
@use '../ImageBlock/imageBlock' as image-block;
@use '../AudioBlock/audioBlock' as audio-block;
@use '../MermaidBlock/mermaidBlock' as mermaid-block;
@use '../VideoBlock/videoBlock' as video-block;
@use '../InlineChat/inlineChat' as inline-chat;
@use '../NotePropertiesBlock/notePropertiesBlock' as note-properties-block;
@use '../Table/table' as table;
@use './codeMirrorEditorSurface' as editor-surface;
@use '@/components/WsEditorlineSearch/editorlineSearch' as editorline-search;

.code-mirror-editor__highlight-footer {
  width: fit-content;
  margin-inline-start: auto;
}

.code-mirror-editor {
  --workbench-editor-background: var(--ws-editor-background);
  --workbench-editor-overlay-background: var(--ws-editor-overlayBackground);
  --workbench-editor-gutter-font-size: #{$editor-gutter-fontSize};
  --workbench-editor-gutter-background: var(--ws-editor-gutter-background);
  --workbench-editor-border: var(--ws-border);
  --workbench-editor-text: var(--ws-editor-foreground);

  --workbench-editor-gutter-text: var(--ws-editor-gutter-foreground);
  --workbench-editor-content-padding-inline-end: #{$editor-content-padding-inline-end};
  --workbench-editor-line-number-gutter-padding-inline-start: #{$editor-line-number-gutter-padding-inline-start};
  --workbench-editor-line-number-gutter-padding-inline-end: #{$editor-line-number-gutter-padding-inline-end};
  --workbench-editor-cursor: var(--ws-editor-cursor-foreground);
  --workbench-editor-cursor-width: #{$editor-cursor-width};
  --workbench-editor-selection: var(--ws-editor-selectionBackground);
  --workbench-editor-active-line: var(--ws-editor-lineHighlightBackground);
  --workbench-editor-heading-foreground: var(--ws-editor-heading-foreground);
  --workbench-editor-task-list-checkbox-size: #{$editor-task-list-checkbox-size};
  --workbench-editor-task-list-checkbox-border-width: #{$editor-task-list-checkbox-border-width};
  --workbench-editor-task-list-checkbox-radius: #{$editor-task-list-checkbox-radius};
  --workbench-editor-task-list-checkbox-align: #{$editor-task-list-checkbox-align};
  --workbench-editor-task-list-check-inset-inline: #{$editor-task-list-check-inset-inline};
  --workbench-editor-task-list-check-inset-block: #{$editor-task-list-check-inset-block};
  --workbench-editor-task-list-check-width: #{$editor-task-list-check-width};
  --workbench-editor-task-list-check-height: #{$editor-task-list-check-height};
  --workbench-editor-task-list-check-border-width: #{$editor-task-list-check-border-width};
  --workbench-editor-padding: #{$spacing-sm};
  --workbench-editor-fold-icon-size: 1.3rem;
  --workbench-editor-font-family: #{$font-family-base};
  --workbench-editor-font-size: #{$editor-font-size};
  --workbench-editor-line-height: #{$editor-line-height-size};
  --workbench-editor-horizontal-rule-position: #{$editor-horizontal-rule-position};
  --workbench-editor-horizontal-rule-width: #{$editor-horizontal-rule-width};
  --workbench-editor-block-gap: #{$editor-block-gap};
  --workbench-editor-quote-line-width: #{$editor-quote-line-width};
  --workbench-editor-quote-content-padding-inline: #{$editor-quote-content-padding-inline};
  --workbench-editor-delete-line-width: #{$editor-delete-line-width};
  --workbench-editor-highlight-padding-x: #{$editor-highlight-padding-x};
  --workbench-editor-highlight-radius: #{$editor-highlight-radius};
  --workbench-editor-inline-code-padding-x: #{$editor-inline-code-padding-x};
  --workbench-editor-inline-code-radius: #{$editor-inline-code-radius};
  --workbench-editor-strong-font-size: #{$editor-strong-font-size};
  --workbench-editor-strong-font-weight: #{$editor-strong-font-weight};
  --workbench-editor-heading-line-height: #{$editor-heading-line-height};
  --workbench-editor-heading-font-weight: #{$editor-heading-font-weight};
  --workbench-editor-heading-prefix-gap: #{$editor-heading-prefix-gap};
  --workbench-editor-heading-fontSize: #{$editor-heading-size};
  --workbench-editor-heading-align: left;
  --workbench-editor-page-width: 100%;
  --workbench-editor-gutter-width: 0px;
  --workbench-editor-line-number-gutter-width: 0px;
  --workbench-editor-gutter-inline-offset: 0px;
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.code-mirror-editor__host {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.code-mirror-editor__host.code-mirror-editor--hide-line-numbers :deep(.cm-lineNumbers) {
  display: none;
}

.code-mirror-editor__host.code-mirror-editor--hide-inline-heading :deep(.cm-markdown-heading-marker) {
  visibility: hidden;
}

.code-mirror-editor__media-input {
  display: none;
}

  @include image-block.styles;
  @include audio-block.styles;
  @include mermaid-block.styles;
  @include video-block.styles;
@include editor-block.styles;
@include note-properties-block.styles;
@include table.styles;
@include wiki-link.styles;
@include wiki-link-embed.styles;
@include admonition.styles;
@include slash-command.styles;
@include inline-chat.styles;
@include editor-surface.styles;
@include editorline-search.styles;

.code-mirror-editor :deep(.cm-editor) {
  height: 100%;
  position: relative;
}

.code-mirror-editor :deep(.cm-scroller) {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.code-mirror-editor--json :deep(.cm-editor-code-token--keyword) {
  color: var(--ws-editor-codeBlock-keywordForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--variable) {
  color: var(--ws-editor-codeBlock-variableForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--string) {
  color: var(--ws-editor-codeBlock-stringForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--number) {
  color: var(--ws-editor-codeBlock-numberForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--constant) {
  color: var(--ws-editor-codeBlock-constantForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--boolean) {
  color: var(--ws-editor-codeBlock-booleanForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--null) {
  color: var(--ws-editor-codeBlock-nullForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--comment) {
  color: var(--ws-editor-codeBlock-commentForeground);
}

.code-mirror-editor--json :deep(.cm-editor-code-token--operator),
.code-mirror-editor--json :deep(.cm-editor-code-token--punctuation) {
  color: var(--ws-editor-codeBlock-punctuationForeground);
}

.code-mirror-editor :deep(.cm-scroller::-webkit-scrollbar) {
  width: 0;
  height: 0;
  display: none;
}

</style>
