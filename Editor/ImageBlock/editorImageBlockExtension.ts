/**
 * 文件说明：基于 CodeMirror 官方 Markdown 语法树、Widget 与 Decoration API 渲染独立行图片块。
 */
import { syntaxTree } from '@codemirror/language';
import {
  Facet,
  EditorSelection,
  type EditorState,
  Prec,
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
  WidgetType
} from '@codemirror/view';

const editorIcon = '<span class="icon icon-editor-code"></span>';
const eyeIcon = '<span class="icon icon-eye"></span>';
const eyeCloseIcon = '<span class="icon icon-eye-close"></span>';
import { resolveMediaSourceUrl } from '@/api/media';
import { trimBoundedCache } from '@/utils/boundedCache';
import { createEditorBlockNavigationExtension } from '@editor/Block/editorBlockNavigationExtension';
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
import {
  createImageBlockResizeController,
  type ImageBlockResizeController
} from '@editor/ImageBlock/imgblockUtils';
import { isLocalMediaResourceAvailable } from '@editor/MediaBlock/editorMediaResourceUtils';

const EDITOR_IMAGE_BLOCK_MIN_WIDTH = 96;

/** 为图片 Widget 提供当前 Markdown 文件路径的动态上下文。 */
const editorImageBlockCurrentFilePath = Facet.define<() => string | undefined, () => string | undefined>({
  combine: values => values[0] ?? (() => undefined)
});

/**
 * 描述官方 Markdown 语法树中匹配到的独立行图片。
 */
interface EditorImageBlockMatch extends EditorBlockSourceRange {
  /** URL 节点提供的图片加载地址。 */
  readonly imageSource: string;
  /** LinkTitle 节点提供的图片标题。 */
  readonly imageTitle: string;
}

/**
 * 描述图片块扩展的官方装饰与交互状态。
 */
interface EditorImageBlockState {
  /** 图片 Widget 与源码隐藏装饰。 */
  readonly decorations: DecorationSet;
  /** 隐藏源码对应的官方原子范围。 */
  readonly atomicRanges: DecorationSet;
  /** 已完成首次渲染的图片行起点集合。 */
  readonly renderedLineFroms: readonly number[];
  /** 当前选中的图片行起点。 */
  readonly selectedLineFrom: number | null;
  /** 当前显示真实源码的图片行起点。 */
  readonly editingLineFrom: number | null;
  /** 已测量的图片 Widget 外部高度。 */
  readonly measuredHeights: ReadonlyMap<string, number>;
  /** 用户通过拖拽设置的图片块宽度。 */
  readonly resizedWidths: ReadonlyMap<string, number>;
  /** 当前显示标题行的图片地址集合。 */
  readonly visibleTitleSources: ReadonlySet<string>;
  /** 最近一次工作区目录变化的资源刷新标记。 */
  readonly resourceRefreshVersion: number;
}

/** 移除 Markdown 图片目标成对的尖括号包裹，生成浏览器可加载地址。 */
function normalizeEditorImageSource(source: string): string {
  const trimmedSource = source.trim();

  if (trimmedSource.startsWith('<') && trimmedSource.endsWith('>')) {
    return trimmedSource.slice(1, -1).trim();
  }

  return trimmedSource;
}

/** 重新检查图片源；文件被删除时立即把当前图片块切换为失败状态。 */
function refreshEditorImageResource(
  root: HTMLElement,
  image: HTMLImageElement,
  sourceUrl: string,
  refreshToken: number
): void {
  const refreshKey = String(refreshToken);
  root.dataset.imageRefresh = refreshKey;
  void isLocalMediaResourceAvailable(sourceUrl, 'image', refreshToken).then((available) => {
    if (!root.isConnected || root.dataset.imageRefresh !== refreshKey) {
      return;
    }

    if (!available) {
      root.dataset.imageState = 'error';
      image.removeAttribute('src');
      return;
    }

    if (root.dataset.imageState === 'error' || !image.getAttribute('src')) {
      root.dataset.imageState = 'loading';
      image.removeAttribute('src');
      image.src = sourceUrl;
    }
  });
}

