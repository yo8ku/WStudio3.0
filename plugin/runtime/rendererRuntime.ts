/**
 * 文件说明：在工作台渲染进程中加载插件模块，并将真实宿主 DOM 容器与公开 SDK 注入插件。
 */

import { DisposableStore } from '../sdk/disposables';
import { createIconsApi } from './icons';
import { getCorePluginStylesUrl, loadCorePluginModule } from './corePluginAssets';
import { nativeEditorApi } from '../../src/api/nativeEditor';
import { nativePluginApi } from '../../src/api/nativePlugin';
import type { PluginHostInvokeRequest, PluginStorageReadResult, PluginViewBoundsRequest, WebViewerScrollbarTheme } from '../../src/types/ipc';
import type {
  CommandsApi,
  DialogsApi,
  Disposable,
  EditorApi,
  FilesystemApi,
  LoggerApi,
  NetworkApi,
  NetworkRequestOptions,
  NotificationsApi,
  PluginFileEntry,
  PluginContext,
  PluginContributionSummary,
  PluginEntryModule,
  PluginIdentity,
  PluginSettingChangeHandler,
  PluginSettingContribution,
  PluginSettingPageDefinition,
  PluginSettingPageRegistration,
  PluginSettingPageRegistrationHandle,
  PluginSettingValue,
  PluginStatusBarContribution,
  PluginViewMountContext,
  SettingsApi,
  StatusBarApi,
  StorageApi,
  WebViewerApi,
  WebViewerTab,
  WebViewerTabSummary,
  WindowsApi,
  WorkspaceApi
} from '../sdk/types';

const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const INTERACTIVE_RPC_TIMEOUT_MS = 5 * 60 * 1_000;

interface PluginRuntimeRecord {
  contribution: PluginContributionSummary;
  module: PluginEntryModule;
  subscriptions: DisposableStore;
  commandHandlers: Map<string, (context: { signal: AbortSignal }) => void | Promise<void>>;
  styleElements: Set<HTMLLinkElement>;
}

export interface PluginViewMountOptions {
  contribution: PluginContributionSummary;
  viewType: string;
  instanceId: string;
  root: HTMLElement;
  initialUrl?: string;
}

/** 已挂载视图的生命周期句柄。 */
export interface PluginMountedView extends Disposable {}

const runtimes = new Map<string, Promise<PluginRuntimeRecord>>();
const iconsApi = createIconsApi();
let requestSequence = 0;

/** 创建插件公开错误并保留稳定错误码。 */
function createPluginError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: code, code });
}

/** 计算单次能力调用的截止时间。 */
function resolveDeadline(method: string, params: unknown): number {
  const timeout = (
    method === 'workspace.openRepository'
    || method === 'workspace.createRepository'
    || method === 'workspace.openFile'
    || method === 'workspace.moveRecentRepository'
    || method.startsWith('dialogs.')
    || (method === 'webViewer.executeAction' && typeof params === 'object' && params !== null
      && 'action' in params && params.action === 'save-to-repository')
  )
    ? INTERACTIVE_RPC_TIMEOUT_MS
    : DEFAULT_RPC_TIMEOUT_MS;
  return Date.now() + timeout;
}

/** 将公开 SDK 调用交给主进程权限网关。 */
async function invoke(
  pluginId: string,
  method: string,
  params: unknown,
  view?: { viewType?: string; instanceId?: string; runtimeId?: string }
): Promise<unknown> {
  requestSequence += 1;
  const envelope = {
    pluginId,
    request: {
      protocolVersion: 1 as const,
      requestId: `${pluginId}:${Date.now()}:${requestSequence}`,
      runtimeId: view?.runtimeId ?? '',
      method,
      params,
      deadline: resolveDeadline(method, params)
    },
    ...(view?.viewType && view.instanceId ? { view: { viewType: view.viewType, instanceId: view.instanceId } } : {})
  } satisfies { pluginId: string; request: PluginHostInvokeRequest; view?: { viewType?: string; instanceId?: string; runtimeId?: string } };
  const response = await nativePluginApi.invokeRenderer(envelope);

  if (!response) throw createPluginError('PLUGIN_BRIDGE_UNAVAILABLE', 'Plugin host bridge is unavailable.');
  if (!response.ok) {
    throw createPluginError(
      response.error?.code ?? 'PLUGIN_RPC_FAILED',
      response.error?.message ?? 'Plugin API request failed.'
    );
  }
  return response.result;
}

/** 将未知结果约束为指定 SDK 返回类型。 */
function resultAs<T>(result: unknown): T {
  return result as T;
}

/** 创建幂等释放句柄，显式释放与订阅容器回收不会重复执行原生操作。 */
function disposable(dispose: () => void): Disposable {
  let disposed = false;
  return { dispose: () => {
    if (disposed) return;
    disposed = true;
    dispose();
  } };
}

