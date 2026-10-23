/**
 * 文件说明：定义 Vue 前端与 Rust/Tauri 宿主共用的请求、事件和领域数据契约。
 */

import type {
  PluginContributionSummary,
  PluginDialogRequest,
  PluginDialogResponse,
  PluginEditorDocument,
  PluginEditorVerticalAlignment,
  PluginPermissionId,
  PluginNotificationRequest,
  PluginRepository,
  PluginRpcError,
  PluginSettingValue,
  PluginSummary,
  PluginWindow
} from '../../plugin/sdk';
import type { WebViewerTabSummary } from '../../plugin/sdk';
import type { PluginWorkspaceFileKind } from '../../plugin/sdk';
import type { ThemeVariant, UserThemeEntry } from '../../theme/core/types';
import type { SqlQueryRequest, SqlRow, SqlRunResult } from '../../sql/types';
import type {
  AiConnectedModel,
  AiModel,
  CreateAiModelRequest,
  UpdateAiModelRequest
} from './aiModel';
import type {
  AiConnectionSettings,
  AiConnectionTestResult,
  UpdateAiConnectionSettingsRequest
} from './aiConnection';
import type {
  AiChatBridgeEvent,
  AiChatBridgeStartRequest
} from '../AIchat/interface';
import type {
  AiConfiguration,
  UpdateAiConfigurationRequest
} from './aiConfiguration';
import type {
  AppSettingChangedEvent,
  AppSettingKey
} from './appSettings';
export interface WorkspaceMarkdownFile {
  path: string;
  relativePath: string;
  content: string;
}

/** 工作区 Markdown 文件的轻量索引条目，不包含正文。 */
export interface WorkspaceMarkdownFileMetadata {
  path: string;
  relativePath: string;
  name: string;
  size: number;
  modifiedAt: number;
}

/** 工作区文件列表中供渲染进程展示的条目摘要。 */
export interface WorkspaceFileEntry {
  path: string;
  relativePath: string;
  name: string;
  type: 'file';
}

/** 最近打开仓库的公开信息。 */
export interface WorkspaceRecentRepository {
  id: string;
  name: string;
  displayPath?: string;
}

/** 关闭文件标签后写入任务栏最近关闭历史的请求。 */
export interface TaskbarClosedTabRequest {
  relativePath: string;
  title: string;
}

/** 工作区右键菜单支持复制的路径形式。 */
export type WorkspaceCopyPathKind = 'absolute' | 'repository-root' | 'content-root';

/** 设置窗口工作区路径选择器的安全类型和扩展名过滤。 */
export interface WorkspacePickEntryOptions {
  kind: 'file' | 'folder';
  extensions?: readonly string[];
}

/** 请求将当前内置主题物化为用户主题文件。 */
export interface ThemeMaterializeBuiltinRequest {
  category: string;
  fileName: string;
  variant: ThemeVariant;
}

/** 工作区目录选择器使用的仓库相对目录信息。 */
export interface WorkspaceDirectoryEntry {
  relativePath: string;
  name: string;
  parentPath?: string;
}

/** 将工作区文件移动到目标目录的请求。 */
export interface WorkspaceMoveFileRequest {
  sourceRelativePath: string;
  targetDirectoryRelativePath: string;
}

/** 将外部媒体文件复制到当前 Markdown 所在目录的请求。 */
export interface WorkspaceImportExternalMediaFileRequest {
  sourcePath: string;
  markdownFilePath: string;
}

/** 外部媒体导入操作的稳定结果。 */
export type WorkspaceImportExternalMediaFileResult =
  | {
      status: 'copied';
      relativePath: string;
      referencePath: string;
      title: string;
    }
  | {
      status: 'rejected';
      reason:
        | 'invalid-request'
        | 'outside-workspace'
        | 'source-not-found'
        | 'source-not-file'
        | 'markdown-not-found'
        | 'unsupported-media'
        | 'io-error'
        | 'bridge-unavailable';
    };

