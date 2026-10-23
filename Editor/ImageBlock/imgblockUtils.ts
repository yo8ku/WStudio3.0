/**
 * 文件说明：封装图片块右下角拖拽缩放的尺寸计算、指针事件与资源释放逻辑。
 */
import type { EditorView } from '@codemirror/view';

/** 图片块拖拽缩放配置。 */
export interface ImageBlockResizeOptions {
  /** CodeMirror 编辑器实例。 */
  readonly view: EditorView;
  /** 图片块根元素。 */
  readonly root: HTMLElement;
  /** 图片块中的实际图片元素。 */
  readonly image: HTMLImageElement;
  /** 拖拽控制点。 */
  readonly handle: HTMLElement;
  /** 最小允许宽度。 */
  readonly minWidth: number;
  /** 拖拽结束后持久化最终尺寸。 */
  readonly onResizeEnd: (size: ImageBlockSize) => void;
}

/** 图片块拖拽结束后的最终尺寸。 */
export interface ImageBlockSize {
  /** 图片块宽度。 */
  readonly width: number;
  /** 图片块高度。 */
  readonly height: number;
}

/** 图片块拖拽缩放控制器。 */
export interface ImageBlockResizeController {
  /** 释放全局指针监听与控制点监听。 */
  destroy: () => void;
}

/**
 * 将图片块宽度限制在最小宽度与编辑器内容区可用宽度之间。
 */
function clampImageBlockWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(Math.max(width, Math.min(minWidth, maxWidth)), maxWidth);
}

/**
 * 创建图片块右下角指针拖拽控制器。
 */
export function createImageBlockResizeController(
  options: ImageBlockResizeOptions
): ImageBlockResizeController {
  const { view, root, image, handle, minWidth, onResizeEnd } = options;
  let activePointerId: number | null = null;
  let startClientX = 0;
  let startWidth = 0;
  let currentWidth = 0;
  let currentHeight = 0;
  let aspectRatio = 1;

  /**
   * 读取编辑器当前自定义纵向滑块的真实占用宽度。
   */
  function resolveVerticalScrollbarWidth(): number {
    const editorRoot = view.dom.closest<HTMLElement>('.code-mirror-editor');
    const scrollbar = editorRoot?.querySelector<HTMLElement>(
      '.scrollbar-vertical'
    );
    const scrollbarThumb = editorRoot?.querySelector<HTMLElement>(
      '.scrollbar-vertical__thumb'
    );

    return Math.max(
      scrollbar?.getBoundingClientRect().width ?? 0,
      scrollbarThumb?.getBoundingClientRect().width ?? 0
    );
  }

  /**
   * 读取图片块在当前编辑器内容区内允许使用的最大宽度。
   */
  function resolveMaxWidth(): number {
    const scrollRect = view.scrollDOM.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const viewportRight = Math.min(
      scrollRect.right,
      scrollRect.left + view.scrollDOM.clientWidth
    );

    return Math.max(
      1,
      viewportRight
        - rootRect.left
        - resolveVerticalScrollbarWidth()
        - handle.offsetWidth / 2
    );
  }

  /**
   * 应用拖拽过程中的即时宽度，并通知 CodeMirror 重新测量布局。
   */
  function applyWidth(width: number): void {
    currentWidth = clampImageBlockWidth(width, minWidth, resolveMaxWidth());
    currentHeight = currentWidth / aspectRatio;
    root.style.width = `${currentWidth}px`;
    root.style.height = `${currentHeight}px`;
    view.requestMeasure();
  }

  /**
   * 结束拖拽并提交最终宽度。
   */
  function finishResize(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) {
      return;
    }

    activePointerId = null;
    root.dataset.resizeState = 'resized';
    if (handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', finishResize);
    window.removeEventListener('pointercancel', finishResize);
    onResizeEnd({
      width: Math.round(currentWidth),
      height: Math.round(currentHeight)
    });
  }

  /**
   * 根据水平指针位移更新图片块宽度。
   */
  function handlePointerMove(event: PointerEvent): void {
    if (event.pointerId !== activePointerId) {
      return;
    }

    event.preventDefault();
    applyWidth(startWidth + event.clientX - startClientX);
  }

  /**
   * 启动图片块拖拽缩放。
   */
  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    activePointerId = event.pointerId;
    startClientX = event.clientX;
    startWidth = root.getBoundingClientRect().width;
    currentWidth = startWidth;
    currentHeight = root.getBoundingClientRect().height;
    aspectRatio = image.naturalWidth > 0 && image.naturalHeight > 0
      ? image.naturalWidth / image.naturalHeight
      : startWidth / Math.max(1, root.getBoundingClientRect().height);
    root.style.width = `${startWidth}px`;
    root.style.height = `${currentHeight}px`;
    root.dataset.resizeState = 'resizing';
    handle.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', finishResize);
    window.addEventListener('pointercancel', finishResize);
  }

  handle.addEventListener('pointerdown', handlePointerDown);

  return {
    /**
     * 释放拖拽控制器占用的全部事件资源。
     */
    destroy(): void {
      handle.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    }
  };
}