/** 将文件系统方法参数映射为稳定 RPC 对象。 */
function createFilesystemApi(pluginId: string, view?: { viewType?: string; instanceId?: string; runtimeId?: string }): FilesystemApi {
  return {
    listFiles: options => invoke(pluginId, 'filesystem.listFiles', { options }, view).then(result => resultAs<Awaited<ReturnType<FilesystemApi['listFiles']>>>(result)),
    listEntries: directory => (invoke(pluginId, 'filesystem.listEntries', { directory }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['listEntries']>>>(result))),
    readText: path => (invoke(pluginId, 'filesystem.readText', { path }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['readText']>>>(result))),
    stat: path => (invoke(pluginId, 'filesystem.stat', { path }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['stat']>>>(result))),
    writeText: (path, content, options) => (invoke(pluginId, 'filesystem.writeText', { path, content, options }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['writeText']>>>(result))),
    createFile: (path, content) => (invoke(pluginId, 'filesystem.createFile', { path, content }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['createFile']>>>(result))),
    createDirectory: (path, options) => (invoke(pluginId, 'filesystem.createDirectory', { path, options }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['createDirectory']>>>(result))),
    delete: (path, options) => (invoke(pluginId, 'filesystem.delete', { path, options }, view).then(() => undefined)),
    move: (sourcePath, destinationPath) => (invoke(pluginId, 'filesystem.move', { sourcePath, destinationPath }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['move']>>>(result))),
    rename: (path, newName) => (invoke(pluginId, 'filesystem.rename', { path, newName }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['rename']>>>(result))),
    copy: (sourcePath, destinationPath, options) => (invoke(pluginId, 'filesystem.copy', { sourcePath, destinationPath, options }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['copy']>>>(result))),
    encrypt: (path, password) => (invoke(pluginId, 'filesystem.encrypt', { path, password }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['encrypt']>>>(result))),
    decrypt: (path, password) => (invoke(pluginId, 'filesystem.decrypt', { path, password }, view)
          .then(result => resultAs<Awaited<ReturnType<FilesystemApi['decrypt']>>>(result)))
  };
}

/** 创建工作区公开 API，并将宿主仓库事件纳入当前生命周期。 */
function createWorkspaceApi(
  pluginId: string,
  subscriptions: DisposableStore,
  view?: { viewType?: string; instanceId?: string; runtimeId?: string }
): WorkspaceApi {
  return {
    getRepository: () => invoke(pluginId, 'workspace.getRepository', {}, view).then(result => resultAs<Awaited<ReturnType<WorkspaceApi['getRepository']>>>(result)),
    createRepository: () => invoke(pluginId, 'workspace.createRepository', {}, view).then(result => resultAs<Awaited<ReturnType<WorkspaceApi['createRepository']>>>(result)),
    openRepository: () => invoke(pluginId, 'workspace.openRepository', {}, view).then(result => resultAs<Awaited<ReturnType<WorkspaceApi['openRepository']>>>(result)),
    openFile: () => invoke(pluginId, 'workspace.openFile', {}, view).then(() => undefined),
    listRecentRepositories: () => invoke(pluginId, 'workspace.listRecentRepositories', {}, view).then(result => resultAs<Awaited<ReturnType<WorkspaceApi['listRecentRepositories']>>>(result)),
    openRecentRepository: id => invoke(pluginId, 'workspace.openRecentRepository', { id }, view).then(result => resultAs<Awaited<ReturnType<WorkspaceApi['openRecentRepository']>>>(result)),
    renameRecentRepository: (id, name) => invoke(pluginId, 'workspace.renameRecentRepository', { id, name }, view).then(() => undefined),
    moveRecentRepository: id => invoke(pluginId, 'workspace.moveRecentRepository', { id }, view)
      .then(result => resultAs<boolean>(result) ?? false),
    revealRecentRepository: id => invoke(pluginId, 'workspace.revealRecentRepository', { id }, view).then(() => undefined),
    removeRecentRepository: id => invoke(pluginId, 'workspace.removeRecentRepository', { id }, view).then(() => undefined),
    copyPath: (path, kind) => invoke(pluginId, 'workspace.copyPath', { path, kind }, view).then(() => undefined),
    openWithDefaultApp: path => invoke(pluginId, 'workspace.openWithDefaultApp', { path }, view).then(() => undefined),
    revealInFileManager: path => invoke(pluginId, 'workspace.revealInFileManager', { path }, view).then(() => undefined),
    onDidChange: listener => {
      const remove = nativePluginApi.onRepositoryChanged(repository => void listener(repository));
      return subscriptions.add(disposable(remove));
    },
    onDidChangeDirectory: listener => {
      const remove = nativePluginApi.onDirectoryChanged(event => void listener(event));
      return subscriptions.add(disposable(remove));
    },
    listMarkdownFiles: () => invoke(pluginId, 'workspace.listMarkdownFiles', {}, view).then(result => resultAs<Awaited<ReturnType<WorkspaceApi['listMarkdownFiles']>>>(result)),
    readMarkdownFile: path => invoke(pluginId, 'workspace.readMarkdownFile', { path }, view).then(result => resultAs<Awaited<ReturnType<WorkspaceApi['readMarkdownFile']>>>(result)),
    updateMarkdownFile: (path, expectedContent, content) => invoke(pluginId, 'workspace.updateMarkdownFile', { path, expectedContent, content }, view).then(() => undefined),
    openView: (viewType, options) => invoke(pluginId, 'workspace.openView', { viewType, options }, view).then(() => undefined),
    closeView: (viewType, instanceId) => invoke(pluginId, 'workspace.closeView', { viewType, instanceId }, view).then(() => undefined)
  };
}