/** 工作区文件移动操作的稳定结果。 */
export type WorkspaceMoveFileResult =
  | {
      status: 'moved';
      filePath: string;
      relativePath: string;
      title: string;
    }
  | {
      status: 'rejected';
      reason:
        | 'outside-workspace'
        | 'source-not-found'
        | 'source-not-file'
        | 'target-not-found'
        | 'target-not-directory'
        | 'target-exists'
        | 'same-directory'
        | 'io-error'
        | 'bridge-unavailable';
    };

/** 可信主进程请求渲染进程打开已验证文本文件的数据。 */
export interface WorkspaceOpenTextFileRequest {
  repositoryId: string;
  filePath: string;
  relativePath?: string;
  title: string;
  kind: 'text';
  content: string;
  position?: number;
  selectionEnd?: number;
  verticalAlignment?: PluginEditorVerticalAlignment;
  disposition?: 'current-group' | 'new-group';
  temporary?: boolean;
}

/** 可信主进程请求渲染进程打开已验证媒体文件的数据。 */
export interface WorkspaceOpenMediaFileRequest {
  repositoryId: string;
  filePath: string;
  relativePath?: string;
  title: string;
  kind: Exclude<PluginWorkspaceFileKind, 'text'>;
  mediaMimeType: string;
  content?: undefined;
  disposition?: 'current-group' | 'new-group';
  temporary?: boolean;
}

/** 可信主进程请求渲染进程打开已验证仓库文件的数据。 */
export type WorkspaceOpenFileRequest =
  | WorkspaceOpenTextFileRequest
  | WorkspaceOpenMediaFileRequest;

/** 主进程发布工作区打开事件前使用的、未附带仓库身份的文件数据。 */
export type WorkspaceOpenFileInput =
  | Omit<WorkspaceOpenTextFileRequest, 'repositoryId'>
  | Omit<WorkspaceOpenMediaFileRequest, 'repositoryId'>;

/** 工作区 Markdown 文件的比较并写入请求。 */
export interface UpdateWorkspaceMarkdownFileRequest {
  path: string;
  expectedContent: string;
  content: string;
}

/** 工作区 Markdown 文件写入结果。 */
export type UpdateWorkspaceMarkdownFileResult =
  | {
      status: 'updated' | 'unchanged';
      file: WorkspaceMarkdownFile;
    }
  | {
      status: 'conflict';
      file: WorkspaceMarkdownFile;
    }
  | {
      status: 'rejected';
      reason:
        | 'outside-workspace'
        | 'unsupported-extension'
        | 'unsupported-encoding'
        | 'not-found'
        | 'bridge-unavailable';
    };

/** 根据日期在当前笔记目录创建 Markdown 笔记的请求。 */
export interface CreateWorkspaceDateNoteRequest {
  sourceFilePath: string;
  date: string;
}

/** 日期笔记创建操作的稳定结果。 */
export type CreateWorkspaceDateNoteResult =
  | {
      status: 'created' | 'existing';
      file: WorkspaceMarkdownFile;
    }
  | {
      status: 'rejected';
      reason:
        | 'invalid-date'
        | 'outside-workspace'
        | 'source-not-found'
        | 'source-not-file'
        | 'unsupported-encoding'
        | 'io-error'
        | 'bridge-unavailable';
    };

/** Rust 存储查询结果；显式区分缺失的 key 与持久化的 JSON null。 */
export interface PluginStorageReadResult {
  found: boolean;
  value?: unknown;
}

/** 插件安装请求；路径由用户通过文件选择器提供。 */
export interface PluginInstallRequest {
  sourcePath: string;
}

/** 插件更新请求；新包必须与已安装插件 ID 相同。 */
export interface PluginUpdateRequest {
  id: string;
  sourcePath: string;
}

/** 插件启用状态变更请求。 */
export interface PluginSetEnabledRequest {
  id: string;
  enabled: boolean;
}

/** 插件权限授权状态变更请求。 */
export interface PluginSetPermissionsRequest {
  id: string;
  permissions: readonly PluginPermissionId[];
}

