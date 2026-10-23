/**
 * 文件说明：统一渲染 CodeMirror 原生折叠标记与可交互块 Widget 的折叠标记。
 */
import type { EditorState, Extension } from '@codemirror/state';
import {
  codeFolding,
  foldEffect,
  foldable,
  foldedRanges,
  syntaxTree,
  unfoldEffect
} from '@codemirror/language';
import {
  type BlockInfo,
  EditorView,
  GutterMarker,
  gutter,
  type ViewUpdate,
  type WidgetType
} from '@codemirror/view';
import { editorBracketFoldExtension } from './editorBracketFoldExtension.ts';

const arrowDownIcon = '<span class="icon icon-arrow-down"></span>';
const arrowForwardIcon = '<span class="icon icon-arrow-forward"></span>';

/** 块 Widget 在统一折叠 gutter 中显示的状态。 */
export interface EditorFoldGutterBlockControl {
  /** 供事件处理识别块类型的唯一 CSS 类名。 */
  readonly className: string;
  /** 当前块是否展开。 */
  readonly expanded: boolean;
}

/** 统一折叠 gutter 的块扩展配置。 */
export interface EditorFoldGutterOptions {
  /** 判断一次视图更新是否改变了块折叠状态。 */
  readonly blockStateChanged?: (update: ViewUpdate) => boolean;
  /** 从块 Widget 解析可选折叠控制状态。 */
  readonly resolveBlockControl?: (
    widget: WidgetType,
    block: BlockInfo
  ) => EditorFoldGutterBlockControl | null;
  /** 处理块折叠图标点击。 */
  readonly toggleBlock?: (
    view: EditorView,
    block: BlockInfo,
    controlClassName: string
  ) => boolean;
}

/** CodeMirror 折叠状态使用的文档范围。 */
interface EditorFoldRange {
  readonly from: number;
  readonly to: number;
}

/** 使用项目统一字体图标渲染原生行或块 Widget 的折叠标记。 */
class EditorFoldGutterMarker extends GutterMarker {
  /** 创建折叠 gutter 标记。 */
  public constructor(
    private readonly expanded: boolean,
    private readonly controlClassName = ''
  ) {
    super();
  }

  /** 比较展开状态和块类型，避免重复创建图标 DOM。 */
  public override eq(marker: GutterMarker): boolean {
    return marker instanceof EditorFoldGutterMarker
      && marker.expanded === this.expanded
      && marker.controlClassName === this.controlClassName;
  }

  /** 创建带有可访问说明的折叠图标。 */
  public override toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = [
      'cm-fold-marker',
      this.controlClassName
    ].filter(Boolean).join(' ');
    marker.innerHTML = this.expanded ? arrowDownIcon : arrowForwardIcon;
    marker.setAttribute('aria-label', this.expanded ? '折叠' : '展开');
    return marker;
  }
}

/** 查找从指定视觉行开始的原生折叠范围。 */
function resolveFoldedRange(
  state: EditorState,
  line: BlockInfo
): EditorFoldRange | null {
  let foldedRange: EditorFoldRange | null = null;
  const searchTo = Math.min(state.doc.length, line.to + 1);

  foldedRanges(state).between(line.from, searchTo, (from, to) => {
    if (foldedRange === null && from >= line.from && from <= line.to) {
      foldedRange = { from, to };
    }
  });

  return foldedRange;
}

/** 判断普通折叠标记是否需要因语法树或折叠状态变化而重建。 */
function nativeFoldStateChanged(update: ViewUpdate): boolean {
  return foldedRanges(update.startState) !== foldedRanges(update.state)
    || syntaxTree(update.startState) !== syntaxTree(update.state);
}

/** 从折叠标记上解析块控制类名，排除所有折叠标记共用的基础类名。 */
function resolveBlockControlClassName(marker: HTMLElement): string | undefined {
  return Array.from(marker.classList).find(className => (
    className !== 'cm-fold-marker'
  ));
}