/**
 * 定义图片块选择状态变更效果。
 */
const setEditorImageBlockSelectionEffect = StateEffect.define<number | null>();

/**
 * 定义图片源码编辑状态变更效果。
 */
const setEditorImageBlockEditingEffect = StateEffect.define<number | null>();

/**
 * 定义图片 Widget 实际高度变更效果。
 */
const setEditorImageBlockHeightEffect = StateEffect.define<{
  readonly imageSource: string;
  readonly height: number;
}>();

/**
 * 定义图片块用户宽度变更效果。
 */
const setEditorImageBlockWidthEffect = StateEffect.define<{
  readonly imageSource: string;
  readonly width: number;
}>();

/**
 * 定义图片块标题行可见状态变更效果。
 */
const setEditorImageBlockTitleVisibilityEffect = StateEffect.define<{
  readonly imageSource: string;
  readonly visible: boolean;
}>();

/** 请求当前编辑器重新探测本地图片资源。 */
export const refreshEditorImageBlockResourcesEffect = StateEffect.define<void>();

/**
 * 保存图片 Widget 对应的尺寸观察器，便于销毁 DOM 时同步释放。
 */
const editorImageBlockResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

/** 缓存图片原生元素，切换源码模式时复用已解码的图片，避免重新加载闪烁。 */
const editorImageBlockImageCache = new Map<string, HTMLImageElement[]>();
const EDITOR_IMAGE_CACHE_MAX_ENTRIES = 32;
const EDITOR_IMAGE_CACHE_MAX_IMAGES_PER_SOURCE = 2;

function trimEditorImageBlockImageCache(): void {
  for (const [sourceUrl, images] of editorImageBlockImageCache) {
    const disconnected = images.filter(image => !image.isConnected);
    if (disconnected.length > EDITOR_IMAGE_CACHE_MAX_IMAGES_PER_SOURCE) {
      editorImageBlockImageCache.set(
        sourceUrl,
        images.filter(image => image.isConnected).concat(
          disconnected.slice(-EDITOR_IMAGE_CACHE_MAX_IMAGES_PER_SOURCE)
        )
      );
    }
  }

  trimBoundedCache(editorImageBlockImageCache, EDITOR_IMAGE_CACHE_MAX_ENTRIES);
}

interface EditorImageElementBinding {
  readonly root: HTMLElement;
  readonly view: EditorView;
  readonly resizedWidth: number | null;
}

/** 保存缓存图片当前绑定的块上下文，避免复用时重复注册加载监听。 */
const editorImageBlockImageBindings = new WeakMap<HTMLImageElement, EditorImageElementBinding>();

/** 保存每个图片块最近一次已同步的高度，避免 ResizeObserver 重复派发相同布局。 */
const editorImageBlockReportedHeights = new WeakMap<HTMLElement, number>();

/**
 * 保存图片 Widget 对应的拖拽控制器，便于销毁 DOM 时同步释放。
 */
const editorImageBlockResizeControllers = new WeakMap<HTMLElement, ImageBlockResizeController>();

/**
 * 使用 CodeMirror 官方 GutterMarker 显示图片块对应的真实文档行号。
 */
class EditorImageBlockLineNumberMarker extends GutterMarker {
  /**
   * 创建图片块行号标记。
   */
  public constructor(private readonly lineNumber: number) {
    super();
  }

  /**
   * 比较行号标记，避免行号未变化时重复创建 DOM。
   */
  public override eq(marker: GutterMarker): boolean {
    return marker instanceof EditorImageBlockLineNumberMarker
      && marker.lineNumber === this.lineNumber;
  }

  /**
   * 创建与官方行号 gutter 一致的文本节点。
   */
  public override toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.textContent = String(this.lineNumber);

    return element;
  }
}

/**
 * 在官方 Markdown 图片目标范围内将剪贴板纯文本原样写入，避免 URL 被再次包装为 Markdown。
 */
