/**
 * 文件说明：协调媒体块异步完成布局后的 CodeMirror 光标滚动校正。
 */
import { EditorView } from '@codemirror/view';

/** 描述一次媒体拖放后尚未完成的滚动校正。 */
interface PendingEditorBlockScroll {
  /** 拖放插入完成后的光标位置。 */
  readonly position: number;
  /** 允许异步媒体布局继续触发的校正次数。 */
  remainingCorrections: number;
}

/** 描述块后光标进入视口所需的真实滚动位置。 */
interface EditorBlockFollowupScrollMeasurement {
  /** 无需滚动时为 null，否则为 scrollDOM 的目标 scrollTop。 */
  readonly targetScrollTop: number | null;
}

/** 描述媒体拖放后光标滚动校正所需的测量结果。 */
interface PendingEditorBlockScrollMeasurement {
  /** 待校正记录；失效或不存在时为 null。 */
  readonly pendingScroll: PendingEditorBlockScroll | null;
  /** 无需滚动时为 null，否则为 scrollDOM 的目标 scrollTop。 */
  readonly targetScrollTop: number | null;
}

const pendingEditorBlockScrolls = new WeakMap<EditorView, PendingEditorBlockScroll>();
const pendingEditorBlockScrollMeasureKey = {};
const editorBlockFollowupScrollMeasureKey = {};

/**
 * 记录媒体拖放后的目标光标，并预留异步媒体布局所需的滚动校正次数。
 */
export function registerPendingEditorBlockScroll(
  view: EditorView,
  position: number,
  mediaCount: number
): void {
  pendingEditorBlockScrolls.set(view, {
    position,
    remainingCorrections: Math.max(1, mediaCount * 2 + 1)
  });
}

/**
 * 在 CodeMirror 完成当前布局测量后，将视口重新校正到拖放光标位置。
 */
export function requestPendingEditorBlockScroll(view: EditorView): void {
  if (!pendingEditorBlockScrolls.has(view)) {
    return;
  }

  view.requestMeasure<PendingEditorBlockScrollMeasurement>({
    key: pendingEditorBlockScrollMeasureKey,
    read: (measuredView) => {
      const pendingScroll = pendingEditorBlockScrolls.get(measuredView);

      if (!pendingScroll) {
        return { pendingScroll: null, targetScrollTop: null };
      }

      if (measuredView.state.selection.main.head !== pendingScroll.position) {
        return { pendingScroll, targetScrollTop: null };
      }

      const cursorBlock = measuredView.lineBlockAt(pendingScroll.position);
      const viewportTop = measuredView.scrollDOM.scrollTop;
      const viewportBottom = viewportTop + measuredView.scrollDOM.clientHeight;
      let targetScrollTop: number | null = null;

      if (cursorBlock.top < viewportTop) {
        targetScrollTop = cursorBlock.top;
      } else if (cursorBlock.bottom > viewportBottom) {
        targetScrollTop = cursorBlock.bottom - measuredView.scrollDOM.clientHeight;
      }

      if (targetScrollTop !== null) {
        const maximumScrollTop = Math.max(
          0,
          measuredView.scrollDOM.scrollHeight - measuredView.scrollDOM.clientHeight
        );
        targetScrollTop = Math.min(maximumScrollTop, Math.max(0, targetScrollTop));
      }

      return { pendingScroll, targetScrollTop };
    },
    write: (measurement, measuredView) => {
      if (!measurement.pendingScroll) {
        return;
      }

      if (measuredView.state.selection.main.head !== measurement.pendingScroll.position) {
        pendingEditorBlockScrolls.delete(measuredView);
        return;
      }

      if (measurement.targetScrollTop !== null) {
        measuredView.scrollDOM.scrollTop = measurement.targetScrollTop;
      }

      measurement.pendingScroll.remainingCorrections -= 1;

      if (measurement.pendingScroll.remainingCorrections <= 0) {
        pendingEditorBlockScrolls.delete(measuredView);
      }
    }
  });
}

/**
 * 当光标位于视频块源码行之后时，在异步媒体布局完成后滚动到当前光标。
 */
export function requestEditorBlockFollowupScroll(
  view: EditorView,
  blockRoot: HTMLElement
): void {
  view.requestMeasure<EditorBlockFollowupScrollMeasurement>({
    key: editorBlockFollowupScrollMeasureKey,
    read: (measuredView) => {
      if (!blockRoot.isConnected) {
        return { targetScrollTop: null };
      }

      const blockPosition = measuredView.posAtDOM(blockRoot);
      const blockLine = measuredView.state.doc.lineAt(blockPosition);
      const selection = measuredView.state.selection;
      const cursorPosition = selection.main.head;
      const cursorLine = measuredView.state.doc.lineAt(cursorPosition);

      if (
        selection.ranges.length !== 1
        || !selection.main.empty
        || cursorLine.number <= blockLine.number
      ) {
        return { targetScrollTop: null };
      }

      const cursorBlock = measuredView.lineBlockAt(cursorPosition);
      const viewportBottom = measuredView.scrollDOM.scrollTop
        + measuredView.scrollDOM.clientHeight;

      if (cursorBlock.bottom <= viewportBottom) {
        return { targetScrollTop: null };
      }

      const maximumScrollTop = Math.max(
        0,
        measuredView.scrollDOM.scrollHeight - measuredView.scrollDOM.clientHeight
      );

      return {
        targetScrollTop: Math.min(
          maximumScrollTop,
          cursorBlock.bottom
            - measuredView.scrollDOM.clientHeight
            + measuredView.defaultLineHeight
        )
      };
    },
    write: (measurement, measuredView) => {
      if (measurement.targetScrollTop !== null) {
        measuredView.scrollDOM.scrollTop = measurement.targetScrollTop;
      }
    }
  });
}
