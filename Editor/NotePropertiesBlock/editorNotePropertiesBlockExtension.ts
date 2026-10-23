/**
 * 文件说明：将 Markdown Frontmatter 作为 CodeMirror 通用块渲染并管理其布局状态。
 */
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type WidgetType
} from '@codemirror/view';

import {
  createEditorMultiLineBlockDecoration
} from '@editor/Block/editorBlockState';
import { createEditorBlockClassName } from '@editor/Block/editorBlockSpacing';
import type { EditorBlockSourceRange } from '@editor/Block/editorBlockTypes';
import { EditorBlockWidget } from '@editor/Block/editorBlockWidget';
import { parseNoteDocument } from '@editor/NoteProperties/noteProperties';

/** 笔记属性块根节点类名，供编辑器事件边界与块渲染共同识别。 */
export const EDITOR_NOTE_PROPERTIES_BLOCK_CLASS = 'cm-editor-note-properties-block';

/** CodeMirror 块 DOM 与 Vue Teleport 之间的挂载协议。 */
export interface EditorNotePropertiesBlockHost {
  /** 将 Vue 属性视图挂载到当前块根节点。 */
  readonly attach: (target: HTMLElement) => void;
  /** 仅在目标仍属于当前块时解除挂载。 */
  readonly detach: (target: HTMLElement) => void;
  /** 将 CodeMirror 块展开状态同步给 Vue 属性视图。 */
  readonly setExpanded: (expanded: boolean) => void;
}

/** 创建笔记属性块扩展所需的外部配置。 */
export interface EditorNotePropertiesBlockOptions {
  /** 组件初始化时是否显示属性块。 */
  readonly initialVisible: boolean;
  /** Vue 属性视图的挂载桥接对象。 */
  readonly host: EditorNotePropertiesBlockHost;
}

/** 笔记属性块的 CodeMirror 状态数据。 */
interface EditorNotePropertiesBlockState {
  /** 隐藏 Frontmatter 源码的原子范围。 */
  readonly atomicRanges: DecorationSet;
  /** 笔记属性块的布局装饰。 */
  readonly decorations: DecorationSet;
  /** 最近一次测量得到的块高度。 */
  readonly measuredHeight: number | null;
  /** 当前 Frontmatter 的完整源码范围。 */
  readonly sourceRange: EditorBlockSourceRange | null;
  /** 当前是否显示笔记属性块。 */
  readonly visible: boolean;
  /** 当前属性块是否展开。 */
  readonly expanded: boolean;
}

/** 动态切换笔记属性块可见状态。 */
export const setEditorNotePropertiesBlockVisibilityEffect = StateEffect.define<boolean>();

/** 设置笔记属性块的展开状态。 */
export const setEditorNotePropertiesBlockExpandedEffect = StateEffect.define<boolean>();

/** 切换笔记属性块的展开状态。 */
export const toggleEditorNotePropertiesBlockExpandedEffect = StateEffect.define<null>();

/** 将块的真实高度同步回 CodeMirror 高度图。 */
const setEditorNotePropertiesBlockHeightEffect = StateEffect.define<number>();
const editorNotePropertiesBlockResizeObservers = new WeakMap<HTMLElement, ResizeObserver>();

/** 使用通用块基类承载 Vue 笔记属性视图。 */
class EditorNotePropertiesBlockWidget extends EditorBlockWidget {
  /** 创建笔记属性块 Widget。 */
  public constructor(
    private readonly host: EditorNotePropertiesBlockHost,
    private readonly expanded: boolean,
    measuredHeight: number | null
  ) {
    super(false, false, measuredHeight);
  }

  /** 比较挂载协议与通用块状态，保持属性输入组件实例稳定。 */
  public override eq(widget: WidgetType): boolean {
    return widget instanceof EditorNotePropertiesBlockWidget
      && widget.host === this.host
      && widget.expanded === this.expanded
      && this.hasEqualEditorBlockState(widget);
  }

  /** 高度状态变化时复用原 DOM，避免属性输入框失去焦点。 */
  public override updateDOM(
    dom: HTMLElement,
    _view: EditorView,
    previousWidget: this
  ): boolean {
    if (previousWidget.host !== this.host) {
      return false;
    }

    this.host.attach(dom);
    this.host.setExpanded(this.expanded);
    return true;
  }

  /** 创建笔记属性块根节点并开始观察真实高度。 */
  public override toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('section');
    root.className = createEditorBlockClassName(
      [EDITOR_NOTE_PROPERTIES_BLOCK_CLASS],
      true,
      true
    );
    root.contentEditable = 'false';
    root.setAttribute('aria-label', '笔记属性');
    this.host.attach(root);
    this.host.setExpanded(this.expanded);