/** 创建窗口公开 API，并转发宿主窗口列表变化。 */
function createWindowsApi(pluginId: string, subscriptions: DisposableStore, view?: { viewType?: string; instanceId?: string; runtimeId?: string }): WindowsApi {
  return {
    list: () => (invoke(pluginId, 'window.list', {}, view)
          .then(result => resultAs<Awaited<ReturnType<WindowsApi['list']>>>(result))),
    open: options => (invoke(pluginId, 'window.open', options ?? {}, view)
          .then(result => resultAs<Awaited<ReturnType<WindowsApi['open']>>>(result))),
    update: (windowId, options) => (invoke(pluginId, 'window.update', { windowId, ...options }, view)
          .then(result => resultAs<Awaited<ReturnType<WindowsApi['update']>>>(result))),
    focus: windowId => (invoke(pluginId, 'window.focus', { windowId }, view).then(() => undefined)),
    close: windowId => (invoke(pluginId, 'window.close', { windowId }, view).then(() => undefined)),
    onDidChange: listener => {
      const remove = nativePluginApi.onWindowChanged(windows => void listener(windows));
      return subscriptions.add(disposable(remove));
    }
  };
}

/** 创建编辑器公开 API，并将活动文档事件纳入当前生命周期。 */
function createEditorApi(
  pluginId: string,
  subscriptions: DisposableStore,
  view?: { viewType?: string; instanceId?: string; runtimeId?: string }
): EditorApi {
  return {
    getActiveDocument: () => invoke(pluginId, 'editor.getActiveDocument', {}, view)
      .then(result => resultAs<Awaited<ReturnType<EditorApi['getActiveDocument']>>>(result)),
    onDidChangeActiveDocument: listener => {
      let remove = (): void => undefined;
      let disposed = false;
      void nativeEditorApi.getActiveDocument().then(document => {
        if (!disposed) void listener(document);
      }).catch(() => undefined);
      remove = nativeEditorApi.onDidChangeActiveDocument(document => {
        void listener(document);
      });
      return subscriptions.add(disposable(() => {
        disposed = true;
        remove();
      }));
    },
    openFile: (path, options) => (invoke(pluginId, 'editor.openFile', { path, options }, view).then(() => undefined)),
    beginFileDrag: (path, title) => {
      window.dispatchEvent(new CustomEvent('wstudio:file-drag-start', { detail: { path, title } }));
    },
    updateFileDrag: (clientX, clientY) => {
      window.dispatchEvent(new CustomEvent('wstudio:file-drag-move', { detail: { clientX, clientY } }));
    },
    endFileDrag: (clientX, clientY) => {
      window.dispatchEvent(new CustomEvent('wstudio:file-drag-end', { detail: { clientX, clientY } }));
    },
    cancelFileDrag: () => {
      window.dispatchEvent(new CustomEvent('wstudio:file-drag-cancel'));
    },
    closeTab: path => (invoke(pluginId, 'editor.closeTab', { path }, view).then(() => undefined)),
    closeTabs: paths => (invoke(pluginId, 'editor.closeTabs', { paths }, view).then(() => undefined)),
    closeAllTabs: () => (invoke(pluginId, 'editor.closeAllTabs', {}, view).then(() => undefined)),
    revealRange: (path, range, options) => (invoke(
          pluginId,
          'editor.revealRange',
          { path, range, options },
          view
        ).then(() => undefined)),
    applyTextChange: (path, expectedContent, content) => invoke(pluginId, 'editor.applyTextChange', { path, expectedContent, content }, view).then(() => undefined)
  };
}

