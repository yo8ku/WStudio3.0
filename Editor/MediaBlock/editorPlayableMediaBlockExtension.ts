/**
 * 文件说明：为音频与视频提供共享的 CodeMirror 播放器块状态、交互、导航和尺寸测量能力。
 */
import {
  EditorSelection,
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField
} from '@codemirror/state';
import {
  type BlockInfo,
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  lineNumberWidgetMarker,
  type WidgetType
} from '@codemirror/view';

const editorIcon = '<span class="icon icon-editor-code"></span>';
import { resolveMediaSourceUrl } from '@/api/media';
import { trimBoundedCache } from '@/utils/boundedCache';
import { isLocalMediaResourceAvailable } from '@editor/MediaBlock/editorMediaResourceUtils';
import type { PluginWorkspaceFileKind } from '../../plugin/sdk/fileTypes';
import { resolveWorkspaceFileKind } from '../../plugin/sdk/fileTypes';
import { createEditorBlockNavigationExtension } from '@editor/Block/editorBlockNavigationExtension';
import {
  requestEditorBlockFollowupScroll,
  requestPendingEditorBlockScroll
} from '@editor/Block/editorBlockScrollUtils';
import {
  createEditorBlockDecoration,
  doesSelectionTouchEditorBlock,
  resolveRenderedEditorBlockLineRanges,
  resolveTrackedEditorBlockLineFrom
} from '@editor/Block/editorBlockState';
import { createEditorBlockTrailingLineExtension } from '@editor/Block/editorBlockTrailingLineExtension';
import type { EditorBlockSourceRange } from '@editor/Block/editorBlockTypes';
import {
  applyEditorBlockVisualState,
  createEditorBlockActionsElement
} from '@editor/Block/editorBlockUtils';
import { EditorBlockWidget } from '@editor/Block/editorBlockWidget';

const PLAYABLE_MEDIA_BLOCK_PATTERN = /^!\[\[(.+?)(?:\s+"(?:\\.|[^"\\])*")?(?:\s+"(?:\\.|[^"\\])*")?\]\]$/;

type PlayableMediaKind = Extract<PluginWorkspaceFileKind, 'audio' | 'video'>;

/** 创建播放器块所需的媒体类型与界面文案。 */
export interface EditorPlayableMediaBlockOptions {
  /** 需要识别和创建的媒体元素类型。 */
  readonly kind: PlayableMediaKind;
  /** 播放器的无障碍名称。 */
  readonly label: string;
  /** 资源加载失败时显示的说明。 */
  readonly loadErrorLabel: string;
  /** 源码编辑按钮的说明。 */
  readonly editSourceLabel: string;
  /** Return the absolute path of the Markdown file currently being rendered. */
  readonly getCurrentFilePath?: () => string | undefined;
}

/** 播放器块语法解析结果。 */
interface EditorPlayableMediaBlockMatch extends EditorBlockSourceRange {
  /** 媒体加载地址。 */
  readonly source: string;
  /** 媒体地址在源码中的起点。 */
  readonly sourceFrom: number;
  /** 媒体地址在源码中的终点。 */
  readonly sourceTo: number;
}

/** 播放器块扩展状态。 */
interface EditorPlayableMediaBlockState {
  /** 播放器 Widget 与源码隐藏装饰。 */
  readonly decorations: DecorationSet;
  /** 隐藏源码对应的原子范围。 */
  readonly atomicRanges: DecorationSet;
  /** 已进入渲染态的媒体行。 */
  readonly renderedLineFroms: readonly number[];
  /** 当前选中的媒体行。 */
  readonly selectedLineFrom: number | null;
  /** 当前显示源码的媒体行。 */
  readonly editingLineFrom: number | null;
  /** 播放器块已测量高度。 */
  readonly measuredHeights: ReadonlyMap<string, number>;
  /** 最近一次工作区目录变化的资源刷新标记。 */
  readonly resourceRefreshVersion: number;
}

