/**
 * 文件说明：配置独立行音频语法使用共享播放器块能力渲染为 CodeMirror 音频 Widget。
 */
import { createEditorPlayableMediaBlockExtension } from '@editor/MediaBlock/editorPlayableMediaBlockExtension';

const editorAudioBlockOptions = {
  kind: 'audio',
  label: '音频',
  loadErrorLabel: '音频加载失败',
  editSourceLabel: '编辑音频源码'
} as const;

/** Create an audio block extension that can resolve workspace-relative sources. */
export function createEditorAudioBlockExtension(
  getCurrentFilePath: () => string | undefined
): readonly import('@codemirror/state').Extension[] {
  return createEditorPlayableMediaBlockExtension({
    ...editorAudioBlockOptions,
    getCurrentFilePath
  });
}

export const editorAudioBlockExtension = createEditorAudioBlockExtension(() => undefined);