const editorImageBlockPasteExtension = Prec.highest(
  EditorView.domEventHandlers({
    paste(event, view) {
      const clipboardText = event.clipboardData?.getData('text/plain');

      if (!clipboardText) {
        return false;
      }

      const { main } = view.state.selection;
      let imageNode = syntaxTree(view.state).resolveInner(main.from, -1);

      while (imageNode.type.name !== 'Image' && imageNode.parent) {
        imageNode = imageNode.parent;
      }

      if (imageNode.type.name !== 'Image') {
        return false;
      }

      const imageSource = view.state.sliceDoc(imageNode.from, imageNode.to);
      const destinationMarkOffset = imageSource.indexOf('](');
      const destinationFrom = imageNode.from + destinationMarkOffset + 2;
      const destinationTo = imageNode.to - 1;

      if (
        destinationMarkOffset < 0
        || !imageSource.endsWith(')')
        || main.from < destinationFrom
        || main.to > destinationTo
      ) {
        return false;
      }

      event.preventDefault();
      view.dispatch({
        changes: {
          from: main.from,
          to: main.to,
          insert: clipboardText
        },
        selection: EditorSelection.cursor(main.from + clipboardText.length),
        scrollIntoView: true,
        userEvent: 'input.paste'
      });

      return true;
    }
  })
);

/**
 * 使用 CodeMirror 官方 WidgetType 承载图片 DOM 与交互。
 */
class EditorImageBlockWidget extends EditorBlockWidget {
  /**
   * 创建图片 Widget 描述对象。
   */
  public constructor(
    private readonly imageSource: string,
    private readonly imageTitle: string,
    private readonly titleVisible: boolean,
    selected: boolean,
    editing: boolean,
    measuredHeight: number | null,
    private readonly resizedWidth: number | null,
    private readonly resourceRefreshVersion: number
  ) {
    super(selected, editing, measuredHeight);
  }