/** 判断指针坐标是否落在指定折叠标记的真实视觉区域内。 */
function isPointerInsideMarker(event: MouseEvent, marker: HTMLElement): boolean {
  const rect = marker.getBoundingClientRect();
  return event.clientX >= rect.left
    && event.clientX <= rect.right
    && event.clientY >= rect.top
    && event.clientY <= rect.bottom;
}

/**
 * 处理被块覆盖的 gutter 标记点击；普通 gutter 点击仍交给 CodeMirror 原生事件入口。
 */
function toggleCoveredBlockMarker(
  view: EditorView,
  event: MouseEvent,
  options: EditorFoldGutterOptions
): boolean {
  if (!options.toggleBlock) {
    return false;
  }

  const markers = view.scrollDOM.querySelectorAll<HTMLElement>(
    '.cm-foldGutter .cm-fold-marker'
  );
  for (const marker of markers) {
    const controlClassName = resolveBlockControlClassName(marker);
    if (!controlClassName || !isPointerInsideMarker(event, marker)) {
      continue;
    }

    const markerRect = marker.getBoundingClientRect();
    const block = view.lineBlockAtHeight(
      ((markerRect.top + markerRect.bottom) / 2) - view.documentTop
    );
    return options.toggleBlock(view, block, controlClassName);
  }

  return false;
}

/**
 * 创建单列 `.cm-foldGutter`，同时保持普通代码折叠和块 Widget 折叠能力。
 */
export function createEditorFoldGutterExtension(
  options: EditorFoldGutterOptions = {}
): Extension {
  return [
    editorBracketFoldExtension,
    // 保留箭头的占位和点击区域，鼠标进入折叠 gutter 时统一显示所有标记。
    EditorView.baseTheme({
      '.cm-foldGutter .cm-fold-marker': { opacity: '0' },
      '.cm-foldGutter:hover .cm-fold-marker': { opacity: '1' }
    }),
    gutter({
      class: 'cm-foldGutter',
      /** 为普通可折叠源码行生成原生折叠标记。 */
      lineMarker(view, line) {
        const foldedRange = resolveFoldedRange(view.state, line);
        if (foldedRange) {
          return new EditorFoldGutterMarker(false);
        }

        return foldable(view.state, line.from, line.to)
          ? new EditorFoldGutterMarker(true)
          : null;
      },
      /** 为注册了控制状态的块 Widget 生成折叠标记。 */
      widgetMarker(_view, widget, block) {
        const control = options.resolveBlockControl?.(widget, block);
        return control
          ? new EditorFoldGutterMarker(control.expanded, control.className)
          : null;
      },
      /** 保持折叠 gutter 在无标记行上的稳定宽度。 */
      initialSpacer() {
        return new EditorFoldGutterMarker(false);
      },
      lineMarkerChange(update) {
        return nativeFoldStateChanged(update)
          || options.blockStateChanged?.(update) === true;
      },
      domEventHandlers: {
        /** 优先切换块 Widget，其他行继续使用 CodeMirror 原生折叠事务。 */
        click(view, line, event) {
          const marker = event.target instanceof Element
            ? event.target.closest<HTMLElement>('.cm-fold-marker')
            : null;
          const controlClassName = marker
            ? resolveBlockControlClassName(marker)
            : undefined;

          if (
            controlClassName
            && options.toggleBlock?.(view, line, controlClassName)
          ) {
            return true;
          }

          const foldedRange = resolveFoldedRange(view.state, line);
          if (foldedRange) {
            view.dispatch({ effects: unfoldEffect.of(foldedRange) });
            return true;
          }

          const range = foldable(view.state, line.from, line.to);
          if (!range) {
            return false;
          }

          view.dispatch({ effects: foldEffect.of(range) });
          return true;
        }
      }
    }),
    EditorView.domEventHandlers({
      /** 属性块覆盖 gutter 时，依据标记的真实矩形补充块折叠命中。 */
      click(event, view) {
        return toggleCoveredBlockMarker(view, event, options);
      }
    }),
    codeFolding()
  ];
}