/** 插件声明设置字段的更新请求。 */
export interface PluginSetSettingRequest {
  pluginId: string;
  settingId: string;
  fieldId: string;
  value: PluginSettingValue;
}

/** 插件设置字段变化事件。 */
export interface PluginSettingChangedEvent {
  pluginId: string;
  settingId: string;
  fieldId: string;
  value: PluginSettingValue;
}

/** 插件运行时声明贡献发生变化的事件。 */
export interface PluginContributionsChangedEvent {
  pluginId: string;
}

/** 插件安装状态、版本、启用状态或权限变化事件。 */
export interface PluginRegistryChangedEvent {
  pluginId: string;
}

export interface PluginViewRequest {
  pluginId: string;
  viewType: string;
  instanceId: string;
  initialUrl?: string;
  /** 原生视图资源绑定当前插件 generation；宿主在缺省时解析权威运行时。 */
  runtimeId?: string;
}

/** 宿主渲染进程发起的插件能力调用，主进程从 pluginId 解析权威运行时。 */
export interface PluginRendererInvokeRequest {
  pluginId: string;
  request: PluginHostInvokeRequest;
  view?: Pick<PluginViewRequest, 'viewType' | 'instanceId'>;
}

/** 宿主滚动条主题中已解析的三个颜色。 */
export interface WebViewerScrollbarTheme {
  background: string;
  hoverBackground: string;
  activeBackground: string;
  modernUiEnabled: boolean;
}

/** 原生网页承载区域及宿主自动提供的展示策略。 */
export interface PluginViewBoundsRequest extends PluginViewRequest {
  bounds: { x: number; y: number; width: number; height: number };
  /** 宿主菜单覆盖区域；裁剪原生表面，不改变网页布局或可见状态。 */
  occlusions?: Array<{ x: number; y: number; width: number; height: number }>;
  /** 从宿主主题解析；插件继续通过原有 SDK 自动获得一致的滚动条颜色。 */
  scrollbarTheme?: WebViewerScrollbarTheme;
}



/** 网页标签上下文菜单动作请求；仅供可信工作台渲染器调用。 */
export interface WebViewerContextMenuRequest {
  pluginId: string;
  instanceId: string;
  viewType: string;
  action: import('../../plugin/sdk').WebViewerAction;
}

/** 宿主统一上下文菜单的分隔线。 */
export interface WorkbenchContextMenuDivider {
  type: 'separator';
  id: string;
}

/** 宿主统一上下文菜单的可执行选项。 */
export interface WorkbenchContextMenuAction {
  type: 'action';
  id: string;
  label: string;
  enabled?: boolean;
  children?: readonly WorkbenchContextMenuAction[];
}

/** 宿主统一上下文菜单支持的条目。 */
export type WorkbenchContextMenuEntry = WorkbenchContextMenuDivider | WorkbenchContextMenuAction;

/** 工作台渲染器请求显示统一上下文菜单的数据。 */
export interface WorkbenchContextMenuRequest {
  x: number;
  y: number;
  items: readonly WorkbenchContextMenuEntry[];
}

/** 主进程发送给菜单浮层窗口的会话数据。 */
export interface WorkbenchContextMenuSession extends WorkbenchContextMenuRequest {
  sessionId: string;
}

/** 主进程取消当前菜单会话时通知菜单浮层清理显示状态。 */
export interface WorkbenchContextMenuDismissedEvent {
  sessionId: string;
}

/** 菜单浮层窗口完成或取消当前会话的请求。 */
export interface WorkbenchContextMenuResultRequest {
  sessionId: string;
  actionId?: string;
}

/** 插件设置页的持久化字段值快照。 */
export type PluginSettingsValues = Record<string, PluginSettingValue>;

/** 工作台插件运行时向主进程发送的能力调用。 */
export interface PluginHostInvokeRequest {
  protocolVersion: 1;
  requestId: string;
  runtimeId: string;
  method: string;
  params: unknown;
  deadline: number;
}