/** 创建设置公开 API，读取宿主当前定义并按插件和字段过滤事件。 */
function createSettingsApi(
  pluginId: string,
  subscriptions: DisposableStore,
  view?: { viewType?: string; instanceId?: string; runtimeId?: string }
): SettingsApi {
  return {
    registerPage: (page: PluginSettingContribution | PluginSettingPageRegistration) => {
      if (view?.viewType) {
        throw createPluginError(
          'PLUGIN_VIEW_METHOD_FORBIDDEN',
          'Settings pages must be registered during activate().'
        );
      }
      const definitions = 'getSettingDefinitions' in page
        ? page.getSettingDefinitions()
        : page.definitions ?? page.fields;
      const serializablePage: PluginSettingPageDefinition = {
        id: page.id,
        ...('title' in page && page.title !== undefined ? { title: page.title } : {}),
        ...('description' in page && page.description !== undefined
          ? { description: page.description }
          : {}),
        ...(definitions !== undefined ? { definitions } : {})
      };
      const pageId = serializablePage.id;
      const ready = invoke(pluginId, 'settings.registerPage', { page: serializablePage }, view)
        .then(() => undefined);
      void ready.catch(() => undefined);
      let disposed = false;
      const registration: PluginSettingPageRegistrationHandle = {
        ready,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          void ready
            .then(() => invoke(pluginId, 'settings.unregisterPage', { id: pageId }, view))
            .catch(() => undefined);
        }
      };
      return subscriptions.add(registration);
    },
    get: fieldId => invoke(pluginId, 'settings.get', { fieldId }, view)
      .then(result => resultAs<PluginSettingValue | undefined>(result)),
    onDidChange: (fieldId: string, handler: PluginSettingChangeHandler) => {
      const remove = (nativePluginApi.onSettingChanged)(event => {
        if (event.pluginId === pluginId && event.fieldId === fieldId) void handler(event.value);
      }) ?? (() => undefined);
      return subscriptions.add(disposable(remove));
    },
    onDidChangePage: (settingId, handler) => {
      const remove = (nativePluginApi.onSettingChanged)(event => {
        if (event.pluginId === pluginId && event.settingId === settingId) {
          void handler({
            settingId: event.settingId,
            fieldId: event.fieldId,
            value: event.value
          });
        }
      }) ?? (() => undefined);
      return subscriptions.add(disposable(remove));
    }
  };
}

/** 创建插件私有存储 API。 */
function createStorageApi(pluginId: string, view?: { viewType?: string; instanceId?: string; runtimeId?: string }): StorageApi {
  return {
    get: <T>(key: string) => invoke(pluginId, 'storage.get', { key }, view).then(result => {
      const stored = resultAs<PluginStorageReadResult>(result);
      return stored.found ? resultAs<T>(stored.value) : undefined;
    }),
    set: (key, value) => (invoke(pluginId, 'storage.set', { key, value }, view).then(() => undefined)),
    delete: key => (invoke(pluginId, 'storage.delete', { key }, view).then(() => undefined))
  };
}

/** 创建工作台通知 API。 */
function createNotificationsApi(pluginId: string, view?: { viewType?: string; instanceId?: string; runtimeId?: string }): NotificationsApi {
  return {
    show: (message, options) => (invoke(pluginId, 'notifications.show', { message, ...options }, view).then(() => undefined)),
    showSystem: (message, options) => (invoke(pluginId, 'notifications.showSystem', { message, ...options }, view).then(() => undefined))
  };
}

/** 创建声明式宿主对话框 API。 */
function createDialogsApi(pluginId: string, view?: { viewType?: string; instanceId?: string; runtimeId?: string }): DialogsApi {
  const tauriRequest = (method: string, options: unknown): Promise<unknown> =>
    invoke(pluginId, method, options, view);
  return {
    pick: options => tauriRequest('dialogs.pick', options).then(result => resultAs<string | undefined>(result)),
    repositoryManager: options => tauriRequest('dialogs.repositoryManager', options)
      .then(result => resultAs<string | undefined>(result)),
    prompt: options => tauriRequest('dialogs.prompt', options).then(result => resultAs<string | undefined>(result)),
    confirm: options => tauriRequest('dialogs.confirm', options).then(result => resultAs<boolean>(result))
  };
}

/** 读取宿主的现有滚动条颜色，避免插件局部样式改变原生网页的主题来源。 */
function readHostScrollbarTheme(): WebViewerScrollbarTheme | undefined {
  const style = getComputedStyle(document.documentElement);
  const background = style.getPropertyValue('--ws-editor-scrollbarSlider-background').trim();
  const hoverBackground = style.getPropertyValue('--ws-editor-scrollbarSlider-hoverBackground').trim();
  const activeBackground = style.getPropertyValue('--ws-editor-scrollbarSlider-activeBackground').trim();
  if (![background, hoverBackground, activeBackground].every(value =>
    value.length > 0 && value.length <= 128 && CSS.supports('color', value))) return undefined;
  return {
    background,
    hoverBackground,
    activeBackground,
    modernUiEnabled: document.querySelector('.docking-three-workspace--modern') !== null
  };
}

