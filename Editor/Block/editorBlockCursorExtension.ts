/**
 * 文件说明：根据 CodeMirror 原子块替换范围统一隐藏基础块两侧的文档光标。
 */
import { StateEffect, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { resetEditorCursorGeometryVisibility } from './editorCursorVisibility';

/** 基础块光标隐藏时添加到 CodeMirror 根节点的独立状态属性。 */
export const EDITOR_BLOCK_CURSOR_HIDDEN_ATTRIBUTE = 'data-editor-block-cursor-hidden';

/** 拖拽落点位于块边界时添加到 CodeMirror 根节点的状态属性。 */
export const EDITOR_BLOCK_DROP_CURSOR_HIDDEN_ATTRIBUTE = 'data-editor-block-drop-cursor-hidden';

const setEditorBlockDropCursorHiddenEffect = StateEffect.define<boolean>();
const editorBlockDropCursorHiddenState = StateField.define<boolean>({
  create: () => false,
  update(hidden, transaction) {
    let nextHidden = transaction.docChanged ? false : hidden;

    transaction.effects.forEach((effect) => {
      if (effect.is(setEditorBlockDropCursorHiddenEffect)) {
        nextHidden = effect.value;
      }
    });

    return nextHidden;
  }
});

/**
 * 判断指定位置是否位于任意块级原子替换范围内。
 *
 * 块级替换范围的起始位置会映射到 Widget 左侧，范围内部的位置会映射到
 * Widget 内容；这些位置都不能显示文档光标。
 */
function isPositionInsideEditorBlock(
  view: EditorView,
  position: number
): boolean {
  return view.state.facet(EditorView.atomicRanges).some((resolveAtomicRanges) => {
    // 从前一个位置开始探查，保证右端点的几何边界也能检查到该范围。
    const cursor = resolveAtomicRanges(view).iter(Math.max(0, position - 1));

    while (cursor.value !== null) {
      if (position >= cursor.from && position < cursor.to) {
        return true;
      }

      if (cursor.from > position) {
        break;
      }

      cursor.next();
    }

    return false;
  });
}

/** 判断位置是否映射到了块的左右边缘，而不是块下方的普通行。 */
function isPositionAtEditorBlockEdge(
  view: EditorView,
  position: number,
  readLayout = true
): boolean {
  if (isPositionInsideEditorBlock(view, position)) {
    return true;
  }

  return view.state.facet(EditorView.atomicRanges).some((resolveAtomicRanges) => {
    const cursor = resolveAtomicRanges(view).iter(Math.max(0, position - 1));

    while (cursor.value !== null) {
      if (position === cursor.from || position === cursor.to) {
        if (!readLayout) {
          return true;
        }

        const rect = view.coordsAtPos(position);
        return rect !== null && rect.bottom - rect.top > view.defaultLineHeight;
      }

      if (cursor.from > position) {
        break;
      }

      cursor.next();
    }

    return false;
  });
}

/** 判断拖拽指针是否位于块的可视区域或其左右边界附近。 */
function isPointerAtEditorBlockEdge(view: EditorView, event: DragEvent): boolean {
  const target = event.target;
  if (target instanceof Element && target.closest('.cm-editor-block')) {
    return true;
  }

  const pointerX = event.clientX;
  const pointerY = event.clientY;
  const edgeTolerance = 12;

  return Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-editor-block')).some((block) => {
    const rect = block.getBoundingClientRect();
    return pointerY >= rect.top
      && pointerY <= rect.bottom
      && pointerX >= rect.left - edgeTolerance
      && pointerX <= rect.right + edgeTolerance;
  });
}

/** 根据 drop cursor 的实际矩形，兜底隐藏落在块左右边缘的光标。 */
function syncDropCursorVisibilityFromGeometry(view: EditorView): void {
  const cursor = view.scrollDOM.querySelector<HTMLElement>('.cm-dropCursor');
  if (!cursor) {
    return;
  }

  const cursorRect = cursor.getBoundingClientRect();
  const edgeTolerance = 12;
  const overlapsBlock = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-editor-block')).some((block) => {
    const blockRect = block.getBoundingClientRect();
    const verticallyOverlaps = cursorRect.bottom > blockRect.top
      && cursorRect.top < blockRect.bottom;
    const horizontallyAtEdge = cursorRect.left >= blockRect.left - edgeTolerance
      && cursorRect.left <= blockRect.right + edgeTolerance;
    return verticallyOverlaps && horizontallyAtEdge;
  });

  cursor.style.display = overlapsBlock ? 'none' : '';
}

/** 清理拖放光标的几何兜底样式。 */
function resetDropCursorGeometryVisibility(view: EditorView): void {
  const cursor = view.scrollDOM.querySelector<HTMLElement>('.cm-dropCursor');
  if (cursor) {
    cursor.style.display = '';
  }
}

