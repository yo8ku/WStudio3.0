/**
 * 文件说明：通过 Tauri 向 Rust 宿主同步编辑器公开快照。
 */

import type { PluginEditorDocument } from '../../plugin/sdk';

import { nativeApi } from './native';

/** 将可能来自 Vue 响应式状态的文档快照转换为 IPC 可克隆的纯对象。 */
function toSerializableDocument(
  document: PluginEditorDocument | undefined
): PluginEditorDocument | undefined {
  if (!document) return undefined;
  return {
    path: document.path,
    content: document.content,
    ...(document.selection
      ? {
          selection: {
            start: document.selection.start,
            end: document.selection.end
          }
        }
      : {})
  };
}

/** 编辑器宿主桥接 API。 */
export const editorHostApi = {
  /** 更新插件 SDK 可读取的当前活动文本编辑器快照。 */
  setActiveDocument(
    document: PluginEditorDocument | undefined
  ): Promise<PluginEditorDocument | undefined> {
    const serializableDocument = toSerializableDocument(document);
    return nativeApi.editor.setActiveDocument(serializableDocument);
  }
};
