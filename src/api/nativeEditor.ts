/** Tauri editor snapshot bridge kept free of renderer path aliases for plugin runtime builds. */
import { invoke } from '@tauri-apps/api/core';
import { subscribeNativeEvent } from './nativeEvents';
import type { PluginEditorDocument } from '../../plugin/sdk';

export function isTauriEditorRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export const nativeEditorApi = {
  getActiveDocument(): Promise<PluginEditorDocument | undefined> {
    return invoke<PluginEditorDocument | undefined>('editor_get_active_document');
  },
  onDidChangeActiveDocument(listener: (document: PluginEditorDocument | undefined) => void): () => void {
    return subscribeNativeEvent('plugin:editorDocumentChanged', listener);
  }
};