  /**
   * 比较 Widget 状态，避免未变化时重新创建图片 DOM。
   */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorImageBlockWidget
      && widget.imageSource === this.imageSource
      && widget.imageTitle === this.imageTitle
      && widget.titleVisible === this.titleVisible
      // 图片实际尺寸由现有 DOM 与 ResizeObserver 管理，测量高度变化不应重建图片元素。
      && this.hasEqualEditorBlockInteractionState(widget)
      && widget.resizedWidth === this.resizedWidth
      && widget.resourceRefreshVersion === this.resourceRefreshVersion;
  }

  /**
   * 在图片地址未变化时仅更新现有 DOM 的选择与编辑状态。
   */
  public override updateDOM(
    dom: HTMLElement,
    view: EditorView,
    previousWidget: this
  ): boolean {
    if (previousWidget.imageSource !== this.imageSource) {
      return false;
    }

    const editButton = dom.querySelector<HTMLButtonElement>(
      '.cm-editor-image-block__edit'
    );
    const resizeHandle = dom.querySelector<HTMLButtonElement>(
      '.cm-editor-image-block__resize-handle'
    );
    const titleToggleButton = dom.querySelector<HTMLButtonElement>(
      '.cm-editor-image-block__title-toggle'
    );
    const titleToggleIcon = dom.querySelector<HTMLElement>(
      '.cm-editor-image-block__title-toggle-icon'
    );
    const titleElement = dom.querySelector<HTMLElement>(
      '.cm-editor-image-block__title'
    );
    const image = dom.querySelector<HTMLImageElement>(
      '.cm-editor-image-block__image'
    );

    if (
      !editButton
      || !resizeHandle
      || !titleToggleButton
      || !titleToggleIcon
      || !titleElement
      || !image
    ) {
      return false;
    }

    applyEditorBlockVisualState(dom, this.selected, this.editing);
    editButton.setAttribute('aria-pressed', String(this.editing));
    editButton.setAttribute('aria-label', this.editing ? '关闭源码模式' : '编辑图片源码');
    editButton.tabIndex = this.selected || this.editing ? 0 : -1;
    resizeHandle.tabIndex = this.selected || this.editing ? 0 : -1;
    titleToggleButton.hidden = !this.imageTitle;
    titleToggleButton.tabIndex = this.imageTitle && (this.selected || this.editing) ? 0 : -1;
    titleToggleButton.setAttribute('aria-label', this.titleVisible ? '隐藏图片标题' : '显示图片标题');
    titleToggleButton.setAttribute('aria-pressed', String(this.titleVisible));
    titleToggleIcon.innerHTML = this.titleVisible ? eyeCloseIcon : eyeIcon;
    titleElement.textContent = this.imageTitle;
    titleElement.hidden = !this.titleVisible;

    if (previousWidget.resourceRefreshVersion !== this.resourceRefreshVersion) {
      refreshEditorImageResource(
        dom,
        image,
        resolveMediaSourceUrl(
          this.imageSource,
          view.state.facet(editorImageBlockCurrentFilePath)()
        ),
        this.resourceRefreshVersion
      );
    }

    if (dom.dataset.resizeState === 'resizing') {
      return true;
    }

    dom.style.width = this.resizedWidth === null ? '' : `${this.resizedWidth}px`;
    dom.dataset.resizeState = this.resizedWidth === null ? 'idle' : 'resized';

    return true;
  }

  /**
   * 创建图片、加载失败提示与源码编辑按钮。
   */
  public override toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('figure');
    const sourceUrl = resolveMediaSourceUrl(
      this.imageSource,
      view.state.facet(editorImageBlockCurrentFilePath)()
    );
    const cachedImages = editorImageBlockImageCache.get(sourceUrl) ?? [];
    const cachedImage = cachedImages.find((candidate) => !candidate.isConnected);
    const image = cachedImage ?? document.createElement('img');
    const errorMessage = document.createElement('span');
    const editButton = document.createElement('button');
    const editIcon = document.createElement('span');
    const titleToggleButton = document.createElement('button');
    const titleToggleIcon = document.createElement('span');
    const actions = createEditorBlockActionsElement();
    const titleElement = document.createElement('figcaption');
    const resizeHandle = document.createElement('button');

    root.className = 'cm-editor-image-block';
    applyEditorBlockVisualState(root, this.selected, this.editing);
    root.dataset.imageState = 'loading';
    root.dataset.resizeState = this.resizedWidth === null ? 'idle' : 'resized';
    root.contentEditable = 'false';
    root.style.width = this.resizedWidth === null ? '' : `${this.resizedWidth}px`;

    image.className = 'cm-editor-image-block__image';
    image.alt = '';
    image.decoding = 'async';
    image.loading = 'lazy';
    image.draggable = false;

    errorMessage.className = 'cm-editor-image-block__error';
    errorMessage.textContent = '图片加载失败';

    editButton.className = 'cm-editor-image-block__edit';
    editButton.type = 'button';
    editButton.tabIndex = this.selected || this.editing ? 0 : -1;
    editButton.setAttribute('aria-label', this.editing ? '关闭源码模式' : '编辑图片源码');
    editButton.setAttribute('aria-pressed', String(this.editing));

    editIcon.className = 'cm-editor-image-block__edit-icon';
    editIcon.innerHTML = editorIcon;
    editButton.append(editIcon);

    titleToggleButton.className = 'cm-editor-image-block__title-toggle';
    titleToggleButton.type = 'button';
    titleToggleButton.hidden = !this.imageTitle;
    titleToggleButton.tabIndex = this.imageTitle && (this.selected || this.editing) ? 0 : -1;
    titleToggleButton.setAttribute('aria-label', this.titleVisible ? '隐藏图片标题' : '显示图片标题');
    titleToggleButton.setAttribute('aria-pressed', String(this.titleVisible));

    titleToggleIcon.className = 'cm-editor-image-block__title-toggle-icon';
    titleToggleIcon.innerHTML = this.titleVisible ? eyeCloseIcon : eyeIcon;
    titleToggleButton.append(titleToggleIcon);
    actions.classList.add('cm-editor-image-block__actions');
    actions.append(titleToggleButton, editButton);

    titleElement.className = 'cm-editor-image-block__title';
    titleElement.textContent = this.imageTitle;
    titleElement.hidden = !this.titleVisible;

    resizeHandle.className = 'cm-editor-image-block__resize-handle';
    resizeHandle.type = 'button';
    resizeHandle.tabIndex = this.selected || this.editing ? 0 : -1;
    resizeHandle.setAttribute('aria-label', '拖拽调整图片大小');

    editorImageBlockImageBindings.set(image, {
      root,
      view,
      resizedWidth: this.resizedWidth
    });
    if (!cachedImage) {
      image.addEventListener('load', () => {
        const binding = editorImageBlockImageBindings.get(image);
        if (!binding || !binding.root.isConnected) return;

        binding.root.dataset.imageState = 'loaded';
        if (
          binding.resizedWidth !== null
          && image.naturalWidth > 0
          && image.naturalHeight > 0
        ) {
          binding.root.style.height = `${binding.resizedWidth * image.naturalHeight / image.naturalWidth}px`;
          binding.view.requestMeasure();
        }
      });
      image.addEventListener('error', () => {
        const binding = editorImageBlockImageBindings.get(image);
        if (binding?.root.isConnected) {
          binding.root.dataset.imageState = 'error';
        }
      });
    }
    root.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const widgetPosition = view.posAtDOM(root);
      const sourceLine = view.state.doc.lineAt(widgetPosition);

      view.dispatch({
        selection: EditorSelection.cursor(sourceLine.to),
        effects: setEditorImageBlockSelectionEffect.of(sourceLine.from),
        userEvent: 'select'
      });
      view.focus();
    });
    root.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    editButton.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    });
    editButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const widgetPosition = view.posAtDOM(root);
      const sourceLine = view.state.doc.lineAt(widgetPosition);
      const isEditing = view.state.field(editorImageBlockStateField).editingLineFrom === sourceLine.from;

      view.dispatch({
        selection: EditorSelection.cursor(sourceLine.to),
        effects: setEditorImageBlockEditingEffect.of(isEditing ? null : sourceLine.from),
        userEvent: 'select'
      });
      view.focus();
    });
    titleToggleButton.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    });
    titleToggleButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        effects: setEditorImageBlockTitleVisibilityEffect.of({
          imageSource: this.imageSource,
          visible: titleToggleButton.getAttribute('aria-pressed') !== 'true'
        })
      });
    });

    root.append(
      image,
      errorMessage,
      titleElement,
      actions,
      resizeHandle
    );
    if (!cachedImages.includes(image)) {
      cachedImages.push(image);
      editorImageBlockImageCache.set(sourceUrl, cachedImages);
      trimEditorImageBlockImageCache();
    }
    if (image.getAttribute('src') !== sourceUrl) {
      image.src = sourceUrl;
    }
    if (image.getAttribute('src') && image.complete) {
      root.dataset.imageState = image.naturalWidth > 0 ? 'loaded' : 'error';
      if (
        image.naturalWidth > 0
        && image.naturalHeight > 0
        && this.resizedWidth !== null
      ) {
        root.style.height = `${this.resizedWidth * image.naturalHeight / image.naturalWidth}px`;
      }
    }

    if (cachedImage || this.resourceRefreshVersion > 0) {
      refreshEditorImageResource(root, image, sourceUrl, this.resourceRefreshVersion);
    }

    const resizeController = createImageBlockResizeController({
      view,
      root,
      image,
      handle: resizeHandle,
      minWidth: EDITOR_IMAGE_BLOCK_MIN_WIDTH,
      onResizeEnd: ({ width, height }) => {
        view.dispatch({
          effects: [
            setEditorImageBlockWidthEffect.of({
              imageSource: this.imageSource,
              width
            }),
            setEditorImageBlockHeightEffect.of({
              imageSource: this.imageSource,
              height
            })
          ]
        });
      }
    });

    let pendingHeight = 0;
    let heightSyncFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      // 缩放过程中只保留 DOM 临时尺寸，避免每一帧重建图片 Widget 造成闪烁。
      if (root.dataset.resizeState === 'resizing') {
        return;
      }

      const height = Math.ceil(root.getBoundingClientRect().height);

      if (height <= 0 || editorImageBlockReportedHeights.get(root) === height) {
        return;
      }

      pendingHeight = height;
      if (heightSyncFrame !== 0) return;

      heightSyncFrame = requestAnimationFrame(() => {
        heightSyncFrame = 0;
        if (!root.isConnected || pendingHeight <= 0) return;

        const nextHeight = pendingHeight;
        pendingHeight = 0;
        if (editorImageBlockReportedHeights.get(root) === nextHeight) return;

        editorImageBlockReportedHeights.set(root, nextHeight);
        view.dispatch({
          effects: setEditorImageBlockHeightEffect.of({
            imageSource: this.imageSource,
            height: nextHeight
          })
        });
      });
    });

    resizeObserver.observe(root);
    editorImageBlockResizeObservers.set(root, resizeObserver);
    editorImageBlockResizeControllers.set(root, resizeController);

    return root;
  }

  /**
   * 销毁图片 Widget 时释放尺寸观察器。
   */
  public override destroy(dom: HTMLElement): void {
    editorImageBlockResizeObservers.get(dom)?.disconnect();
    editorImageBlockResizeObservers.delete(dom);
    editorImageBlockReportedHeights.delete(dom);
    editorImageBlockResizeControllers.get(dom)?.destroy();
    editorImageBlockResizeControllers.delete(dom);
  }

  /**
   * 让图片 Widget 自行处理鼠标事件，阻止官方编辑器将点击解释为源码光标位置。
   */
  public override ignoreEvent(event: Event): boolean {
    return event.type === 'mousedown'
      || event.type === 'click'
      || event.type === 'dblclick'
      || event.type.startsWith('pointer');
  }
}