/** 在 CodeMirror 完成布局后清理普通光标遗留样式并同步拖放光标。 */
function requestEditorBlockCursorVisibilitySync(view: EditorView): void {
  requestAnimationFrame(() => {
    resetEditorCursorGeometryVisibility(view);
    syncDropCursorVisibilityFromGeometry(view);
  });
}

/** 将拖拽期间的 drop cursor 隐藏状态同步到编辑器状态。 */
function setEditorBlockDropCursorHidden(view: EditorView, hidden: boolean): void {
  if (view.state.field(editorBlockDropCursorHiddenState) === hidden) {
    return;
  }

  view.dispatch({
    effects: setEditorBlockDropCursorHiddenEffect.of(hidden)
  });
}

/** 根据拖拽落点判断是否贴近块边界，并屏蔽对应的 drop cursor。 */
const editorBlockDropCursorEventHandlers = EditorView.domEventHandlers({
  dragover(event, view) {
    const position = view.posAtCoords({
      x: event.clientX,
      y: event.clientY
    });

    setEditorBlockDropCursorHidden(
      view,
      isPointerAtEditorBlockEdge(view, event)
        || (position !== null && isPositionAtEditorBlockEdge(view, position))
    );

    requestAnimationFrame(() => {
      syncDropCursorVisibilityFromGeometry(view);
    });
    return false;
  },
  dragleave(event, view) {
    const relatedTarget = event.relatedTarget;
    const remainsInEditor = relatedTarget instanceof Node
      && view.contentDOM.contains(relatedTarget);

    if (
      event.target === view.contentDOM
      || !remainsInEditor
    ) {
      setEditorBlockDropCursorHidden(view, false);
      resetDropCursorGeometryVisibility(view);
    }
    return false;
  },
  drop(_event, view) {
    setEditorBlockDropCursorHidden(view, false);
    resetDropCursorGeometryVisibility(view);
    return false;
  },
  dragend(_event, view) {
    setEditorBlockDropCursorHidden(view, false);
    resetDropCursorGeometryVisibility(view);
    return false;
  }
});

/** 判断当前选区的任一端点是否落在块级原子替换范围或其左右边缘。 */
function hasCursorInsideEditorBlock(view: EditorView): boolean {
  return view.state.selection.ranges.some((range) => (
    isPositionAtEditorBlockEdge(view, range.head, false)
    || isPositionAtEditorBlockEdge(view, range.anchor, false)
  ));
}

/** 同步基础块光标隐藏状态到 CodeMirror 根节点。 */
class EditorBlockCursorVisibility {
  /**
   * 创建状态同步器并立即处理初始编辑器状态。
   */
  public constructor(private readonly view: EditorView) {
    this.sync();
    requestEditorBlockCursorVisibilitySync(view);
  }

  /**
   * 在选区、文档或块状态变化后刷新光标可见性。
   */
  public update(update: ViewUpdate): void {
    if (
      !update.docChanged
      && !update.selectionSet
      && !update.geometryChanged
      && !update.transactions.some((transaction) => transaction.effects.length > 0)
    ) {
      return;
    }

    this.sync();
    requestEditorBlockCursorVisibilitySync(this.view);
  }

  /**
   * 销毁扩展时移除根节点状态属性。
   */
  public destroy(): void {
    this.view.dom.removeAttribute(EDITOR_BLOCK_CURSOR_HIDDEN_ATTRIBUTE);
    this.view.dom.removeAttribute(EDITOR_BLOCK_DROP_CURSOR_HIDDEN_ATTRIBUTE);
  }

  /**
   * 根据当前选区端点切换统一的基础块状态属性。
   */
  private sync(): void {
    if (hasCursorInsideEditorBlock(this.view)) {
      this.view.dom.setAttribute(EDITOR_BLOCK_CURSOR_HIDDEN_ATTRIBUTE, 'true');
    } else {
      this.view.dom.removeAttribute(EDITOR_BLOCK_CURSOR_HIDDEN_ATTRIBUTE);
    }

    if (this.view.state.field(editorBlockDropCursorHiddenState)) {
      this.view.dom.setAttribute(EDITOR_BLOCK_DROP_CURSOR_HIDDEN_ATTRIBUTE, 'true');
    } else {
      this.view.dom.removeAttribute(EDITOR_BLOCK_DROP_CURSOR_HIDDEN_ATTRIBUTE);
    }
  }
}

/** 基础块光标可见性扩展。 */
export const editorBlockCursorExtension = [
  editorBlockDropCursorHiddenState,
  editorBlockDropCursorEventHandlers,
  ViewPlugin.fromClass(EditorBlockCursorVisibility),
  EditorView.theme({
    '&[data-editor-block-cursor-hidden] > .cm-scroller > .cm-cursorLayer .cm-cursor, &[data-editor-block-cursor-hidden] > .cm-scroller > .cm-dropCursor': {
      display: 'none'
    },
    '&[data-editor-block-drop-cursor-hidden] > .cm-scroller > .cm-dropCursor': {
      display: 'none'
    }
  })
];