/** 标准插件能力调用的结构化返回值。 */
export interface PluginHostInvokeResponse {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: PluginRpcError;
}

/** 插件请求工作台打开或关闭其已声明视图时发布的事件。 */
export interface PluginViewLifecycleRequest {
  pluginId: string;
  viewType: string;
  instanceId?: string;
  url?: string;
}

export interface IpcInvokeMap {
  'app:getVersion': {
    args: [];
    result: string;
  };
  'app:ping': {
    args: [];
    result: string;
  };
  'system:listFonts': {
    args: [];
    result: string[];
  };
  'appSettings:get': {
    args: [key: AppSettingKey];
    result: string | null;
  };
  'appSettings:set': {
    args: [key: AppSettingKey, value: string];
    result: void;
  };
  'appSettings:remove': {
    args: [key: AppSettingKey];
    result: void;
  };
  'aiConfigurations:list': {
    args: [];
    result: AiConfiguration[];
  };
  'aiConfigurations:create': {
    args: [];
    result: AiConfiguration;
  };
  'aiConfigurations:delete': {
    args: [configurationId: string];
    result: void;
  };
  'aiConfigurations:update': {
    args: [configurationId: string, request: UpdateAiConfigurationRequest];
    result: AiConfiguration;
  };
  'aiModels:list': {
    args: [configurationId: string];
    result: AiModel[];
  };
  'aiModels:listConnected': {
    args: [];
    result: AiConnectedModel[];
  };
  'aiModels:create': {
    args: [configurationId: string, request: CreateAiModelRequest];
    result: AiModel;
  };
  'aiModels:update': {
    args: [configurationId: string, request: UpdateAiModelRequest];
    result: AiModel;
  };
  'aiModels:delete': {
    args: [configurationId: string, modelId: string];
    result: void;
  };
  'aiConnection:getSettings': {
    args: [configurationId: string];
    result: AiConnectionSettings;
  };
  'aiConnection:updateSettings': {
    args: [configurationId: string, request: UpdateAiConnectionSettingsRequest];
    result: AiConnectionSettings;
  };
  'aiConnection:testModel': {
    args: [configurationId: string, modelId: string];
    result: AiConnectionTestResult;
  };
  'aiConnection:cancelTest': {
    args: [configurationId: string];
    result: void;
  };
  'aiChat:start': {
    args: [request: AiChatBridgeStartRequest];
    result: void;
  };
  'aiChat:pause': {
    args: [sessionId: string];
    result: void;
  };
  'aiChat:resume': {
    args: [sessionId: string];
    result: void;
  };
  'aiChat:cancel': {
    args: [sessionId: string];
    result: void;
  };
  'sql:exec': {
    args: [request: SqlQueryRequest];
    result: void;
  };
  'sql:run': {
    args: [request: SqlQueryRequest];
    result: SqlRunResult;
  };
  'sql:get': {
    args: [request: SqlQueryRequest];
    result: SqlRow | undefined;
  };
  'sql:all': {
    args: [request: SqlQueryRequest];
    result: SqlRow[];
  };
  'window:minimize': {
    args: [];
    result: void;
  };
  'window:reportActivity': {
    args: [];
    result: void;
  };
  'window:toggleMaximize': {
    args: [];
    result: boolean;
  };
  'window:close': {
    args: [];
    result: void;
  };
  'window:isMaximized': {
    args: [];
    result: boolean;
  };
  'window:getPosition': {
    args: [];
    result: [x: number, y: number];
  };
  'window:moveTo': {
    args: [x: number, y: number];
    result: void;
  };
  'workspace:listMarkdownFiles': {
    args: [];
    result: WorkspaceMarkdownFileMetadata[];
  };
 'workspace:readMarkdownFile': {
   args: [path: string];
   result: WorkspaceMarkdownFile | undefined;
 };
  'workspace:openFile': {
    args: [path: string, disposition?: 'current-group' | 'new-group'];
    result: WorkspaceOpenFileRequest | undefined;
  };
  'workspace:listFiles': {
    args: [];
    result: WorkspaceFileEntry[];
  };
  'workspace:getRepository': {
    args: [];
    result: PluginRepository;
  };
  'workspace:pickEntry': {
    args: [options: WorkspacePickEntryOptions];
    result: string | undefined;
  };
  'theme:listUserThemes': {
    args: [];
    result: UserThemeEntry[];
  };
  'theme:materializeBuiltin': {
    args: [request: ThemeMaterializeBuiltinRequest];
    result: UserThemeEntry;
  };
  'workspace:setActiveDocument': {
    args: [document: PluginEditorDocument | undefined];
    result: PluginEditorDocument | undefined;
  };
  'workspace:openRepository': {
    args: [];
    result: PluginRepository | undefined;
  };
  'workspace:createRepository': {
    args: [name?: string, parentPath?: string];
    result: PluginRepository | undefined;
  };
  'workspace:selectRepositoryLocation': {
    args: [];
    result: string | undefined;
  };
  'workspace:getDefaultRepositoryLocation': {
    args: [];
    result: string;
  };
  'workspace:listRecentRepositories': {
    args: [];
    result: WorkspaceRecentRepository[];
  };
  'workspace:openRecentRepository': {
    args: [id: string];
    result: PluginRepository | undefined;
  };
  'workspace:renameRecentRepository': {
    args: [id: string, name: string];
    result: void;
  };
  'workspace:moveRecentRepository': {
    args: [id: string];
    result: boolean;
  };
  'workspace:revealRecentRepository': {
    args: [id: string];
    result: void;
  };
  'workspace:removeRecentRepository': {
    args: [id: string];
    result: void;
  };
  'workspace:openWithSystem': {
    args: [relativePath: string];
    result: boolean;
  };
  'workspace:revealInFileManager': {
    args: [relativePath: string];
    result: boolean;
  };
  'workspace:copyPath': {
    args: [relativePath: string, kind: WorkspaceCopyPathKind];
    result: boolean;
  };
  'workspace:openInNewWindow': {
    args: [relativePath: string];
    result: boolean;
  };
  'workspace:listDirectories': {
    args: [];
    result: WorkspaceDirectoryEntry[];
  };
  'workspace:moveFile': {
    args: [request: WorkspaceMoveFileRequest];
    result: WorkspaceMoveFileResult;
  };
  'workspace:importExternalMediaFile': {
    args: [request: WorkspaceImportExternalMediaFileRequest];
    result: WorkspaceImportExternalMediaFileResult;
  };
  'workspace:takeInitialOpenFile': {
    args: [];
    result: WorkspaceOpenFileRequest | undefined;
  };
  'workspace:updateMarkdownFile': {
    args: [request: UpdateWorkspaceMarkdownFileRequest];
    result: UpdateWorkspaceMarkdownFileResult;
  };
  'workspace:createDateNote': {
    args: [request: CreateWorkspaceDateNoteRequest];
    result: CreateWorkspaceDateNoteResult;
  };
  'plugin:list': {
    args: [];
    result: PluginSummary[];
  };
  'plugin:listContributions': {
    args: [];
    result: PluginContributionSummary[];
  };
  'plugin:getSettings': {
    args: [pluginId: string, settingId: string];
    result: PluginSettingsValues;
  };
  'plugin:setSetting': {
    args: [request: PluginSetSettingRequest];
    result: PluginSettingsValues;
  };
  'plugin:install': {
    args: [request: PluginInstallRequest];
    result: PluginSummary;
  };
  'plugin:update': {
    args: [request: PluginUpdateRequest];
    result: PluginSummary;
  };
  'plugin:rollback': {
    args: [id: string];
    result: PluginSummary;
  };
  'plugin:setEnabled': {
    args: [request: PluginSetEnabledRequest];
    result: PluginSummary;
  };
  'plugin:setPermissions': {
    args: [request: PluginSetPermissionsRequest];
    result: PluginSummary;
  };
  'plugin:uninstall': {
    args: [id: string];
    result: void;
  };
  'plugin:executeCommand': {
    args: [pluginId: string, commandId: string];
    result: void;
  };
  'plugin:dialogResponse': {
    args: [response: PluginDialogResponse];
    result: boolean;
  };
  'plugin:viewBounds': { args: [request: PluginViewBoundsRequest]; result: void };
  'plugin:viewDispose': { args: [request: PluginViewRequest]; result: void };
  'plugin:rendererInvoke': { args: [request: PluginRendererInvokeRequest]; result: PluginHostInvokeResponse };
  'workbench:openSettingsWindow': { args: [navigationId?: string]; result: void };
  'workbench:openSearchWindow': { args: []; result: void };
  'workbench:openSearchResult': { args: [relativePath: string]; result: boolean };
  'workbench:openRepositoryManagerWindow': { args: []; result: void };
  'workbench:takeRepositoryManagerRequest': { args: []; result: PluginDialogRequest | undefined };
  'workbench:openSettingsTab': { args: [navigationId?: string]; result: void };
  'plugin:webViewerContextMenu': {
    args: [request: WebViewerContextMenuRequest];
    result: boolean;
  };
  'workbench:showContextMenu': {
    args: [request: WorkbenchContextMenuRequest];
    result: string | undefined;
  };
  'workbench:resolveContextMenu': {
    args: [request: WorkbenchContextMenuResultRequest];
    result: void;
  };
}