/** 创建视图实例作用域内的 WebViewer API。 */
function createWebViewerApi(
  pluginId: string,
  subscriptions: DisposableStore,
  view: { viewType: string; instanceId: string; runtimeId?: string }
): WebViewerApi {
  const createTab = (tabId: string): WebViewerTab => ({
    id: tabId,
    navigate: url => invoke(pluginId, 'webViewer.navigate', { tabId, url }, view).then(() => undefined),
    back: () => invoke(pluginId, 'webViewer.back', { tabId }, view).then(() => undefined),
    forward: () => invoke(pluginId, 'webViewer.forward', { tabId }, view).then(() => undefined),
    reload: () => invoke(pluginId, 'webViewer.reload', { tabId }, view).then(() => undefined),
    close: () => invoke(pluginId, 'webViewer.close', { tabId }, view).then(() => undefined),
    executeAction: action => invoke(pluginId, 'webViewer.executeAction', { tabId, action }, view)
      .then(result => resultAs<boolean>(result))
  });

  return {
    open: options => invoke(pluginId, 'webViewer.open', {
      ...options, scrollbarTheme: readHostScrollbarTheme()
    }, view)
      .then(result => createTab(resultAs<WebViewerTabSummary>(result).id)),
    list: () => invoke(pluginId, 'webViewer.list', {}, view).then(result => resultAs<readonly WebViewerTabSummary[]>(result)),
    get: createTab,
    activate: tabId => invoke(pluginId, 'webViewer.activate', { tabId }, view).then(() => undefined),
    onDidChange: listener => {
      const remove = (nativePluginApi.onWebViewerChanged)(event => {
        if (event.pluginId === pluginId && (!event.runtimeId || event.runtimeId === view.runtimeId)) {
          void listener(event.tabs.filter(tab => tab.instanceId === view.instanceId
            && (!tab.viewType || tab.viewType === view.viewType)));
        }
      }) ?? (() => undefined);
      return subscriptions.add(disposable(remove));
    },
    onDidFail: listener => {
      let disposed = false;
      const remove = (nativePluginApi.onWebViewerChanged)(event => {
        if (disposed || event.pluginId !== pluginId || event.runtimeId !== view.runtimeId) return;
        for (const failure of event.failures ?? []) {
          if (!disposed && failure.instanceId === view.instanceId && failure.viewType === view.viewType) listener(failure);
        }
      }) ?? (() => undefined);
      return subscriptions.add(disposable(() => { disposed = true; remove(); }));
    }
  };
}

/** 创建插件日志 API。 */
function createLoggerApi(pluginId: string, view?: { viewType?: string; instanceId?: string; runtimeId?: string }): LoggerApi {
  const write = (level: string, message: string, details?: Readonly<Record<string, unknown>>): void => {
    void invoke(pluginId, 'log', { level, message, details }, view);
  };
  return {
    debug: (message, details) => write('debug', message, details),
    info: (message, details) => write('info', message, details),
    warn: (message, details) => write('warn', message, details),
    error: (message, details) => write('error', message, details)
  };
}

/** 创建由 Rust 宿主执行的网络请求 API。 */
function createNetworkApi(pluginId: string, view?: { viewType?: string; instanceId?: string; runtimeId?: string }): NetworkApi {
  return {
    request: (url: string, options?: NetworkRequestOptions) => invoke(pluginId, 'network.request', {
      url,
      ...(options ?? {})
    }, view).then(result => result as Awaited<ReturnType<NetworkApi['request']>>)
  };
}

/** 插件激活阶段不能持有具体网页视图实例。 */
function createUnavailableWebViewerApi(): WebViewerApi {
  const unavailable = (): never => {
    throw createPluginError('PLUGIN_VIEW_CONTEXT_REQUIRED', 'WebViewerApi requires an active plugin view.');
  };
  return {
    open: async () => unavailable(),
    list: async () => unavailable(),
    get: () => unavailable(),
    activate: async () => unavailable(),
    onDidChange: () => unavailable(),
    onDidFail: () => unavailable()
  };
}

