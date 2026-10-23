/** 文件说明：封装 Tauri 插件宿主能力和事件，保持插件运行时构建不依赖 Renderer 路径别名。 */
import { invoke } from '@tauri-apps/api/core';
import { subscribeNativeEvent as subscribe } from './nativeEvents';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  PluginWindow,
  PluginWindowOpenOptions,
  PluginWindowUpdateOptions,
  PluginRepository,
  PluginSettingValue,
  PluginFileEntry,
  PluginTextFile,
  PluginWriteTextOptions,
  PluginCreateDirectoryOptions,
  PluginDeleteOptions,
  PluginCopyOptions,
  PluginEditorVerticalAlignment,
  PluginNotificationOptions,
  PluginNotificationRequest,
  PluginDialogRequest,
  PluginDialogResponse
} from '../../plugin/sdk';
import type {
  IpcEventMap,
  PluginStorageReadResult,
  PluginSettingChangedEvent,
  PluginViewBoundsRequest,
  PluginViewRequest,
  WebViewerContextMenuRequest
} from '../types/ipc';
import type { PluginHostInvokeRequest, PluginHostInvokeResponse } from '../types/ipc';

export function isTauriPluginRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 将 Rust 插件命令错误映射为稳定 code，并保留原始 cause。 */
async function invokePluginCommand<T>(command: string, request: Record<string, unknown>, fallbackCode = 'PLUGIN_STORAGE_FAILED'): Promise<T> {
  try {
    return await invoke<T>(command, { request });
  } catch (cause: unknown) {
    const code = typeof cause === 'string' && /^PLUGIN_[A-Z_]+$/.test(cause)
      ? cause : fallbackCode;
    throw Object.assign(new Error(code), { name: code, code, cause });
  }
}

