/**
 * 文件说明：配置独立行视频语法使用共享播放器块能力渲染为 CodeMirror 视频 Widget。
 */
import { createEditorPlayableMediaBlockExtension } from '@editor/MediaBlock/editorPlayableMediaBlockExtension';

const editorVideoBlockOptions = {
  kind: 'video',
  label: '视频',
  loadErrorLabel: '视频加载失败',
  editSourceLabel: '编辑视频源码'
} as const;

/** Create a video block extension that can resolve workspace-relative sources. */
export function createEditorVideoBlockExtension(
  getCurrentFilePath: () => string | undefined
): readonly import('@codemirror/state').Extension[] {
  return createEditorPlayableMediaBlockExtension({
    ...editorVideoBlockOptions,
    getCurrentFilePath
  });
}

export const editorVideoBlockExtension = createEditorVideoBlockExtension(() => undefined);