/** 创建插件或视图共享的公开能力上下文。 */
function createContext(
  record: Pick<PluginRuntimeRecord, 'contribution' | 'commandHandlers'>,
  subscriptions: DisposableStore,
  view?: { viewType?: string; instanceId?: string; runtimeId?: string }
): PluginContext {
  const { contribution } = record;
  const scope = { ...view, runtimeId: contribution.runtimeId };
  const plugin: PluginIdentity = {
    id: contribution.pluginId,
    name: contribution.pluginName,
    version: contribution.pluginVersion,
    trustLevel: contribution.trustLevel
  };
  const commands: CommandsApi = {
    register: (id, handler) => {
      if (view) throw createPluginError('PLUGIN_VIEW_METHOD_FORBIDDEN', 'Commands must be registered during activate().');
      record.commandHandlers.set(id, handler);
      void invoke(plugin.id, 'registerCommand', { id }, scope);
      return subscriptions.add(disposable(() => {
        record.commandHandlers.delete(id);
        void invoke(plugin.id, 'unregisterCommand', { id }, scope);
      }));
    }
  };
  const statusBar: StatusBarApi = {
    registerItem: (item: PluginStatusBarContribution) => {
      if (view) throw createPluginError('PLUGIN_VIEW_METHOD_FORBIDDEN', 'Status items must be registered during activate().');
      const itemId = item.id;
      let disposed = false;
      const ready = invoke(plugin.id, 'statusBar.registerItem', { item: { ...item } }, scope);
      void ready.catch((cause: unknown) => {
        console.warn('[plugin] Status item registration failed.', { pluginId: plugin.id, itemId, cause });
      });
      return subscriptions.add(disposable(() => {
        if (disposed) return;
        disposed = true;
        void ready
          .then(() => invoke(plugin.id, 'statusBar.unregisterItem', { id: itemId }, scope))
          .catch((cause: unknown) => {
            console.warn('[plugin] Status item release failed.', { pluginId: plugin.id, itemId, cause });
          });
      }));
    }
  };

  return {
    plugin,
    subscriptions,
    commands,
    icons: iconsApi,
    filesystem: createFilesystemApi(plugin.id, scope),
    workspace: createWorkspaceApi(plugin.id, subscriptions, scope),
    windows: createWindowsApi(plugin.id, subscriptions, scope),
    editor: createEditorApi(plugin.id, subscriptions, scope),
    settings: createSettingsApi(plugin.id, subscriptions, scope),
    statusBar,
    storage: createStorageApi(plugin.id, scope),
    notifications: createNotificationsApi(plugin.id, scope),
    dialogs: createDialogsApi(plugin.id, scope),
    webViewer: view?.viewType && view.instanceId
      ? createWebViewerApi(plugin.id, subscriptions, {
        viewType: view.viewType,
        instanceId: view.instanceId,
        runtimeId: contribution.runtimeId
      })
      : createUnavailableWebViewerApi(),
    logger: createLoggerApi(plugin.id, scope),
    network: createNetworkApi(plugin.id, scope)
  };
}