/** 请求当前编辑器重新探测本地音频或视频资源。 */
export const refreshEditorPlayableMediaBlockResourcesEffect = StateEffect.define<void>();

/**
 * 创建指定媒体类型的 CodeMirror 播放器块扩展。
 */
export function createEditorPlayableMediaBlockExtension(
  options: EditorPlayableMediaBlockOptions
): readonly Extension[] {
  const blockClass = `cm-editor-${options.kind}-block`;
  const mediaClass = `${blockClass}__${options.kind}`;
  const errorClass = `${blockClass}__error`;
  const editButtonClass = `${blockClass}__edit`;
  const editIconClass = `${blockClass}__edit-icon`;
  const sourceClass = `${blockClass}-source`;
  const sourceUrlClass = `${blockClass}-source-url`;
  const mediaStateAttribute = `data-${options.kind}-state`;
  const resizeObservers = new WeakMap<HTMLElement, ResizeObserver>();
  /** 保存每个媒体块最近一次已同步的高度，避免 ResizeObserver 重复派发相同布局。 */
  const reportedHeights = new WeakMap<HTMLElement, number>();
  /** 保留同一媒体 URL 的原生元素，避免 Widget 虚拟化时重新加载媒体。 */
  const mediaElements = new Map<string, HTMLMediaElement[]>();
  const MEDIA_CACHE_MAX_ENTRIES = 24;

  function trimMediaCache(): void {
    for (const [sourceUrl, elements] of mediaElements) {
      const reusable = elements.filter(element => !element.isConnected).slice(-2);
      if (reusable.length === 0) {
        mediaElements.delete(sourceUrl);
      } else {
        mediaElements.set(sourceUrl, reusable);
      }
    }

    trimBoundedCache(mediaElements, MEDIA_CACHE_MAX_ENTRIES, (elements) => {
      elements.forEach(element => {
        element.pause();
        element.removeAttribute('src');
        element.load();
      });
    });
  }
  const setSelectionEffect = StateEffect.define<number | null>();
  const setEditingEffect = StateEffect.define<number | null>();
  const setHeightEffect = StateEffect.define<{
    readonly source: string;
    readonly height: number;
  }>();

  /** 文件被删除时停止继续显示旧的媒体缓冲，恢复后再加载资源。 */
  function refreshMediaResource(
    root: HTMLElement,
    mediaElement: HTMLMediaElement,
    sourceUrl: string,
    refreshToken: number
  ): void {
    const refreshKey = String(refreshToken);
    root.dataset.mediaRefresh = refreshKey;
    void isLocalMediaResourceAvailable(sourceUrl, options.kind, refreshToken).then((available) => {
      if (!root.isConnected || root.dataset.mediaRefresh !== refreshKey) {
        return;
      }

      if (!available) {
        root.setAttribute(mediaStateAttribute, 'error');
        mediaElement.removeAttribute('src');
        mediaElement.load();
        return;
      }

      if (
        root.getAttribute(mediaStateAttribute) === 'error'
        || !mediaElement.getAttribute('src')
      ) {
        root.setAttribute(mediaStateAttribute, 'loading');
        mediaElement.removeAttribute('src');
        mediaElement.src = sourceUrl;
        mediaElement.load();
      }
    });
  }

  /** 阻止工具按钮的主键按下事件传递给编辑器。 */
  function preventPrimaryPointerDefault(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  /** 收集严格占据独立行且类型匹配的播放器块语法。 */
  function collectMatches(state: EditorState): EditorPlayableMediaBlockMatch[] {
    const matches: EditorPlayableMediaBlockMatch[] = [];

    for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
      const line = state.doc.line(lineNumber);
      const match = PLAYABLE_MEDIA_BLOCK_PATTERN.exec(line.text.trim());

      if (!match || resolveWorkspaceFileKind(match[1].trim()) !== options.kind) {
        continue;
      }

      matches.push({
        from: line.from,
        to: line.to,
        source: match[1].trim(),
        sourceFrom: line.from + 3,
        sourceTo: line.from + 3 + match[1].length
      });
    }

    return matches;
  }

  /** 播放器块对应的真实行号标记。 */
  class EditorPlayableMediaBlockLineNumberMarker extends GutterMarker {
    /** 创建播放器块行号标记。 */
    public constructor(private readonly lineNumber: number) {
      super();
    }

    /** 比较行号，避免无变化时重复创建 DOM。 */
    public override eq(marker: GutterMarker): boolean {
      return marker instanceof EditorPlayableMediaBlockLineNumberMarker
        && marker.lineNumber === this.lineNumber;
    }

    /** 创建行号文本节点。 */
    public override toDOM(): HTMLElement {
      const element = document.createElement('span');
      element.textContent = String(this.lineNumber);
      return element;
    }
  }

  /** 共享的音频或视频播放器块 Widget。 */
  class EditorPlayableMediaBlockWidget extends EditorBlockWidget {
    /** 创建播放器块 Widget 描述。 */
    public constructor(
      private readonly source: string,
      selected: boolean,
      editing: boolean,
      measuredHeight: number | null,
      private readonly resourceRefreshVersion: number
    ) {
      super(selected, editing, measuredHeight);
    }

    /** 比较播放器源地址与交互状态，避免高度测量触发原生播放器重建。 */
    public override eq(widget: WidgetType): boolean {
      return widget instanceof EditorPlayableMediaBlockWidget
        && widget.source === this.source
        && this.hasEqualEditorBlockInteractionState(widget)
        && widget.resourceRefreshVersion === this.resourceRefreshVersion;
    }

    /** 在媒体地址不变时原地更新编辑按钮状态。 */
    public override updateDOM(
      dom: HTMLElement,
      _view: EditorView,
      previousWidget: this
    ): boolean {
      if (previousWidget.source !== this.source) {
        return false;
      }

      const editButton = dom.querySelector<HTMLButtonElement>(`.${editButtonClass}`);

      if (!editButton) {
        return false;
      }

      applyEditorBlockVisualState(dom, this.selected, this.editing);
      editButton.setAttribute('aria-pressed', String(this.editing));
      editButton.setAttribute('aria-label', this.editing ? '关闭源码模式' : options.editSourceLabel);
      editButton.tabIndex = this.selected || this.editing ? 0 : -1;

      if (previousWidget.resourceRefreshVersion !== this.resourceRefreshVersion) {
        const mediaElement = dom.querySelector<HTMLMediaElement>(`.${mediaClass}`);
        if (mediaElement) {
          refreshMediaResource(
            dom,
            mediaElement,
            resolveMediaSourceUrl(this.source, options.getCurrentFilePath?.()),
            this.resourceRefreshVersion
          );
        }
      }

      return true;
    }

    /** 创建媒体播放器、错误说明和源码编辑按钮。 */
    public override toDOM(view: EditorView): HTMLElement {
      const root = document.createElement('figure');
      const sourceUrl = resolveMediaSourceUrl(
        this.source,
        options.getCurrentFilePath?.()
      );
      const cachedMediaElements = mediaElements.get(sourceUrl) ?? [];
      const cachedMediaElement = cachedMediaElements.find((element) => !element.isConnected);
      const mediaElement = cachedMediaElement ?? document.createElement(options.kind);
      const errorElement = document.createElement('span');
      const editButton = document.createElement('button');
      const editIcon = document.createElement('span');
      const actions = createEditorBlockActionsElement();

      root.className = blockClass;
      root.contentEditable = 'false';
      root.setAttribute(mediaStateAttribute, 'loading');
      applyEditorBlockVisualState(root, this.selected, this.editing);
      root.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });

      if (!cachedMediaElement) {
        mediaElement.className = mediaClass;
        mediaElement.controls = true;
        mediaElement.preload = 'metadata';
        mediaElement.setAttribute('aria-label', options.label);
        if (mediaElement instanceof HTMLVideoElement) {
          mediaElement.playsInline = true;
        }

        mediaElement.addEventListener('loadedmetadata', () => {
          const currentRoot = mediaElement.parentElement;
          if (!(currentRoot instanceof HTMLElement)) {
            return;
          }

          currentRoot.setAttribute(mediaStateAttribute, 'loaded');
          view.requestMeasure();
          requestPendingEditorBlockScroll(view);
          requestEditorBlockFollowupScroll(view, currentRoot);
        });
        mediaElement.addEventListener('error', () => {
          const currentRoot = mediaElement.parentElement;
          if (!(currentRoot instanceof HTMLElement)) {
            return;
          }

          currentRoot.setAttribute(mediaStateAttribute, 'error');
        });
        cachedMediaElements.push(mediaElement);
        mediaElements.set(sourceUrl, cachedMediaElements);
        trimMediaCache();
      }

      if (mediaElement.error) {
        root.setAttribute(mediaStateAttribute, 'error');
      } else if (mediaElement.readyState >= HTMLMediaElement.HAVE_METADATA) {
        root.setAttribute(mediaStateAttribute, 'loaded');
      }

      errorElement.className = errorClass;
      errorElement.textContent = options.loadErrorLabel;

      editButton.className = editButtonClass;
      editButton.type = 'button';
      editButton.tabIndex = this.selected || this.editing ? 0 : -1;
      editButton.setAttribute('aria-label', this.editing ? '关闭源码模式' : options.editSourceLabel);
      editButton.setAttribute('aria-pressed', String(this.editing));

      editIcon.className = editIconClass;
      editIcon.innerHTML = editorIcon;
      editButton.append(editIcon);
      actions.classList.add(`${blockClass}__actions`);
      actions.append(editButton);

      root.addEventListener('mousedown', (event) => {
        if (
          event.button !== 0
          || event.target === mediaElement
          || event.target instanceof HTMLButtonElement
        ) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        const widgetPosition = view.posAtDOM(root);
        const sourceLine = view.state.doc.lineAt(widgetPosition);
        view.dispatch({
          selection: EditorSelection.cursor(sourceLine.to),
          effects: setSelectionEffect.of(sourceLine.from),
          userEvent: 'select'
        });
        view.focus();
      });
      editButton.addEventListener('mousedown', preventPrimaryPointerDefault);
      editButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const widgetPosition = view.posAtDOM(root);
        const sourceLine = view.state.doc.lineAt(widgetPosition);
        const isEditing = view.state.field(stateField).editingLineFrom === sourceLine.from;
        view.dispatch({
          selection: EditorSelection.cursor(sourceLine.to),
          effects: setEditingEffect.of(isEditing ? null : sourceLine.from),
          userEvent: 'select'
        });
        view.focus();
      });

      root.append(mediaElement, errorElement, actions);
      if (cachedMediaElement || this.resourceRefreshVersion > 0) {
        refreshMediaResource(root, mediaElement, sourceUrl, this.resourceRefreshVersion);
      }
      let pendingHeight = 0;
      let heightSyncFrame = 0;
      const resizeObserver = new ResizeObserver(() => {
        const height = Math.ceil(root.getBoundingClientRect().height);

        if (height <= 0 || reportedHeights.get(root) === height) {
          return;
        }

        pendingHeight = height;
        if (heightSyncFrame !== 0) return;

        heightSyncFrame = requestAnimationFrame(() => {
          heightSyncFrame = 0;
          if (!root.isConnected || pendingHeight <= 0) return;

          const nextHeight = pendingHeight;
          pendingHeight = 0;
          if (reportedHeights.get(root) === nextHeight) return;

          reportedHeights.set(root, nextHeight);
          view.dispatch({
            effects: setHeightEffect.of({
              source: this.source,
              height: nextHeight
            })
          });
          requestPendingEditorBlockScroll(view);
          requestEditorBlockFollowupScroll(view, root);
        });
      });

      resizeObserver.observe(root);
      resizeObservers.set(root, resizeObserver);
      if (!cachedMediaElement && !mediaElement.getAttribute('src')) {
        mediaElement.src = sourceUrl;
      }
      return root;
    }

    /** 释放播放器块尺寸观察器。 */
    public override destroy(dom: HTMLElement): void {
      resizeObservers.get(dom)?.disconnect();
      resizeObservers.delete(dom);
      reportedHeights.delete(dom);
    }

    /** 隔离播放器控件和工具按钮事件。 */
    public override ignoreEvent(event: Event): boolean {
      return event.type === 'mousedown'
        || event.type === 'click'
        || event.type === 'dblclick'
        || event.type.startsWith('pointer');
    }
  }

  /** 播放器块行号补偿扩展。 */
  const lineNumberExtension = lineNumberWidgetMarker.of((
    view: EditorView,
    widget: WidgetType,
    block: BlockInfo
  ) => {
    if (
      !(widget instanceof EditorPlayableMediaBlockWidget)
      || !widget.shouldShowBlockLineNumber()
    ) {
      return null;
    }

    return new EditorPlayableMediaBlockLineNumberMarker(
      view.state.doc.lineAt(block.from).number
    );
  });

  /** 根据匹配结果构建播放器块完整状态。 */
  function buildState(
    state: EditorState,
    matches: readonly EditorPlayableMediaBlockMatch[],
    renderedLineFroms: readonly number[],
    selectedLineFrom: number | null,
    editingLineFrom: number | null,
    measuredHeights: ReadonlyMap<string, number>,
    resourceRefreshVersion: number
  ): EditorPlayableMediaBlockState {
    const decorationRanges: Range<Decoration>[] = [];
    const atomicRanges: Range<Decoration>[] = [];
    const renderedLineFromSet = new Set(renderedLineFroms);
    const nextRenderedLineFroms: number[] = [];
    let hasSelectedLine = false;
    let hasEditingLine = false;

    matches.forEach((match) => {
      const editing = editingLineFrom === match.from;
      const selected = editing || selectedLineFrom === match.from;

      if (
        !renderedLineFromSet.has(match.from)
        && !selected
        && doesSelectionTouchEditorBlock(state, match)
      ) {
        return;
      }

      const widget = new EditorPlayableMediaBlockWidget(
        match.source,
        selected,
        editing,
        measuredHeights.get(match.source) ?? null,
        resourceRefreshVersion
      );
      const editingWidgetDecoration = Decoration.widget({
        widget,
        side: 1,
        block: true
      }).range(match.to);
      nextRenderedLineFroms.push(match.from);
      hasSelectedLine ||= selected;

      if (editing) {
        hasEditingLine = true;
        decorationRanges.push(Decoration.mark({
          class: sourceClass
        }).range(match.from, match.to));
        decorationRanges.push(Decoration.mark({
          class: sourceUrlClass
        }).range(match.sourceFrom, match.sourceTo));
        decorationRanges.push(editingWidgetDecoration);
        return;
      }

      const blockDecoration = createEditorBlockDecoration(state, match, widget);
      decorationRanges.push(blockDecoration);
      atomicRanges.push(blockDecoration);
    });

    return {
      decorations: Decoration.set(decorationRanges, true),
      atomicRanges: Decoration.set(atomicRanges, true),
      renderedLineFroms: nextRenderedLineFroms,
      selectedLineFrom: hasSelectedLine ? editingLineFrom ?? selectedLineFrom : null,
      editingLineFrom: hasEditingLine ? editingLineFrom : null,
      measuredHeights,
      resourceRefreshVersion
    };
  }

  /** 同步播放器块装饰与交互状态。 */
  const stateField = StateField.define<EditorPlayableMediaBlockState>({
    /** 初始化文档中的播放器块装饰。 */
    create(state) {
      const matches = collectMatches(state);
      return buildState(
        state,
        matches,
        matches.map((match) => match.from),
        null,
        null,
        new Map<string, number>(),
        0
      );
    },
    /** 在文档、选区或显式交互状态变化时重建播放器块装饰。 */
    update(blockState, transaction) {
      const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
      const renderedLineFroms = transaction.docChanged
        ? blockState.renderedLineFroms.map((lineFrom) => transaction.changes.mapPos(lineFrom, 1))
        : blockState.renderedLineFroms;
      let selectedLineFrom = blockState.selectedLineFrom;
      let editingLineFrom = blockState.editingLineFrom;
      const measuredHeights = new Map(blockState.measuredHeights);
      let resourceRefreshVersion = blockState.resourceRefreshVersion;
      let interactionChanged = false;

      if (transaction.docChanged) {
        selectedLineFrom = selectedLineFrom === null
          ? null
          : transaction.changes.mapPos(selectedLineFrom, 1);
        editingLineFrom = editingLineFrom === null
          ? null
          : transaction.changes.mapPos(editingLineFrom, 1);
      }

      transaction.effects.forEach((effect) => {
        if (effect.is(setSelectionEffect)) {
          selectedLineFrom = effect.value;
          interactionChanged = true;
          return;
        }

        if (effect.is(refreshEditorPlayableMediaBlockResourcesEffect)) {
          resourceRefreshVersion += 1;
          return;
        }

        if (effect.is(setEditingEffect)) {
          editingLineFrom = effect.value;
          interactionChanged = true;
          return;
        }

        if (effect.is(setHeightEffect)) {
          measuredHeights.set(effect.value.source, effect.value.height);
        }
      });

      if (selectedLineFrom !== null && (transaction.docChanged || selectionChanged)) {
        selectedLineFrom = resolveTrackedEditorBlockLineFrom(transaction.state, selectedLineFrom);
      }
      if (editingLineFrom !== null && (transaction.docChanged || selectionChanged)) {
        editingLineFrom = resolveTrackedEditorBlockLineFrom(transaction.state, editingLineFrom);
      }

      const heightChanged = transaction.effects.some((effect) => (
        effect.is(setHeightEffect)
        && blockState.measuredHeights.get(effect.value.source) !== effect.value.height
      ));

      // 选区变化只有在播放器自身的选中/编辑状态发生变化时才需要重建装饰。
      // 例如点击相邻图片时，视频 Widget 应保持原 DOM，避免原生播放器重新缓冲。
      const mediaSelectionChanged = selectedLineFrom !== blockState.selectedLineFrom
        || editingLineFrom !== blockState.editingLineFrom;

      if (
        !transaction.docChanged
        && !mediaSelectionChanged
        && !interactionChanged
        && !heightChanged
        && resourceRefreshVersion === blockState.resourceRefreshVersion
      ) {
        return blockState;
      }

      return buildState(
        transaction.state,
        collectMatches(transaction.state),
        renderedLineFroms,
        selectedLineFrom,
        editingLineFrom,
        measuredHeights,
        resourceRefreshVersion
      );
    },
    /** 向编辑器提供播放器块装饰与原子选区范围。 */
    provide(field) {
      return [
        EditorView.decorations.from(field, (value) => value.decorations),
        EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
      ];
    }
  });

  /** 为文档末尾播放器块补充真实可编辑空行。 */
  const trailingLineExtension = createEditorBlockTrailingLineExtension(
    (state) => state.field(stateField)
  );

  /** 播放器块向上导航与行首退格保护扩展。 */
  const navigationExtension = createEditorBlockNavigationExtension(
    (state) => resolveRenderedEditorBlockLineRanges(
      state,
      state.field(stateField).renderedLineFroms
    ),
    (view, sourceRange) => {
      view.dispatch({
        selection: EditorSelection.cursor(sourceRange.to),
        effects: setEditingEffect.of(sourceRange.from),
        scrollIntoView: true,
        userEvent: 'select'
      });
    }
  );

  return [
    navigationExtension,
    lineNumberExtension,
    stateField,
    trailingLineExtension
  ];
}
