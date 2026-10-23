/**
 * 文件说明：处理拖入 CodeMirror 的本地图片、视频与音频文件，并在落点生成对应块语法。
 */
import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';

import { getDroppedFilePath, onNativeMediaDrop, type NativeMediaDropEvent } from '@/api/media';
import { workspaceApi } from '@/api/workspace';
import { resolveWorkspaceFileKind } from '../../plugin/sdk/fileTypes';
import {
  registerPendingEditorBlockScroll,
  requestPendingEditorBlockScroll
} from '@editor/Block/editorBlockScrollUtils';

interface MediaBlockInsertion {
  readonly insert: string;
  readonly selectionOffset: number;
}

/** 配置媒体拖拽导入时所需的当前 Markdown 文件路径。 */
export interface EditorMediaDropOptions {
  readonly getCurrentFilePath: () => string | undefined;
}

/**
 * 将本地媒体路径转换为对应的编辑器块语法。
 */
function createMediaBlockSource(filePath: string): string | null {
  const mediaKind = resolveWorkspaceFileKind(filePath);

  if (mediaKind === 'image') {
    return `![](<${filePath}>)`;
  }

  if (mediaKind === 'video' || mediaKind === 'audio') {
    return `![[${filePath}]]`;
  }

  return null;
}

/**
 * 根据拖入路径判断是否属于支持的图片、视频或音频类型。
 */
function isSupportedMediaPath(path: string): boolean {
  const mediaKind = resolveWorkspaceFileKind(path);
  return mediaKind === 'image' || mediaKind === 'video' || mediaKind === 'audio';
}

/**
 * 根据落点上下文为块语法补齐必要换行。
 */
function createBlockInsertion(
  view: EditorView,
  position: number,
  blockSources: readonly string[]
): MediaBlockInsertion {
  const requiresLeadingLineBreak = position > 0 && view.state.sliceDoc(position - 1, position) !== '\n';
  const hasTrailingLineBreak = position < view.state.doc.length
    && view.state.sliceDoc(position, position + 1) === '\n';
  const leadingLineBreak = requiresLeadingLineBreak ? '\n' : '';
  const blockSource = blockSources.join('\n');
  const trailingLineBreak = hasTrailingLineBreak ? '' : '\n';
  const insert = `${leadingLineBreak}${blockSource}${trailingLineBreak}`;

  return {
    insert,
    selectionOffset: insert.length + (hasTrailingLineBreak ? 1 : 0)
  };
}

/**
 * 接管本地媒体文件拖放，并在鼠标落点插入图片、视频或音频块源码。
 */
async function importDroppedMedia(
  view: EditorView,
  position: number,
  paths: readonly string[],
  currentFilePath: string,
  isCurrentTarget: () => boolean
): Promise<void> {
  const importedSources: Array<string | null> = [];
  for (const sourcePath of paths) {
    if (!isCurrentTarget()) return;
    const result = await workspaceApi.importExternalMediaFile({
      sourcePath,
      markdownFilePath: currentFilePath
    }).catch(() => undefined);

    importedSources.push(result?.status === 'copied'
      ? createMediaBlockSource(result.referencePath)
      : null);
  }
  const blockSources = importedSources.filter((source): source is string => source !== null);

  if (blockSources.length === 0 || !isCurrentTarget()) {
    return;
  }

  const insertion = createBlockInsertion(
    view,
    Math.min(position, view.state.doc.length),
    blockSources
  );
  const insertionPosition = Math.min(position, view.state.doc.length);
  const selectionPosition = insertionPosition + insertion.selectionOffset;

  view.dispatch({
    changes: {
      from: insertionPosition,
      insert: insertion.insert
    },
    selection: EditorSelection.cursor(selectionPosition),
    scrollIntoView: true,
    userEvent: 'input.drop'
  });
  registerPendingEditorBlockScroll(view, selectionPosition, blockSources.length);
  requestPendingEditorBlockScroll(view);
  view.focus();
}

/** 将 Tauri 物理像素坐标换算为当前 WebView 的 CSS 客户端坐标。 */
function getNativeDropClientPosition(
  view: EditorView,
  event: NativeMediaDropEvent
): { readonly x: number; readonly y: number } | null {
  const scale = view.dom.ownerDocument.defaultView?.devicePixelRatio || 1;
  const clientX = event.position.x / scale;
  const clientY = event.position.y / scale;
  const bounds = view.dom.getBoundingClientRect();
  const target = view.dom.ownerDocument.elementFromPoint(clientX, clientY);

  return clientX >= bounds.left
    && clientX < bounds.right
    && clientY >= bounds.top
    && clientY < bounds.bottom
    && target !== null
    && view.dom.contains(target)
    ? { x: clientX, y: clientY }
    : null;
}

/** 为当前编辑器实例接入 Tauri 原生拖拽监听，并在销毁时释放。 */
class NativeMediaDropPlugin {
  private readonly disposeDropListener: () => void;
  private disposed = false;

  constructor(
    view: EditorView,
    options: EditorMediaDropOptions
  ) {
    this.disposeDropListener = onNativeMediaDrop(event => {
      const currentFilePath = options.getCurrentFilePath();
      const clientPosition = getNativeDropClientPosition(view, event);
      const paths = event.paths.filter(isSupportedMediaPath);

      if (!currentFilePath || !clientPosition || paths.length === 0
        || this.disposed || !view.dom.isConnected || view.state.readOnly) {
        return;
      }

      const position = view.posAtCoords(clientPosition) ?? view.state.selection.main.head;
      void importDroppedMedia(view, position, paths, currentFilePath, () => (
        !this.disposed && view.dom.isConnected && !view.state.readOnly
        && options.getCurrentFilePath() === currentFilePath
      ));
    });
  }

  destroy(): void {
    this.disposed = true;
    this.disposeDropListener();
  }
}

/** 创建支持仓库内媒体导入的 CodeMirror 拖拽扩展。 */
export function createEditorMediaDropExtension(
  options: EditorMediaDropOptions
): Extension {
  return [EditorView.domEventHandlers({
    dragover(event) {
      const dataTransfer = event.dataTransfer;
      const files = Array.from(dataTransfer?.files ?? []);

      if (!dataTransfer || !options.getCurrentFilePath() || !files.some(file => isSupportedMediaPath(file.name))) {
        return false;
      }

      event.preventDefault();
      dataTransfer.dropEffect = 'copy';
      return true;
    },
    drop(event, view) {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const supportedPaths = files
        .filter(file => isSupportedMediaPath(file.name))
        .map(getDroppedFilePath)
        .filter(path => path.length > 0);
      const currentFilePath = options.getCurrentFilePath();

      if (supportedPaths.length === 0 || !currentFilePath || view.state.readOnly) {
        return false;
      }

      const position = view.posAtCoords({
        x: event.clientX,
        y: event.clientY
      }) ?? view.state.selection.main.head;
      event.preventDefault();
      event.stopPropagation();
      void importDroppedMedia(view, position, supportedPaths, currentFilePath, () => (
        view.dom.isConnected && !view.state.readOnly
        && options.getCurrentFilePath() === currentFilePath
      ));
      return true;
    }
  }), ViewPlugin.fromClass(class extends NativeMediaDropPlugin {
    constructor(view: EditorView) {
      super(view, options);
    }
  })];
}