/** 将插件样式挂载到当前视图的 ShadowRoot，禁止选择器进入宿主文档。 */
function mountPluginViewStyles(record: PluginRuntimeRecord, root: HTMLElement): HTMLLinkElement {
  const shadowRoot = root.getRootNode();
  if (!(shadowRoot instanceof ShadowRoot)) {
    throw createPluginError(
      'PLUGIN_VIEW_STYLE_ISOLATION_UNAVAILABLE',
      'Plugin views require a ShadowRoot style boundary.'
    );
  }

  const stylesUrl = record.contribution.stylesUrl.trim()
    || getCorePluginStylesUrl(record.contribution.pluginId);
  if (!stylesUrl) {
    throw createPluginError('PLUGIN_STYLE_ENTRY_MISSING', 'Plugin styles are not available.');
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = stylesUrl;
  link.dataset.wstudioPluginStyle = record.contribution.pluginId;
  shadowRoot.insertBefore(link, root);
  record.styleElements.add(link);
  return link;
}

/** 导入并激活单个插件模块。 */
async function activatePlugin(contribution: PluginContributionSummary): Promise<PluginRuntimeRecord> {
  let record: PluginRuntimeRecord | undefined;
  try {
    const imported = contribution.entryUrl.trim()
      ? await import(/* @vite-ignore */ contribution.entryUrl) as Partial<PluginEntryModule>
      : await loadCorePluginModule(contribution.pluginId);
    if (!imported) {
      throw createPluginError('PLUGIN_ENTRY_MISSING', 'Plugin entry is not available.');
    }
    if (typeof imported.activate !== 'function') {
      throw createPluginError('PLUGIN_ENTRY_INVALID', 'Plugin entry must export activate(context).');
    }
    record = {
      contribution,
      module: imported as PluginEntryModule,
      subscriptions: new DisposableStore(),
      commandHandlers: new Map(),
      styleElements: new Set()
    };
    await record.module.activate(createContext(record, record.subscriptions));
    await invoke(contribution.pluginId, 'runtimeReady', {}, { runtimeId: contribution.runtimeId });
    return record;
  } catch (error: unknown) {
    record?.subscriptions.dispose();
    const message = error instanceof Error ? error.message : String(error);
    await invoke(contribution.pluginId, 'runtimeFailed', { message }, { runtimeId: contribution.runtimeId }).catch(() => undefined);
    throw error;
  }
}

/** 确保插件模块在当前工作台窗口只导入并激活一次。 */
export function ensurePluginActivated(contribution: PluginContributionSummary): Promise<PluginRuntimeRecord> {
  const current = runtimes.get(contribution.pluginId);
  if (current) return current;
  const pending = activatePlugin(contribution);
  runtimes.set(contribution.pluginId, pending);
  pending.catch(() => runtimes.delete(contribution.pluginId));
  return pending;
}

/** 原生网页只留 2px 容器边缘，避免覆盖边框而不挤占拖拽命中区宽度。 */
function insetNativeBounds(bounds: PluginViewBoundsRequest['bounds']): PluginViewBoundsRequest['bounds'] {
  const inset = 2;
  const horizontal = Math.min(inset, Math.max(0, bounds.width) / 2);
  const vertical = Math.min(inset, Math.max(0, bounds.height) / 2);
  return {
    x: bounds.x + horizontal,
    y: bounds.y + vertical,
    width: Math.max(0, bounds.width - horizontal * 2),
    height: Math.max(0, bounds.height - vertical * 2)
  };
}

/** 在真实宿主容器中挂载插件视图，并返回 onClose 对应的释放句柄。 */
export async function mountPluginView(options: PluginViewMountOptions): Promise<PluginMountedView> {
  const record = await ensurePluginActivated(options.contribution);
  if (typeof record.module.mountView !== 'function') {
    throw createPluginError('PLUGIN_VIEW_ENTRY_MISSING', 'Plugin entry must export mountView(context).');
  }
  const subscriptions = new DisposableStore();
  const view = { viewType: options.viewType, instanceId: options.instanceId };
  const context = createContext(record, subscriptions, view) as PluginViewMountContext;
  const styleElement = mountPluginViewStyles(record, options.root);
  subscriptions.add(disposable(() => {
    styleElement.remove();
    record.styleElements.delete(styleElement);
  }));
  const resizeListeners = new Set<() => void>();
  const resizeObserver = new ResizeObserver(() => {
    if (boundsDisposed) return;
    for (const listener of resizeListeners) listener();
    void syncNativeBounds().catch((reason: unknown) => {
      console.error('[plugin] Failed to synchronize native view geometry after resize.', reason);
    });
  });
  resizeObserver.observe(options.root);
  subscriptions.add(disposable(() => resizeObserver.disconnect()));
  let latestBounds: PluginViewBoundsRequest | undefined;
  let latestRelativeBounds: PluginViewBoundsRequest['bounds'] | undefined;
  let appliedBounds: PluginViewBoundsRequest['bounds'] | undefined;
  let appliedOcclusions = '';
  let appliedScrollbarTheme = '';
  let boundsSync = Promise.resolve();
  let overlayObserver: MutationObserver | undefined;
  let themeObserver: MutationObserver | undefined;
  let boundsDisposed = false;
  subscriptions.add(disposable(() => {
    boundsDisposed = true;
    overlayObserver?.disconnect();
    themeObserver?.disconnect();
  }));

  /** 原生菜单位于子 WebView 上方；仅 DOM 模态浮层仍沿用现有隐藏行为。 */
  function hasBlockingOverlay(): boolean {
    return document.querySelector(
      '.command-center-overlay, .ws-dialog-layer, .v-overlay.v-overlay--active.v-dialog'
    ) !== null;
  }

  /** 只让出实际菜单表面；全屏浮层容器不能作为裁剪区域。 */
  function menuOcclusions(bounds: PluginViewBoundsRequest['bounds']): NonNullable<PluginViewBoundsRequest['occlusions']> {
    const panels = document.querySelectorAll<HTMLElement>(
      '.v-overlay.v-overlay--active.v-menu > .v-overlay__content, .workbench-context-menu__surface, .ws-dropdown-menu--open .ws-dropdown-menu__panel'
    );
    const occlusions: NonNullable<PluginViewBoundsRequest['occlusions']> = [];
    for (const panel of panels) {
      const style = getComputedStyle(panel);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = panel.getBoundingClientRect();
      const x = Math.max(bounds.x, rect.left);
      const y = Math.max(bounds.y, rect.top);
      const right = Math.min(bounds.x + bounds.width, rect.right);
      const bottom = Math.min(bounds.y + bounds.height, rect.bottom);
      if (right > x && bottom > y) occlusions.push({ x, y, width: right - x, height: bottom - y });
      if (occlusions.length === 64) break;
    }
    return occlusions;
  }

  function syncNativeBounds(): Promise<void> {
    const next = boundsSync.catch(() => undefined).then(async () => {
      if (boundsDisposed || !latestBounds) return;
      const rootBounds = options.root.getBoundingClientRect();
      const rootVisible = rootBounds.width > 0 && rootBounds.height > 0;
      if (latestRelativeBounds) {
        latestBounds = {
          ...latestBounds,
          bounds: {
            x: rootBounds.left + latestRelativeBounds.x,
            y: rootBounds.top + latestRelativeBounds.y,
            width: latestRelativeBounds.width,
            height: latestRelativeBounds.height
          }
        };
      }
      const covered = hasBlockingOverlay();
      const bounds = covered || !rootVisible
        ? { x: 0, y: 0, width: 0, height: 0 }
        : insetNativeBounds(latestBounds.bounds);
      const occlusions = menuOcclusions(bounds);
      const occlusionKey = JSON.stringify(occlusions);
      const scrollbarTheme = readHostScrollbarTheme();
      const themeKey = JSON.stringify(scrollbarTheme) ?? '';
      if (appliedBounds && bounds.x === appliedBounds.x && bounds.y === appliedBounds.y
        && bounds.width === appliedBounds.width && bounds.height === appliedBounds.height
        && occlusionKey === appliedOcclusions && themeKey === appliedScrollbarTheme) return;
      await nativePluginApi.updateViewBounds({ ...latestBounds, bounds, occlusions, scrollbarTheme });
      appliedBounds = bounds;
      appliedOcclusions = occlusionKey;
      appliedScrollbarTheme = themeKey;
    });
    boundsSync = next;
    return next;
  }

  context.view = {
    type: options.viewType,
    instanceId: options.instanceId,
    initialUrl: options.initialUrl,
    root: options.root,
    onDidResize: listener => {
      resizeListeners.add(listener);
      return subscriptions.add(disposable(() => resizeListeners.delete(listener)));
    },
    setWebViewerBounds: bounds => {
      const rootBounds = options.root.getBoundingClientRect();
      latestRelativeBounds = bounds;
      const request = {
        pluginId: options.contribution.pluginId,
        viewType: options.viewType,
        instanceId: options.instanceId,
        initialUrl: options.initialUrl,
        runtimeId: options.contribution.runtimeId,
        bounds: {
          x: rootBounds.left + bounds.x,
          y: rootBounds.top + bounds.y,
          width: bounds.width,
          height: bounds.height
        }
      };
      latestBounds = request;
      if (!overlayObserver && !boundsDisposed) {
        overlayObserver = new MutationObserver(() => {
          if (boundsDisposed) return;
          // 停靠重挂载不一定改变根尺寸；先通知插件重测内部区域，再同步原生坐标。
          for (const listener of resizeListeners) listener();
          void syncNativeBounds().catch((reason: unknown) => {
            console.error('[plugin] Failed to synchronize native view visibility.', reason);
          });
        });
        overlayObserver.observe(document.body, {
          childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
        });
        themeObserver = new MutationObserver(() => {
          if (boundsDisposed) return;
          void syncNativeBounds().catch((reason: unknown) => {
            console.error('[plugin] Failed to synchronize native scrollbar theme.', reason);
          });
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          subtree: true,
          attributeFilter: ['class', 'data-theme-id', 'data-theme-appearance', 'style']
        });
      }
      return syncNativeBounds();
    }
  };
  try {
    const mounted = await record.module.mountView(context);
    if (mounted) subscriptions.add(mounted);
  } catch (error: unknown) {
    subscriptions.dispose();
    await nativePluginApi.disposeView({ pluginId: options.contribution.pluginId,
      viewType: options.viewType, instanceId: options.instanceId,
      runtimeId: options.contribution.runtimeId }).catch(() => undefined);
    throw error;
  }

  return disposable(() => {
    subscriptions.dispose();
    options.root.replaceChildren();
    const request = {
      pluginId: options.contribution.pluginId,
      viewType: options.viewType,
      instanceId: options.instanceId,
      initialUrl: options.initialUrl,
      runtimeId: options.contribution.runtimeId
    };
    void nativePluginApi.disposeView(request);
  });
}

/** 执行当前窗口中由插件 activate 注册的命令。 */
export async function executePluginCommand(pluginId: string, commandId: string): Promise<void> {
  const pending = runtimes.get(pluginId);
  const record = pending ? await pending : undefined;
  const handler = record?.commandHandlers.get(commandId);
  if (!handler) throw createPluginError('PLUGIN_COMMAND_NOT_REGISTERED', 'Plugin command is not registered in this window.');
  await handler({ signal: new AbortController().signal });
}

/** 停用插件模块并释放该窗口内的全部插件资源。 */
export async function deactivatePlugin(pluginId: string): Promise<void> {
  const pending = runtimes.get(pluginId);
  if (!pending) return;
  runtimes.delete(pluginId);
  const record = await pending;
  try {
    await record.module.deactivate?.();
  } finally {
    record.subscriptions.dispose();
    for (const styleElement of record.styleElements) styleElement.remove();
    record.styleElements.clear();
  }
}

/** 停用当前工作台窗口已加载的全部插件。 */
export async function deactivateAllPlugins(): Promise<void> {
  await Promise.all([...runtimes.keys()].map(deactivatePlugin));
}