export const nativePluginApi = {
  /** 通过 Rust 通用网关发送现有 Renderer RPC 信封，窗口身份由宿主绑定。 */
  async invokeRenderer(envelope: {
    pluginId: string;
    request: PluginHostInvokeRequest;
    view?: { viewType: string; instanceId: string };
  }): Promise<PluginHostInvokeResponse> {
    let response: PluginHostInvokeResponse;
    try {
      response = await invoke<PluginHostInvokeResponse>('plugin_invoke_renderer', { envelope });
    } catch (cause: unknown) {
      throw Object.assign(new Error('PLUGIN_RPC_TRANSPORT_FAILED'), {
        code: 'PLUGIN_RPC_TRANSPORT_FAILED', cause
      });
    }
    if (!response || response.protocolVersion !== 1
      || response.requestId !== envelope.request.requestId || typeof response.ok !== 'boolean'
      || (!response.ok && (!response.error || typeof response.error.code !== 'string'
        || typeof response.error.message !== 'string'))) {
      throw Object.assign(new Error('PLUGIN_RPC_RESPONSE_INVALID'), { code: 'PLUGIN_RPC_RESPONSE_INVALID' });
    }
    return response;
  },
  /** 使用 Tauri 原生文件选择器返回插件包路径。 */
  async pickPluginPackagePath(): Promise<string | undefined> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'WStudio Plugin', extensions: ['wstudio-plugin'] }]
    });
    return typeof selected === 'string' ? selected : undefined;
  },
  /** 请求可信工作台显示声明式插件对话框。 */
  async requestDialog(pluginId: string, method: string, params: unknown): Promise<unknown> {
    try {
      return await invoke<unknown>('plugin_dialog_request', { request: { pluginId, method, params } });
    } catch (cause: unknown) {
      const code = typeof cause === 'string' && /^PLUGIN_[A-Z_]+$/.test(cause)
        ? cause
        : 'PLUGIN_DIALOG_FAILED';
      throw Object.assign(new Error(code), { name: code, code, cause });
    }
  },
  /** 将工作台对话框结果交还 Rust 网关。 */
  async respondDialog(response: PluginDialogResponse): Promise<boolean> {
    try {
      return await invoke<boolean>('plugin_dialog_respond', { response });
    } catch (cause: unknown) {
      const code = typeof cause === 'string' && /^PLUGIN_[A-Z_]+$/.test(cause)
        ? cause
        : 'PLUGIN_DIALOG_RESPONSE_FAILED';
      throw Object.assign(new Error(code), { name: code, code, cause });
    }
  },
  /** 读取插件私有 JSON 值，保留 null 与 undefined 的区别。 */
  getStorageValue<T>(pluginId: string, key: string): Promise<T | undefined> {
    return invokePluginCommand<PluginStorageReadResult>('plugin_storage_get', { pluginId, key })
      .then(result => result.found ? result.value as T : undefined);
  },
  /** 写入插件私有值；Rust 统一校验权限和存储配额。 */
  async setStorageValue(pluginId: string, key: string, value: unknown): Promise<void> {
    let cloned: unknown;
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error('Value is not JSON serializable.');
      cloned = JSON.parse(serialized) as unknown;
    } catch (cause: unknown) {
      throw Object.assign(new Error('PLUGIN_INVALID_ARGUMENT'), {
        name: 'PLUGIN_INVALID_ARGUMENT', code: 'PLUGIN_INVALID_ARGUMENT', cause
      });
    }
    return invokePluginCommand<void>('plugin_storage_set', { pluginId, key, value: cloned });
  },
  /** 删除插件私有 key，不存在的 key 也视为成功。 */
  deleteStorageValue(pluginId: string, key: string): Promise<void> {
    return invokePluginCommand<void>('plugin_storage_delete', { pluginId, key });
  },
  openWithDefaultApp(pluginId: string, path: string): Promise<void> {
    return invoke<void>('plugin_open_with_default_app', { request: { pluginId, path } });
  },
  revealInFileManager(pluginId: string, path: string): Promise<void> {
    return invoke<void>('plugin_reveal_in_file_manager', { request: { pluginId, path } });
  },
  listWindows(): Promise<PluginWindow[]> {
    return invoke<PluginWindow[]>('plugin_window_list');
  },
  openWindow(options: PluginWindowOpenOptions, pluginId?: string): Promise<PluginWindow> {
    return invoke<PluginWindow>('plugin_window_open', {
      request: { ...options, ...(pluginId ? { pluginId } : {}) }
    });
  },
  updateWindow(windowId: string, options: PluginWindowUpdateOptions): Promise<PluginWindow> {
    return invoke<PluginWindow>('plugin_window_update', {
      request: { windowId, ...options }
    });
  },
  focusWindow(windowId: string): Promise<void> {
    return invoke<void>('plugin_window_focus', { request: { windowId } });
  },
  closeWindow(windowId: string): Promise<void> {
    return invoke<void>('plugin_window_close', { request: { windowId } });
  },
  updateViewBounds(request: PluginViewBoundsRequest): Promise<void> {
    return invoke<void>('plugin_update_view_bounds', { request });
  },
  disposeView(request: PluginViewRequest): Promise<void> {
    return invoke<void>('plugin_dispose_view', { request });
  },
  /** 网页菜单与公开 SDK 共享 Rust 服务；保留稳定插件错误码。 */
  executeWebViewerContextMenu(request: WebViewerContextMenuRequest): Promise<boolean> {
    return invokePluginCommand<boolean>('plugin_web_viewer_context_menu', { ...request }, 'PLUGIN_WEBVIEWER_OPERATION_FAILED');
  },
  revealRange(
    pluginId: string,
    path: string,
    range: { start: number; end: number },
    verticalAlignment?: PluginEditorVerticalAlignment
  ): Promise<void> {
    return invoke<void>('plugin_editor_reveal_range', {
      request: {
        pluginId,
        path,
        range,
        ...(verticalAlignment ? { options: { verticalAlignment } } : {})
      }
    });
  },
  openEditorFile(
    pluginId: string,
    path: string,
    disposition?: 'current-group' | 'new-group'
  ): Promise<void> {
    return invoke<void>('plugin_editor_open_file', {
      request: {
        pluginId,
        path,
        ...(disposition ? { options: { disposition } } : {})
      }
    });
  },
  closeEditorTabs(pluginId: string, paths?: readonly string[]): Promise<void> {
    return invoke<void>('plugin_editor_close_tabs', {
      request: {
        pluginId,
        ...(paths ? { paths: [...paths] } : {})
      }
    });
  },
  listEntries(pluginId: string, directory?: string): Promise<PluginFileEntry[]> {
    return invoke<PluginFileEntry[]>('plugin_filesystem_list_entries', {
      request: { pluginId, ...(directory !== undefined ? { directory } : {}) }
    });
  },
  stat(pluginId: string, path: string): Promise<PluginFileEntry> {
    return invoke<PluginFileEntry>('plugin_filesystem_stat', {
      request: { pluginId, path }
    });
  },
  readText(pluginId: string, path: string): Promise<PluginTextFile> {
    return invoke<PluginTextFile>('plugin_filesystem_read_text', {
      request: { pluginId, path }
    });
  },
  writeText(pluginId: string, path: string, content: string, options: PluginWriteTextOptions): Promise<PluginTextFile> {
    return invoke<PluginTextFile>('plugin_filesystem_write_text', {
      request: { pluginId, path, content, options }
    });
  },
  createFile(pluginId: string, path: string, content?: string): Promise<PluginTextFile> {
    return invoke<PluginTextFile>('plugin_filesystem_create_file', {
      request: { pluginId, path, ...(content !== undefined ? { content } : {}) }
    });
  },
  createDirectory(pluginId: string, path: string, options?: PluginCreateDirectoryOptions): Promise<PluginFileEntry> {
    return invoke<PluginFileEntry>('plugin_filesystem_create_directory', {
      request: { pluginId, path, ...(options !== undefined ? { options } : {}) }
    });
  },
  delete(pluginId: string, path: string, options?: PluginDeleteOptions): Promise<void> {
    return invoke<void>('plugin_filesystem_delete', {
      request: { pluginId, path, ...(options !== undefined ? { options } : {}) }
    });
  },
  move(pluginId: string, sourcePath: string, destinationPath: string): Promise<PluginFileEntry> {
    return invoke<PluginFileEntry>('plugin_filesystem_move', {
      request: { pluginId, sourcePath, destinationPath }
    });
  },
  rename(pluginId: string, path: string, newName: string): Promise<PluginFileEntry> {
    return invoke<PluginFileEntry>('plugin_filesystem_rename', {
      request: { pluginId, path, newName }
    });
  },
  copy(pluginId: string, sourcePath: string, destinationPath: string, options?: PluginCopyOptions): Promise<PluginFileEntry> {
    return invoke<PluginFileEntry>('plugin_filesystem_copy', {
      request: { pluginId, sourcePath, destinationPath, ...(options !== undefined ? { options } : {}) }
    });
  },
  encrypt(pluginId: string, path: string, password: string): Promise<PluginFileEntry> {
    return invoke<PluginFileEntry>('plugin_filesystem_encrypt', {
      request: { pluginId, path, password }
    });
  },
  decrypt(pluginId: string, path: string, password: string): Promise<PluginFileEntry> {
    return invoke<PluginFileEntry>('plugin_filesystem_decrypt', {
      request: { pluginId, path, password }
    });
  },
  getSettingValue(pluginId: string, settingId: string, fieldId: string): Promise<PluginSettingValue | undefined> {
    return invoke<Record<string, string | number | boolean>>('plugin_get_settings', {
      request: { pluginId, settingId }
    }).then(values => values[fieldId] as PluginSettingValue | undefined);
  },
  showNotification(
    pluginId: string,
    message: string,
    options?: PluginNotificationOptions
  ): Promise<void> {
    return invoke<void>('plugin_show_notification', {
      request: { pluginId, message, ...(options ?? {}) }
    });
  },
  showSystemNotification(
    pluginId: string,
    message: string,
    options?: Pick<PluginNotificationOptions, 'title'>
  ): Promise<void> {
    return invoke<void>('plugin_show_system_notification', {
      request: { pluginId, message, ...(options ?? {}) }
    });
  },
  onSettingChanged(listener: (event: PluginSettingChangedEvent) => void): () => void {
    return subscribe<IpcEventMap['plugin:settingChanged']>('plugin:settingChanged', listener);
  },
  onNotificationRequested(listener: (event: PluginNotificationRequest) => void): () => void {
    return subscribe<PluginNotificationRequest>('plugin:notificationRequested', listener);
  },
  onDialogRequested(listener: (request: PluginDialogRequest) => void): () => void {
    return subscribe<PluginDialogRequest>('plugin:dialogRequested', listener);
  },
  onRepositoryChanged(listener: (repository: PluginRepository) => void): () => void {
    return subscribe<PluginRepository>('workspace:repositoryChanged', listener);
  },
  onDirectoryChanged(listener: (event: IpcEventMap['workspace:directoryChanged']) => void): () => void {
    return subscribe<IpcEventMap['workspace:directoryChanged']>('workspace:directoryChanged', listener);
  },
  onWindowChanged(listener: (windows: PluginWindow[]) => void): () => void {
    return subscribe<PluginWindow[]>('plugin:windowChanged', listener);
  },
  onWebViewerChanged(listener: (event: IpcEventMap['plugin:webViewerChanged']) => void): () => void {
    return subscribe<IpcEventMap['plugin:webViewerChanged']>('plugin:webViewerChanged', listener);
  },
  onViewOpenRequested(listener: (request: IpcEventMap['plugin:viewOpenRequested']) => void): () => void {
    return subscribe<IpcEventMap['plugin:viewOpenRequested']>('plugin:viewOpenRequested', listener);
  },
  onViewCloseRequested(listener: (request: IpcEventMap['plugin:viewCloseRequested']) => void): () => void {
    return subscribe<IpcEventMap['plugin:viewCloseRequested']>('plugin:viewCloseRequested', listener);
  }
};