    const resizeObserver = new ResizeObserver(() => {
      if (!root.isConnected) {
        return;
      }

      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height <= 0) {
        return;
      }

      view.dispatch({
        effects: setEditorNotePropertiesBlockHeightEffect.of(height)
      });
    });
    resizeObserver.observe(root);
    editorNotePropertiesBlockResizeObservers.set(root, resizeObserver);
    return root;
  }

  /** 释放高度观察器与 Vue Teleport 挂载目标。 */
  public override destroy(dom: HTMLElement): void {
    editorNotePropertiesBlockResizeObservers.get(dom)?.disconnect();
    editorNotePropertiesBlockResizeObservers.delete(dom);
    this.host.detach(dom);
  }

  /** 隔离属性控件事件，避免 CodeMirror 接管输入与菜单交互。 */
  public override ignoreEvent(): boolean {
    return true;
  }

  /** 返回 gutter 图标需要显示的块展开状态。 */
  public isExpanded(): boolean {
    return this.expanded;
  }
}

/** 解析可被属性块替换的完整 Frontmatter 多行源码范围。 */
function resolveEditorNotePropertiesSourceRange(
  state: EditorState
): EditorBlockSourceRange | null {
  const snapshot = parseNoteDocument(state.doc.toString());

  if (
    !snapshot.hasFrontmatter
    || snapshot.invalidFrontmatter
    || snapshot.bodyStart <= 0
  ) {
    return null;
  }

  return { from: 0, to: snapshot.bodyStart };
}

/** 根据文档、可见性和高度构建笔记属性块的完整状态。 */
function buildEditorNotePropertiesBlockState(
  state: EditorState,
  host: EditorNotePropertiesBlockHost,
  visible: boolean,
  expanded: boolean,
  measuredHeight: number | null
): EditorNotePropertiesBlockState {
  if (!visible) {
    return {
      atomicRanges: Decoration.none,
      decorations: Decoration.none,
      measuredHeight,
      sourceRange: null,
      visible,
      expanded
    };
  }

  const widget = new EditorNotePropertiesBlockWidget(host, expanded, measuredHeight);
  const sourceRange = resolveEditorNotePropertiesSourceRange(state);
  let blockDecoration: Range<Decoration>;

  if (sourceRange) {
    blockDecoration = createEditorMultiLineBlockDecoration(sourceRange, widget);
  } else {
    blockDecoration = Decoration.widget({
      block: true,
      side: -1,
      widget
    }).range(0);
  }

  return {
    atomicRanges: sourceRange
      ? Decoration.set([blockDecoration], true)
      : Decoration.none,
    decorations: Decoration.set([blockDecoration], true),
    measuredHeight,
    sourceRange,
    visible,
    expanded
  };
}

/** 创建独立编辑器实例使用的笔记属性块完整扩展。 */
export function createEditorNotePropertiesBlockExtension(
  options: EditorNotePropertiesBlockOptions
): Extension {
  const stateField = StateField.define<EditorNotePropertiesBlockState>({
    /** 初始化属性块源码、装饰与高度状态。 */
    create(state) {
      return buildEditorNotePropertiesBlockState(
        state,
        options.host,
        options.initialVisible,
        true,
        null
      );
    },

    /** 响应文档、可见性和真实高度变化。 */
    update(blockState, transaction) {
      let visible = blockState.visible;
      let expanded = blockState.expanded;
      let measuredHeight = blockState.measuredHeight;

      transaction.effects.forEach((effect) => {
        if (effect.is(setEditorNotePropertiesBlockVisibilityEffect)) {
          visible = effect.value;
          return;
        }

        if (effect.is(setEditorNotePropertiesBlockHeightEffect)) {
          measuredHeight = effect.value;
          return;
        }

        if (effect.is(setEditorNotePropertiesBlockExpandedEffect)) {
          expanded = effect.value;
          return;
        }

        if (effect.is(toggleEditorNotePropertiesBlockExpandedEffect)) {
          expanded = !expanded;
        }
      });

      const visibilityChanged = visible !== blockState.visible;
      const heightChanged = measuredHeight !== blockState.measuredHeight;
      const expansionChanged = expanded !== blockState.expanded;
      if (
        !transaction.docChanged
        && !visibilityChanged
        && !heightChanged
        && !expansionChanged
      ) {
        return blockState;
      }

      return buildEditorNotePropertiesBlockState(
        transaction.state,
        options.host,
        visible,
        expanded,
        measuredHeight
      );
    },

    provide(field) {
      return [
        EditorView.decorations.from(field, value => value.decorations),
        EditorView.atomicRanges.of(view => view.state.field(field).atomicRanges)
      ];
    }
  });

  return stateField;
}

/** 解析统一折叠 gutter 所需的笔记属性块展开状态。 */
export function resolveEditorNotePropertiesBlockExpanded(
  widget: WidgetType
): boolean | null {
  return widget instanceof EditorNotePropertiesBlockWidget
    ? widget.isExpanded()
    : null;
}