/**
 * 使用 CodeMirror 官方行号 Widget 标记为非编辑态图片块恢复真实行号。
 */
const editorImageBlockLineNumberExtension = lineNumberWidgetMarker.of((
  view: EditorView,
  widget: WidgetType,
  block: BlockInfo
) => {
  if (
    !(widget instanceof EditorImageBlockWidget)
    || !widget.shouldShowBlockLineNumber()
  ) {
    return null;
  }

  return new EditorImageBlockLineNumberMarker(
    view.state.doc.lineAt(block.from).number
  );
});

/**
 * 使用官方 Markdown 语法树收集独立行且 URL 非空的图片节点。
 */
function collectEditorImageBlockMatches(
  state: EditorState
): EditorImageBlockMatch[] {
  const matches: EditorImageBlockMatch[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.type.name !== 'Image') {
        return;
      }

      const line = state.doc.lineAt(node.from);
      const urlNode = node.node.getChild('URL');
      const titleNode = node.node.getChild('LinkTitle');

      if (
        node.from !== line.from
        || node.to !== line.to
        || !urlNode
      ) {
        return false;
      }

      const imageSource = normalizeEditorImageSource(
        state.sliceDoc(urlNode.from, urlNode.to)
      );
      const rawImageTitle = titleNode
        ? state.sliceDoc(titleNode.from, titleNode.to).trim()
        : '';
      const imageTitle = rawImageTitle.length >= 2
        ? rawImageTitle.slice(1, -1)
        : '';

      if (imageSource) {
        matches.push({
          from: node.from,
          to: node.to,
          imageSource,
          imageTitle
        });
      }

      return false;
    }
  });

  return matches;
}