export type IpcChannel = keyof IpcInvokeMap;

/** 主进程主动发送到可信渲染进程的类型安全事件。 */
export interface IpcEventMap {
  'aiModels:connectedChanged': readonly AiConnectedModel[];
  'aiConfigurations:changed': readonly AiConfiguration[];
  'aiChat:event': AiChatBridgeEvent;
  'appSettings:changed': AppSettingChangedEvent;
  'workspace:repositoryChanged': PluginRepository;
  'workspace:directoryChanged': WorkspaceDirectoryChangedEvent;
  'workspace:fileChanged': WorkspaceFileChangedEvent;
  'workspace:openFileRequested': WorkspaceOpenFileRequest;
  'workspace:closeTabsRequested': { paths?: readonly string[] };
  'plugin:viewOpenRequested': PluginViewLifecycleRequest;
  'plugin:viewCloseRequested': PluginViewLifecycleRequest;
  'plugin:notificationRequested': PluginNotificationRequest;
  'plugin:dialogRequested': PluginDialogRequest;
  'plugin:webViewerChanged': {
    pluginId: string;
    tabs: readonly WebViewerTabSummary[];
    runtimeId?: string;
    failures?: readonly import('../../plugin/sdk').WebViewerFailure[];
  };
  'plugin:settingChanged': PluginSettingChangedEvent;
  'plugin:contributionsChanged': PluginContributionsChangedEvent;
  'plugin:registryChanged': PluginRegistryChangedEvent;
  'plugin:runtimeChanged': PluginRegistryChangedEvent;
  'plugin:windowChanged': readonly PluginWindow[];
  'plugin:editorDocumentChanged': PluginEditorDocument | undefined;
  'plugin:repositoryChanged': PluginRepository;
  'workbench:contextMenuRequested': WorkbenchContextMenuSession;
  'workbench:contextMenuDismissed': WorkbenchContextMenuDismissedEvent;
  'workbench:openSettingsTabRequested': { navigationId?: string };
  'workbench:settingsWindowState': { open: boolean };
}

/** 主进程文件监听器推送的仓库目录失效事件。 */
export interface WorkspaceDirectoryChangedEvent {
  repositoryId: string;
  parentId?: string;
}

export interface WorkspaceFileChangedEvent {
  repositoryId: string;
  path: string;
  kind: 'created' | 'modified' | 'deleted';
}

export type IpcEventChannel = keyof IpcEventMap;

export {};
