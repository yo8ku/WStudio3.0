/**
 * 文件说明：识别 Markdown Mermaid 围栏，并在 CodeMirror 中默认渲染真实图表，支持回到源码模式。
 */
import {
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Range
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from '@codemirror/view';
import { createApp, type App as VueApp } from 'vue';

const editorCodeIcon = '<span class="icon icon-editor-code"></span>';
import { trimBoundedCache } from '@/utils/boundedCache';
const circleMinusIcon = '<span class="icon icon-circle-minus"></span>';
const fullscreenIcon = '<span class="icon icon-fullscreen"></span>';
const pluginShortcutsIcon = '<span class="icon icon-plugin-shortcuts"></span>';
import { createIconButton } from '@/components/WsIconButton/iconButton';
import { createSlider, setSliderValue } from '@/components/WsSlider/slider';
import WorkbenchHorizontalScrollbar from '@/components/scrollbar/WorkbenchHorizontalScrollbar.vue';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import { createEditorBlockNavigationExtension } from '@editor/Block/editorBlockNavigationExtension';
import type { EditorBlockSourceRange } from '@editor/Block/editorBlockTypes';
import { createEditorBlockClassName } from '@editor/Block/editorBlockSpacing';
import { EDITOR_BLOCK_ACTIONS_CLASS } from '@editor/Block/editorBlockUtils';

interface EditorMermaidBlockMatch extends EditorBlockSourceRange {
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly definition: string;
  readonly key: string;
}

interface EditorMermaidBlockState {
  readonly decorations: DecorationSet;
  readonly atomicRanges: DecorationSet;
  readonly renderedBlocks: readonly EditorBlockSourceRange[];
  readonly sourceKeys: ReadonlySet<string>;
}

const toggleEditorMermaidSourceEffect = StateEffect.define<string>();
/** 请求当前编辑器中的 Mermaid 图表按最新主题变量重新渲染。 */
export const refreshEditorMermaidThemeEffect = StateEffect.define<null>();
let mermaidRenderSequence = 0;
let configuredMermaidThemeSignature: string | null = null;
type MermaidApi = typeof import('mermaid').default;
let mermaidApiPromise: Promise<MermaidApi> | null = null;

interface MermaidRenderCacheEntry {
  readonly promise: Promise<string>;
  svg: string | null;
}

const mermaidRenderCache = new Map<string, MermaidRenderCacheEntry>();
const MERMAID_RENDER_CACHE_MAX_ENTRIES = 24;

function trimMermaidRenderCache(): void {
  trimBoundedCache(mermaidRenderCache, MERMAID_RENDER_CACHE_MAX_ENTRIES);
}

const MERMAID_DEFAULT_ZOOM = 1;
const MERMAID_MIN_ZOOM = MERMAID_DEFAULT_ZOOM;
const MERMAID_MAX_ZOOM = 2;
const MERMAID_ZOOM_STEP = 0.1;
const MERMAID_ZOOM_CHANGE_EVENT = 'wstudio-mermaid-zoom-change';
const MERMAID_ZOOMED_CLASS = 'cm-editor-mermaid-block__preview--zoomed';
const MERMAID_PANNING_CLASS = 'cm-editor-mermaid-block__preview--panning';
/** Mermaid 当前使用的 Vuetify 图标按钮视觉变体，由调用方显式选择。 */
const MERMAID_ICON_BUTTON_STYLE_CLASSES = [
  'v-btn--density-compact',
  'v-btn--size-small',
  'v-btn--variant-text',
  'rounded'
] as const;

const MERMAID_THEME_VARIABLE_SOURCES = {
  lineColor: ['--ws-mermaid-lineColor', '--ws-editor-tableBorder', '--ws-border'],
  dashedLineColor: [
    '--ws-mermaid-dashedLineColor',
    '--ws-mermaid-lineColor',
    '--ws-editor-tableBorder',
    '--ws-border'
  ],
  nodeForeground: ['--ws-mermaid-nodeForeground', '--ws-editor-foreground', '--ws-foreground'],
  blockBackground: ['--ws-mermaid-blockBackground', '--ws-editor-overlayBackground', '--ws-editor-background'],
  blockBorder: ['--ws-mermaid-blockBorder', '--ws-editor-tableBorder', '--ws-border']
} as const;

interface MermaidThemeColors {
  readonly lineColor: string;
  readonly dashedLineColor: string;
  readonly nodeForeground: string;
  readonly blockBackground: string;
  readonly blockBorder: string;
}

interface MermaidThemeState {
  readonly darkMode: boolean;
  readonly colors: MermaidThemeColors;
  readonly themeVariables: Record<string, string>;
  readonly signature: string;
}

/** 收集文档中已闭合且语言为 Mermaid 的围栏代码块。 */
export function collectEditorMermaidBlockMatches(
  state: EditorState
): readonly EditorMermaidBlockMatch[] {
  const matches: EditorMermaidBlockMatch[] = [];
  let openingLineNumber: number | null = null;
  let openingFence = '';
  let openingLanguage = '';

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);

    if (openingLineNumber === null) {
      const openingMatch = /^\s*(`{3,}|~{3,})\s*([^\s]*)\s*$/u.exec(line.text);
      if (!openingMatch) continue;

      openingLineNumber = lineNumber;
      openingFence = openingMatch[1];
      openingLanguage = openingMatch[2].toLowerCase();
      continue;
    }

    const closingPattern = new RegExp(`^\\s*${openingFence[0]}{${openingFence.length},}\\s*$`, 'u');
    if (!closingPattern.test(line.text)) continue;

    const openingLine = state.doc.line(openingLineNumber);
    const contentFrom = openingLine.to < state.doc.length ? openingLine.to + 1 : openingLine.to;
    const contentTo = Math.max(contentFrom, line.from - 1);

    if (openingLanguage === 'mermaid') {
      matches.push({
        from: openingLine.from,
        to: line.to,
        contentFrom,
        contentTo,
        definition: state.sliceDoc(contentFrom, contentTo).trim(),
        key: String(openingLine.from)
      });
    }

    openingLineNumber = null;
    openingFence = '';
    openingLanguage = '';
  }

  return matches;
}

/** 判断当前工作台主题是否为暗色外观。 */
function resolveMermaidDarkMode(): boolean {
  return document.documentElement.dataset.themeAppearance === 'dark';
}

/** 读取第一个可用的工作台 CSS 主题变量。 */
function readMermaidThemeColor(variableNames: readonly string[]): string {
  const rootStyle = getComputedStyle(document.documentElement);

  for (const variableName of variableNames) {
    const value = rootStyle.getPropertyValue(variableName).trim();
    if (value.length > 0) {
      return value;
    }
  }

  return '';
}

/** 读取 Mermaid 图表所需的工作台主题颜色。 */
function resolveMermaidThemeColors(): MermaidThemeColors {
  return {
    lineColor: readMermaidThemeColor(MERMAID_THEME_VARIABLE_SOURCES.lineColor),
    dashedLineColor: readMermaidThemeColor(MERMAID_THEME_VARIABLE_SOURCES.dashedLineColor),
    nodeForeground: readMermaidThemeColor(MERMAID_THEME_VARIABLE_SOURCES.nodeForeground),
    blockBackground: readMermaidThemeColor(MERMAID_THEME_VARIABLE_SOURCES.blockBackground),
    blockBorder: readMermaidThemeColor(MERMAID_THEME_VARIABLE_SOURCES.blockBorder)
  };
}

/** 将工作台 Mermaid 主题变量映射为 Mermaid 官方 themeVariables。 */
function resolveMermaidThemeVariables(
  colors: MermaidThemeColors
): Record<string, string> {
  const variables: Record<string, string> = {};

  if (colors.lineColor.length > 0) {
    variables.lineColor = colors.lineColor;
    variables.defaultLinkColor = colors.lineColor;
    variables.arrowheadColor = colors.lineColor;
    variables.actorLineColor = colors.lineColor;
    variables.signalColor = colors.lineColor;
  }

  if (colors.nodeForeground.length > 0) {
    variables.nodeTextColor = colors.nodeForeground;
    variables.actorTextColor = colors.nodeForeground;
    variables.signalTextColor = colors.nodeForeground;
    variables.labelTextColor = colors.nodeForeground;
    variables.loopTextColor = colors.nodeForeground;
    variables.noteTextColor = colors.nodeForeground;
  }

  if (colors.blockBackground.length > 0) {
    variables.primaryColor = colors.blockBackground;
    variables.secondaryColor = colors.blockBackground;
    variables.tertiaryColor = colors.blockBackground;
    variables.nodeBkg = colors.blockBackground;
    variables.mainBkg = colors.blockBackground;
    variables.clusterBkg = colors.blockBackground;
    variables.actorBkg = colors.blockBackground;
  }

  if (colors.blockBorder.length > 0) {
    variables.primaryBorderColor = colors.blockBorder;
    variables.secondaryBorderColor = colors.blockBorder;
    variables.tertiaryBorderColor = colors.blockBorder;
    variables.nodeBorder = colors.blockBorder;
    variables.clusterBorder = colors.blockBorder;
    variables.actorBorder = colors.blockBorder;
    variables.labelBoxBorderColor = colors.blockBorder;
    variables.activationBorderColor = colors.blockBorder;
  }

  return variables;
}

/** 解析 Mermaid 当前主题配置及其稳定签名。 */
function resolveMermaidThemeState(): MermaidThemeState {
  const darkMode = resolveMermaidDarkMode();
  const colors = resolveMermaidThemeColors();
  const themeVariables = resolveMermaidThemeVariables(colors);

  return {
    darkMode,
    colors,
    themeVariables,
    signature: JSON.stringify({ darkMode, colors, themeVariables })
  };
}

/** 按当前工作台主题初始化 Mermaid，并关闭自动扫描与交互脚本。 */
function ensureMermaidConfigured(
  mermaidApi: MermaidApi,
  themeState: MermaidThemeState
): void {
  if (configuredMermaidThemeSignature === themeState.signature) return;

  mermaidApi.initialize({
    darkMode: themeState.darkMode,
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: themeState.themeVariables
  });
  configuredMermaidThemeSignature = themeState.signature;
}

/** 按需加载 Mermaid，避免普通 Markdown 文档承担图表引擎的初始体积。 */
function loadMermaid(): Promise<MermaidApi> {
  mermaidApiPromise ??= import('mermaid').then((module) => module.default);
  return mermaidApiPromise;
}

/** 为同一 Mermaid 块、源码和主题生成稳定的渲染缓存键。 */
function createMermaidRenderCacheKey(
  blockKey: string,
  definition: string,
  themeSignature: string
): string {
  return JSON.stringify([blockKey, definition, themeSignature]);
}

/** 执行一次 Mermaid SVG 渲染，结果由调用方缓存并复用。 */
function createMermaidRenderPromise(
  definition: string,
  renderId: string,
  themeState: MermaidThemeState
): Promise<string> {
  return (async () => {
    const mermaidApi = await loadMermaid();
    ensureMermaidConfigured(mermaidApi, themeState);
    const result = await mermaidApi.render(renderId, definition);
    return result.svg;
  })();
}

/** 将已生成的 Mermaid SVG 写入预览并恢复当前缩放状态。 */
function applyRenderedMermaidSvg(
  preview: HTMLElement,
  svg: string
): void {
  preview.innerHTML = svg;
  applyMermaidZoom(preview, readMermaidZoom(preview));
  preview.dataset.renderState = 'ready';
}

/** 将 Mermaid 渲染结果写入预览容器，并将语法错误限制在当前块内。 */
async function renderMermaidDiagram(
  preview: HTMLElement,
  definition: string,
  renderId: string,
  blockKey: string,
  themeState: MermaidThemeState
): Promise<void> {
  if (definition.length === 0) {
    preview.dataset.renderState = 'error';
    preview.textContent = 'Mermaid 图表内容为空';
    return;
  }

  const cacheKey = createMermaidRenderCacheKey(
    blockKey,
    definition,
    themeState.signature
  );
  let cacheEntry = mermaidRenderCache.get(cacheKey);

  if (cacheEntry && cacheEntry.svg !== null) {
    applyRenderedMermaidSvg(preview, cacheEntry.svg);
    return;
  }

  preview.dataset.renderState = 'loading';
  preview.textContent = '正在渲染 Mermaid 图表…';

  if (!cacheEntry) {
    const promise = createMermaidRenderPromise(definition, renderId, themeState);
    const newCacheEntry: MermaidRenderCacheEntry = {
      promise,
      svg: null
    };
    cacheEntry = newCacheEntry;
    mermaidRenderCache.set(cacheKey, newCacheEntry);
    trimMermaidRenderCache();
    void promise.then((svg) => {
      newCacheEntry.svg = svg;
    }, () => {
      if (mermaidRenderCache.get(cacheKey) === newCacheEntry) {
        mermaidRenderCache.delete(cacheKey);
      }
    });
  }

  try {
    const svg = await cacheEntry.promise;
    if (!preview.isConnected) return;

    applyRenderedMermaidSvg(preview, svg);
  } catch (error) {
    if (!preview.isConnected) return;

    preview.dataset.renderState = 'error';
    preview.textContent = error instanceof Error
      ? `Mermaid 语法错误：${error.message}`
      : 'Mermaid 图表渲染失败';
  }
}

/** 读取 Mermaid 预览当前缩放比例。 */
function readMermaidZoom(preview: HTMLElement): number {
  const zoom = Number(preview.dataset.mermaidZoom);

  return Number.isFinite(zoom)
    ? Math.min(MERMAID_MAX_ZOOM, Math.max(MERMAID_MIN_ZOOM, zoom))
    : MERMAID_DEFAULT_ZOOM;
}

/** 将 Mermaid 预览缩放比例限制在支持范围内。 */
function clampMermaidZoom(zoom: number): number {
  return Math.min(MERMAID_MAX_ZOOM, Math.max(MERMAID_MIN_ZOOM, zoom));
}

/** 应用 Mermaid 图表缩放并在总览模式下恢复滚动位置。 */
function applyMermaidZoom(
  preview: HTMLElement,
  zoom: number
): void {
  const normalizedZoom = clampMermaidZoom(zoom);
  preview.dataset.mermaidZoom = String(normalizedZoom);
  preview.classList.toggle(
    MERMAID_ZOOMED_CLASS,
    normalizedZoom > MERMAID_DEFAULT_ZOOM
  );

  const svg = preview.querySelector<SVGSVGElement>('svg');
  if (svg) {
    svg.style.transform = `scale(${normalizedZoom})`;
    svg.style.transformOrigin = 'top left';
  }

  if (normalizedZoom === MERMAID_DEFAULT_ZOOM) {
    preview.scrollTo({ top: 0, left: 0 });
  }

  preview.dispatchEvent(new CustomEvent<number>(MERMAID_ZOOM_CHANGE_EVENT, {
    detail: normalizedZoom
  }));
  preview.dispatchEvent(new Event('scroll'));
}

interface MermaidPanState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startScrollLeft: number;
  readonly startScrollTop: number;
}

interface MermaidPanController {
  readonly destroy: () => void;
}

/** 为放大的 Mermaid 预览提供空格键加鼠标左键平移。 */
function createMermaidPanController(preview: HTMLElement): MermaidPanController {
  let spacePressed = false;
  let panState: MermaidPanState | null = null;

  const releasePan = (): void => {
    if (panState === null) return;

    const pointerId = panState.pointerId;
    panState = null;
    preview.classList.remove(MERMAID_PANNING_CLASS);

    if (preview.hasPointerCapture(pointerId)) {
      preview.releasePointerCapture(pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Space') return;

    spacePressed = true;
    if (preview.matches(':hover')) {
      event.preventDefault();
    }
  };

  const handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space') return;

    if (spacePressed) {
      event.preventDefault();
    }
    spacePressed = false;
    releasePan();
  };

  const handleWindowBlur = (): void => {
    spacePressed = false;
    releasePan();
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (
      event.button !== 0
      || !spacePressed
      || readMermaidZoom(preview) <= MERMAID_DEFAULT_ZOOM
    ) {
      return;
    }

    panState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: preview.scrollLeft,
      startScrollTop: preview.scrollTop
    };
    preview.setPointerCapture(event.pointerId);
    preview.classList.add(MERMAID_PANNING_CLASS);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (panState === null || event.pointerId !== panState.pointerId) return;

    preview.scrollLeft = panState.startScrollLeft - (event.clientX - panState.startX);
    preview.scrollTop = panState.startScrollTop - (event.clientY - panState.startY);
    event.preventDefault();
  };

  const handlePointerEnd = (event: PointerEvent): void => {
    if (panState?.pointerId !== event.pointerId) return;

    releasePan();
  };

  const handleDragStart = (event: DragEvent): void => {
    event.preventDefault();
  };

  const handleWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey || event.deltaY === 0) return;

    const zoomDelta = event.deltaY < 0
      ? MERMAID_ZOOM_STEP
      : -MERMAID_ZOOM_STEP;
    applyMermaidZoom(preview, readMermaidZoom(preview) + zoomDelta);
    event.preventDefault();
    event.stopPropagation();
  };

  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('keyup', handleKeyUp, true);
  window.addEventListener('blur', handleWindowBlur);
  preview.addEventListener('pointerdown', handlePointerDown);
  preview.addEventListener('pointermove', handlePointerMove);
  preview.addEventListener('pointerup', handlePointerEnd);
  preview.addEventListener('pointercancel', handlePointerEnd);
  preview.addEventListener('lostpointercapture', handlePointerEnd);
  preview.addEventListener('dragstart', handleDragStart);
  preview.addEventListener('wheel', handleWheel);

  return {
    destroy: () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleWindowBlur);
      preview.removeEventListener('pointerdown', handlePointerDown);
      preview.removeEventListener('pointermove', handlePointerMove);
      preview.removeEventListener('pointerup', handlePointerEnd);
      preview.removeEventListener('pointercancel', handlePointerEnd);
      preview.removeEventListener('lostpointercapture', handlePointerEnd);
      preview.removeEventListener('dragstart', handleDragStart);
      preview.removeEventListener('wheel', handleWheel);
      releasePan();
    }
  };
}

/** 创建带统一图标和无障碍名称的源码切换按钮。 */
function createSourceToggleButton(): HTMLButtonElement {
  return createIconButton({
    iconMarkup: editorCodeIcon,
    label: '编辑 Mermaid 源码',
    className: [
      ...MERMAID_ICON_BUTTON_STYLE_CLASSES,
      'cm-editor-mermaid-block__action',
      'cm-editor-mermaid-block__source-toggle'
    ],
    iconClassName: 'cm-editor-mermaid-block__action-icon'
  });
}

/** 创建 Mermaid 图表预览操作按钮。 */
function createMermaidDiagramActionButton(
  action: 'overview' | 'zoom-in' | 'zoom-out',
  iconMarkup: string,
  label: string
): HTMLButtonElement {
  const button = createIconButton({
    iconMarkup,
    label,
    className: [
      ...MERMAID_ICON_BUTTON_STYLE_CLASSES,
      'cm-editor-mermaid-block__action',
      'cm-editor-mermaid-block__diagram-action'
    ],
    iconClassName: 'cm-editor-mermaid-block__action-icon'
  });
  button.dataset.mermaidAction = action;
  return button;
}

/** 根据当前缩放值同步 Mermaid 缩小按钮的禁用状态。 */
function updateMermaidZoomOutButtonState(
  button: HTMLButtonElement,
  zoom: number
): void {
  const disabled = zoom <= MERMAID_MIN_ZOOM;

  button.disabled = disabled;
  button.classList.toggle('v-btn--disabled', disabled);
  button.setAttribute('aria-disabled', String(disabled));
}

/** Mermaid 图表预览操作组及其生命周期清理函数。 */
interface MermaidDiagramActions {
  readonly element: HTMLDivElement;
  readonly destroy: () => void;
}

/** 创建 Mermaid 图表预览右侧的总览、缩放按钮与通用缩放滑块。 */
function createMermaidDiagramActions(
  preview: HTMLElement
): MermaidDiagramActions {
  const actions = document.createElement('div');
  const panController = createMermaidPanController(preview);
  const zoomSlider = createSlider({
    value: MERMAID_DEFAULT_ZOOM,
    min: MERMAID_MIN_ZOOM,
    max: MERMAID_MAX_ZOOM,
    step: MERMAID_ZOOM_STEP,
    label: 'Mermaid 图表缩放',
    className: 'cm-editor-mermaid-block__zoom-slider',
    onValueChange: (value) => {
      applyMermaidZoom(preview, value);
    }
  });
  const zoomOutButton = createMermaidDiagramActionButton(
    'zoom-out',
    circleMinusIcon,
    '缩小 Mermaid 图表'
  );
  const handleZoomChange = (event: Event): void => {
    const zoomChangeEvent = event as CustomEvent<number>;
    if (typeof zoomChangeEvent.detail !== 'number') return;

    setSliderValue(zoomSlider, zoomChangeEvent.detail);
    updateMermaidZoomOutButtonState(zoomOutButton, zoomChangeEvent.detail);
  };

  actions.className = `${EDITOR_BLOCK_ACTIONS_CLASS} cm-editor-mermaid-block__diagram-actions`;
  updateMermaidZoomOutButtonState(zoomOutButton, MERMAID_DEFAULT_ZOOM);
  preview.addEventListener(MERMAID_ZOOM_CHANGE_EVENT, handleZoomChange);
  actions.append(
    createMermaidDiagramActionButton('overview', fullscreenIcon, '总览 Mermaid 图表'),
    createMermaidDiagramActionButton('zoom-in', pluginShortcutsIcon, '放大 Mermaid 图表'),
    zoomSlider,
    zoomOutButton
  );

  return {
    element: actions,
    destroy: () => {
      preview.removeEventListener(MERMAID_ZOOM_CHANGE_EVENT, handleZoomChange);
      panController.destroy();
    }
  };
}

/** Mermaid 图表预览 Widget。 */
class EditorMermaidDiagramWidget extends WidgetType {
  private readonly renderId = `wstudio-mermaid-${mermaidRenderSequence += 1}`;
  private readonly themeState = resolveMermaidThemeState();
  private readonly themeSignature = this.themeState.signature;
  private verticalScrollbarApp: VueApp<Element> | null = null;
  private horizontalScrollbarApp: VueApp<Element> | null = null;
  private destroyDiagramActions: (() => void) | null = null;

  public constructor(private readonly match: EditorMermaidBlockMatch) {
    super();
  }

  /** Mermaid 内容、源码范围与主题未变化时复用已有预览 DOM。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorMermaidDiagramWidget
      && widget.match.definition === this.match.definition
      && widget.match.from === this.match.from
      && widget.match.to === this.match.to
      && widget.themeSignature === this.themeSignature;
  }

  /** 创建图表预览、源码切换按钮和加载状态。 */
  public override toDOM(): HTMLElement {
    const root = document.createElement('section');
    const header = document.createElement('header');
    const previewShell = document.createElement('div');
    const preview = document.createElement('div');
    const verticalScrollbarHost = document.createElement('div');
    const horizontalScrollbarHost = document.createElement('div');
    const sourceToggle = createSourceToggleButton();
    const diagramActions = createMermaidDiagramActions(preview);

    root.className = createEditorBlockClassName(['cm-editor-mermaid-block'], true, true);
    root.dataset.mermaidKey = this.match.key;
    root.dataset.mermaidContentFrom = String(this.match.contentFrom);
    root.dataset.mermaidContentTo = String(this.match.contentTo);
    root.contentEditable = 'false';
    root.draggable = false;
    this.destroyDiagramActions = diagramActions.destroy;

    header.className = 'cm-editor-mermaid-block__header';

    previewShell.className = 'cm-editor-mermaid-block__preview-shell';
    preview.className = 'cm-editor-mermaid-block__preview';
    preview.draggable = false;
    preview.dataset.mermaidZoom = String(MERMAID_DEFAULT_ZOOM);
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', 'Mermaid 图表预览');
    verticalScrollbarHost.className = 'cm-editor-mermaid-block__scrollbar-vertical';
    horizontalScrollbarHost.className = 'cm-editor-mermaid-block__scrollbar-horizontal';

    diagramActions.element.append(sourceToggle);
    header.append(diagramActions.element);
    previewShell.append(preview, verticalScrollbarHost, horizontalScrollbarHost);
    root.append(header, previewShell);
    this.verticalScrollbarApp = createApp(WorkbenchVerticalScrollbar, {
      scrollerElement: preview
    });
    this.verticalScrollbarApp.mount(verticalScrollbarHost);
    this.horizontalScrollbarApp = createApp(WorkbenchHorizontalScrollbar, {
      scrollerElement: preview
    });
    this.horizontalScrollbarApp.mount(horizontalScrollbarHost);
    void renderMermaidDiagram(
      preview,
      this.match.definition,
      this.renderId,
      this.match.key,
      this.themeState
    );

    return root;
  }

  /** 销毁 Mermaid 预览时释放自定义滚动条的观察器与事件监听。 */
  public override destroy(): void {
    this.destroyDiagramActions?.();
    this.verticalScrollbarApp?.unmount();
    this.horizontalScrollbarApp?.unmount();
    this.destroyDiagramActions = null;
    this.verticalScrollbarApp = null;
    this.horizontalScrollbarApp = null;
  }

  /**
   * 隔离图表区域的鼠标事件，避免 CodeMirror 将点击解释为源码光标位置。
   *
   * 操作按钮保留 click 事件交给 Mermaid 的编辑器事件处理器，
   * 但其按下、指针和双击事件仍需要隔离，避免按钮交互先触发编辑器选区。
   */
  public override ignoreEvent(event: Event): boolean {
    if (!(event.target instanceof Element)) {
      return false;
    }

    const target = event.target;
    const isActionButton = target.closest(
      '.cm-editor-mermaid-block__source-toggle, .cm-editor-mermaid-block__diagram-action'
    ) !== null;

    if (isActionButton && event.type === 'click') {
      return false;
    }

    return event.type === 'mousedown'
      || event.type === 'click'
      || event.type === 'dblclick'
      || event.type === 'dragstart'
      || event.type.startsWith('pointer');
  }
}

/** 将源码模式块位置映射到文档变更后的新位置。 */
function mapMermaidSourceKeys(
  sourceKeys: ReadonlySet<string>,
  state: EditorState,
  changes: ChangeDesc
): Set<string> {
  const mappedKeys = new Set<string>();

  for (const key of sourceKeys) {
    const position = Number(key);
    if (!Number.isSafeInteger(position)) continue;

    const mappedPosition = changes.mapPos(position, 1);
    if (mappedPosition <= state.doc.length) {
      mappedKeys.add(String(mappedPosition));
    }
  }

  return mappedKeys;
}

/** 判断当前选区光标是否仍停留在指定 Mermaid 源码块内。 */
function isSelectionOnMermaidSourceBlock(
  state: EditorState,
  match: EditorMermaidBlockMatch
): boolean {
  return state.selection.ranges.some((range) => (
    range.head >= match.from
    && range.head <= match.to
  ));
}

/** 清理光标已经离开的 Mermaid 源码模式块。 */
function retainActiveMermaidSourceKeys(
  state: EditorState,
  sourceKeys: ReadonlySet<string>
): Set<string> {
  if (sourceKeys.size === 0) {
    return new Set();
  }

  const activeSourceKeys = new Set<string>();

  collectEditorMermaidBlockMatches(state).forEach((match) => {
    if (
      sourceKeys.has(match.key)
      && isSelectionOnMermaidSourceBlock(state, match)
    ) {
      activeSourceKeys.add(match.key);
    }
  });

  return activeSourceKeys;
}

/** 构建 Mermaid 图表替换装饰与源码模式控件。 */
function buildEditorMermaidState(
  state: EditorState,
  requestedSourceKeys: ReadonlySet<string>
): EditorMermaidBlockState {
  const decorations: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const renderedBlocks: EditorBlockSourceRange[] = [];
  const matches = collectEditorMermaidBlockMatches(state);
  const sourceKeys = new Set<string>();

  matches.forEach((match) => {
    if (requestedSourceKeys.has(match.key)) {
      sourceKeys.add(match.key);
      return;
    }

    const replacementTo = match.to < state.doc.length ? match.to + 1 : match.to;
    const replacement = Decoration.replace({
      block: true,
      inclusiveStart: true,
      inclusiveEnd: false,
      widget: new EditorMermaidDiagramWidget(match)
    }).range(match.from, replacementTo);

    decorations.push(replacement);
    atomicRanges.push(replacement);
    renderedBlocks.push({ from: match.from, to: match.to });
  });

  return {
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    renderedBlocks,
    sourceKeys
  };
}

const editorMermaidBlockStateField = StateField.define<EditorMermaidBlockState>({
  /** 初始化 Mermaid 图表装饰。 */
  create(state) {
    return buildEditorMermaidState(state, new Set());
  },

  /** 更新源码模式、源码位置与图表装饰。 */
  update(value, transaction) {
    const sourceKeys = transaction.docChanged
      ? mapMermaidSourceKeys(value.sourceKeys, transaction.state, transaction.changes)
      : new Set(value.sourceKeys);

    transaction.effects.forEach((effect) => {
      if (!effect.is(toggleEditorMermaidSourceEffect)) return;

      if (sourceKeys.has(effect.value)) {
        sourceKeys.delete(effect.value);
      } else {
        sourceKeys.add(effect.value);
      }
    });

    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    const modeChanged = transaction.effects.some((effect) => effect.is(toggleEditorMermaidSourceEffect));
    const themeChanged = transaction.effects.some((effect) => effect.is(refreshEditorMermaidThemeEffect));
    const nextSourceKeys = selectionChanged
      ? retainActiveMermaidSourceKeys(transaction.state, sourceKeys)
      : sourceKeys;

    return transaction.docChanged || selectionChanged || modeChanged || themeChanged
      ? buildEditorMermaidState(transaction.state, nextSourceKeys)
      : value;
  },

  /** 将装饰与原子范围提供给 CodeMirror 视图。 */
  provide(field) {
    return [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges)
    ];
  }
});

/** 处理图表与源码模式切换，并恢复可编辑源码选区。 */
const editorMermaidModeEventHandlers = EditorView.domEventHandlers({
  click(event, view) {
    if (event.button !== 0 || !(event.target instanceof Element)) return false;

    const diagramAction = event.target.closest<HTMLButtonElement>(
      '.cm-editor-mermaid-block__diagram-action'
    );
    if (diagramAction) {
      const diagramRoot = diagramAction.closest<HTMLElement>('[data-mermaid-key]');
      const preview = diagramRoot?.querySelector<HTMLElement>(
        '.cm-editor-mermaid-block__preview'
      );
      const action = diagramAction.dataset.mermaidAction;

      if (!preview || !action) return false;

      event.preventDefault();
      event.stopPropagation();

      const currentZoom = readMermaidZoom(preview);
      const nextZoom = action === 'overview'
        ? MERMAID_DEFAULT_ZOOM
        : action === 'zoom-in'
          ? currentZoom + MERMAID_ZOOM_STEP
          : currentZoom - MERMAID_ZOOM_STEP;

      applyMermaidZoom(preview, nextZoom);
      return true;
    }

    const button = event.target.closest<HTMLButtonElement>(
      '.cm-editor-mermaid-block__source-toggle'
    );
    if (!button) return false;

    const target = button.closest<HTMLElement>('[data-mermaid-key]');
    const key = target?.dataset.mermaidKey;
    if (!target || !key) return false;

    const match = collectEditorMermaidBlockMatches(view.state).find((item) => item.key === key);
    if (!match) return false;

    event.preventDefault();
    event.stopPropagation();

    const sourceMode = view.state.field(editorMermaidBlockStateField).sourceKeys.has(key);
    view.dispatch({
      selection: sourceMode
        ? { anchor: match.to }
        : { anchor: match.contentTo, head: match.contentFrom },
      effects: toggleEditorMermaidSourceEffect.of(key),
      scrollIntoView: true,
      userEvent: 'select'
    });
    view.focus();
    return true;
  }
});

/** 从图表下一行向上导航或退格时恢复 Mermaid 源码。 */
const editorMermaidBlockNavigationExtension = createEditorBlockNavigationExtension(
  (state) => state.field(editorMermaidBlockStateField).renderedBlocks,
  (view, sourceRange) => {
    const match = collectEditorMermaidBlockMatches(view.state)
      .find((item) => item.from === sourceRange.from);
    if (!match) return;

    view.dispatch({
      selection: { anchor: match.contentTo, head: match.contentFrom },
      effects: toggleEditorMermaidSourceEffect.of(match.key),
      scrollIntoView: true,
      userEvent: 'select'
    });
  }
);

/** Mermaid 图表渲染与源码切换扩展。 */
export const editorMermaidBlockExtension = [
  editorMermaidBlockNavigationExtension,
  editorMermaidBlockStateField,
  editorMermaidModeEventHandlers
];