/**
 * 根据官方语法树节点构建图片 Widget、源码隐藏与交互状态。
 */
function buildEditorImageBlockState(
  state: EditorState,
  matches: readonly EditorImageBlockMatch[],
  renderedLineFroms: readonly number[],
  selectedLineFrom: number | null,
  editingLineFrom: number | null,
  measuredHeights: ReadonlyMap<string, number>,
  resizedWidths: ReadonlyMap<string, number>,
  visibleTitleSources: ReadonlySet<string>,
  resourceRefreshVersion: number
): EditorImageBlockState {
  const decorationRanges: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const renderedLineFromSet = new Set(renderedLineFroms);
  const nextRenderedLineFroms: number[] = [];
  let hasSelectedLine = false;
  let hasEditingLine = false;

  matches.forEach((match) => {
    const editing = editingLineFrom === match.from;
    const selected = editing || selectedLineFrom === match.from;
    const rendered = renderedLineFromSet.has(match.from);

    if (
      !rendered
      && !selected
      && doesSelectionTouchEditorBlock(state, match)
    ) {
      return;
    }

    const widget = new EditorImageBlockWidget(
      match.imageSource,
      match.imageTitle,
      visibleTitleSources.has(match.imageSource),
      selected,
      editing,
      measuredHeights.get(match.imageSource) ?? null,
      resizedWidths.get(match.imageSource) ?? null,
      resourceRefreshVersion
    );
    const imageWidgetDecoration = Decoration.widget({
      widget,
      side: 1,
      block: true
    }).range(match.to);
    nextRenderedLineFroms.push(match.from);

    if (selected) {
      hasSelectedLine = true;
    }

    if (editing) {
      hasEditingLine = true;
      decorationRanges.push(imageWidgetDecoration);
      return;
    }

    const imageBlockDecoration = createEditorBlockDecoration(state, match, widget);

    decorationRanges.push(imageBlockDecoration);
    // Keep the visual replacement's trailing newline so block spacing remains
    // stable, but leave that newline outside the atomic range. The empty line
    // after an image must be able to display the document caret.
    const sourceLine = state.doc.lineAt(match.from);
    atomicRanges.push(Decoration.mark({}).range(sourceLine.from, sourceLine.to));
  });

  return {
    decorations: Decoration.set(decorationRanges, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    renderedLineFroms: nextRenderedLineFroms,
    selectedLineFrom: hasSelectedLine
      ? editingLineFrom ?? selectedLineFrom
      : null,
    editingLineFrom: hasEditingLine ? editingLineFrom : null,
    measuredHeights,
    resizedWidths,
    visibleTitleSources,
    resourceRefreshVersion
  };
}

/**
 * 使用 CodeMirror 官方 StateField 同步图片装饰与交互状态。
 */
const editorImageBlockStateField = StateField.define<EditorImageBlockState>({
  create(state) {
    const matches = collectEditorImageBlockMatches(state);

    return buildEditorImageBlockState(
      state,
      matches,
      matches.map((match) => match.from),
      null,
      null,
      new Map<string, number>(),
      new Map<string, number>(),
      new Set<string>(),
      0
    );
  },
  update(blockState, transaction) {
    const selectionChanged = !transaction.startState.selection.eq(
      transaction.state.selection
    );
    const renderedLineFroms = transaction.docChanged
      ? blockState.renderedLineFroms.map((lineFrom) => (
          transaction.changes.mapPos(lineFrom, 1)
        ))
      : blockState.renderedLineFroms;
    let selectedLineFrom = blockState.selectedLineFrom;
    let editingLineFrom = blockState.editingLineFrom;
    const measuredHeights = new Map(blockState.measuredHeights);
    const resizedWidths = new Map(blockState.resizedWidths);
    const visibleTitleSources = new Set(blockState.visibleTitleSources);
    let resourceRefreshVersion = blockState.resourceRefreshVersion;
    let selectionInteractionChanged = false;
    let editingInteractionChanged = false;

    if (transaction.docChanged) {
      selectedLineFrom = selectedLineFrom === null
        ? null
        : transaction.changes.mapPos(selectedLineFrom, 1);
      editingLineFrom = editingLineFrom === null
        ? null
        : transaction.changes.mapPos(editingLineFrom, 1);
    }

    transaction.effects.forEach((effect) => {
      if (effect.is(setEditorImageBlockSelectionEffect)) {
        selectedLineFrom = effect.value;
        selectionInteractionChanged = true;
        return;
      }

      if (effect.is(refreshEditorImageBlockResourcesEffect)) {
        resourceRefreshVersion += 1;
        return;
      }

      if (effect.is(setEditorImageBlockEditingEffect)) {
        editingLineFrom = effect.value;
        editingInteractionChanged = true;
        return;
      }

      if (effect.is(setEditorImageBlockHeightEffect)) {
        measuredHeights.set(effect.value.imageSource, effect.value.height);
        return;
      }

      if (effect.is(setEditorImageBlockWidthEffect)) {
        resizedWidths.set(effect.value.imageSource, effect.value.width);
        return;
      }

      if (effect.is(setEditorImageBlockTitleVisibilityEffect)) {
        if (effect.value.visible) {
          visibleTitleSources.add(effect.value.imageSource);
          return;
        }

        visibleTitleSources.delete(effect.value.imageSource);
      }
    });

    if (
      !selectionInteractionChanged
      && selectedLineFrom !== null
      && (transaction.docChanged || selectionChanged)
    ) {
      selectedLineFrom = resolveTrackedEditorBlockLineFrom(
        transaction.state,
        selectedLineFrom
      );
    }

    if (
      !editingInteractionChanged
      && editingLineFrom !== null
      && (transaction.docChanged || selectionChanged)
    ) {
      editingLineFrom = resolveTrackedEditorBlockLineFrom(
        transaction.state,
        editingLineFrom
      );
    }

    const interactionChanged = selectionInteractionChanged
      || editingInteractionChanged;
    const selectionStateChanged = selectedLineFrom !== blockState.selectedLineFrom
      || editingLineFrom !== blockState.editingLineFrom;
    const heightChanged = transaction.effects.some((effect) => (
      effect.is(setEditorImageBlockHeightEffect)
      && blockState.measuredHeights.get(effect.value.imageSource) !== effect.value.height
    ));
    const widthChanged = transaction.effects.some((effect) => (
      effect.is(setEditorImageBlockWidthEffect)
      && blockState.resizedWidths.get(effect.value.imageSource) !== effect.value.width
    ));
    const titleVisibilityChanged = transaction.effects.some((effect) => (
      effect.is(setEditorImageBlockTitleVisibilityEffect)
      && blockState.visibleTitleSources.has(effect.value.imageSource) !== effect.value.visible
    ));

    if (
      !transaction.docChanged
      && !interactionChanged
      && !selectionStateChanged
      && !heightChanged
      && !widthChanged
      && !titleVisibilityChanged
      && resourceRefreshVersion === blockState.resourceRefreshVersion
    ) {
      return blockState;
    }

    return buildEditorImageBlockState(
      transaction.state,
      collectEditorImageBlockMatches(transaction.state),
      renderedLineFroms,
      selectedLineFrom,
      editingLineFrom,
      measuredHeights,
      resizedWidths,
      visibleTitleSources,
      resourceRefreshVersion
    );
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
    ];
  }
});

/** 为文档末尾图片块补充真实可编辑空行。 */
const editorImageBlockTrailingLineExtension = createEditorBlockTrailingLineExtension(
  (state) => state.field(editorImageBlockStateField)
);

/** 图片块向上导航与行首退格保护扩展。 */
const editorImageBlockNavigationExtension = createEditorBlockNavigationExtension(
  (state) => resolveRenderedEditorBlockLineRanges(
    state,
    state.field(editorImageBlockStateField).renderedLineFroms
  ),
  (view, sourceRange) => {
    view.dispatch({
      selection: EditorSelection.cursor(sourceRange.to),
      effects: setEditorImageBlockEditingEffect.of(sourceRange.from),
      scrollIntoView: true,
      userEvent: 'select'
    });
  }
);

/**
 * 组合图片块粘贴处理与官方状态字段扩展。
 */
/** 创建带当前 Markdown 路径上下文的图片块扩展。 */
export function createEditorImageBlockExtension(
  getCurrentFilePath: () => string | undefined
): readonly import('@codemirror/state').Extension[] {
  return [
    editorImageBlockCurrentFilePath.of(getCurrentFilePath),
    editorImageBlockNavigationExtension,
    editorImageBlockPasteExtension,
    editorImageBlockLineNumberExtension,
    editorImageBlockStateField,
    editorImageBlockTrailingLineExtension
  ];
}

export const editorImageBlockExtension = createEditorImageBlockExtension(() => undefined);
