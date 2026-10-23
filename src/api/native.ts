/** 文件说明：封装 Tauri 原生命令与工作台领域事件。 */
import { invoke } from '@tauri-apps/api/core';
import { subscribeNativeEvent as subscribe } from './nativeEvents';
import type { NativeEventSubscription } from './nativeEvents';
import { open } from '@tauri-apps/plugin-dialog';
import type {
  UpdateWorkspaceMarkdownFileRequest,
  UpdateWorkspaceMarkdownFileResult,
  WorkspaceFileEntry,
  WorkspaceMarkdownFileMetadata,
  WorkspaceOpenFileRequest,
  WorkspaceDirectoryEntry,
  WorkspaceMoveFileRequest,
  WorkspaceMoveFileResult,
  CreateWorkspaceDateNoteRequest,
  CreateWorkspaceDateNoteResult,
  WorkspaceMarkdownFile
} from '@/types/ipc';
import type {
  WorkspacePickEntryOptions,
  WorkspaceRecentRepository,
  IpcEventMap,
  WorkspaceImportExternalMediaFileRequest,
  WorkspaceImportExternalMediaFileResult,
  TaskbarClosedTabRequest,
  PluginSetSettingRequest,
  PluginInstallRequest,
  PluginUpdateRequest,
  PluginSetEnabledRequest,
  PluginSetPermissionsRequest,
  PluginViewRequest
} from '@/types/ipc';
import type { WorkspaceCopyPathKind } from '@/types/ipc';
import type { PluginRepository } from '../../plugin/sdk';
import type { PluginEditorDocument } from '../../plugin/sdk';
import type { PluginSummary } from '../../plugin/sdk';
import type { PluginContributionSummary } from '../../plugin/sdk';
import type { PluginWindow } from '../../plugin/sdk';
import type { ThemeMaterializeBuiltinRequest } from '@/types/ipc';
import type { UserThemeEntry } from '@theme/core/types';
import type { AppSettingChangedEvent, AppSettingKey } from '@/types/appSettings';
import type { SqlQueryRequest, SqlRow, SqlRunResult } from '../../sql/types';
import type { AiConfiguration, UpdateAiConfigurationRequest } from '@/types/aiConfiguration';
import type { AiConnectedModel, AiModel, CreateAiModelRequest, UpdateAiModelRequest } from '@/types/aiModel';
import type { AiConnectionSettings, AiConnectionTestResult, UpdateAiConnectionSettingsRequest } from '@/types/aiConnection';
import type { AiChatBridgeEvent, AiChatBridgeStartRequest } from '@/AIchat/interface';
import type { PluginDialogRequest } from '../../plugin/sdk';
import type { AuthenticationApi, LoginAttempt, LoginReceipt } from '@/login/types';

export interface NativeAppInfo {
  runtime: 'tauri';
  version: string;
}

export const isTauriRuntime = (): boolean => (
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
);

function subscribeEvent<T>(eventName: string, listener: (payload: T) => void): () => void {
  return subscribe(eventName, listener);
}

async function choosePath(options: WorkspacePickEntryOptions): Promise<string | undefined> {
  const selected = await open({
    directory: options.kind === 'folder',
    multiple: false,
    ...(options.extensions?.length && options.kind === 'file'
      ? { filters: [{ name: 'Files', extensions: [...options.extensions] }] }
      : {})
  });
  return typeof selected === 'string' ? selected : undefined;
}

export const nativeApi = {
  ping(): Promise<string> {
    return invoke<string>('app_ping');
  },

  getVersion(): Promise<NativeAppInfo> {
    return invoke<NativeAppInfo>('app_get_version');
  },

  login: {
    beginGoogle(): Promise<LoginAttempt> {
      return invoke<LoginAttempt>('login_google_begin');
    },
    beginGithub(): Promise<LoginAttempt> {
      return invoke<LoginAttempt>('login_github_begin');
    },
    wait(attemptId: string): Promise<LoginReceipt> {
      return invoke<LoginReceipt>('login_wait', { attemptId });
    },
    cancel(attemptId: string): Promise<void> {
      return invoke<void>('login_cancel', { attemptId });
    },
    logout(accountHash?: string): Promise<void> {
      return invoke<void>('login_logout', { accountHash: accountHash ?? null });
    },
    getReceipts(): Promise<LoginReceipt[]> {
      return invoke<LoginReceipt[]>('login_get_receipts');
    },
    selectAccount(accountHash: string): Promise<void> {
      return invoke<void>('login_select_account', { accountHash });
    },
    getReceipt(): Promise<LoginReceipt | null> {
      return invoke<LoginReceipt | null>('login_get_receipt');
    }
  } satisfies AuthenticationApi,

  editor: {
    setActiveDocument(document: PluginEditorDocument | undefined): Promise<PluginEditorDocument | undefined> {
      return invoke<PluginEditorDocument | undefined>('editor_set_active_document', { document });
    },
    getActiveDocument(): Promise<PluginEditorDocument | undefined> {
      return invoke<PluginEditorDocument | undefined>('editor_get_active_document');
    },
    onDidChangeActiveDocument(listener: (document: PluginEditorDocument | undefined) => void): () => void {
      return subscribeEvent('plugin:editorDocumentChanged', listener);
    }
  },

  theme: {
    listUserThemes(): Promise<UserThemeEntry[]> {
      return invoke<UserThemeEntry[]>('theme_list_user_themes');
    },
    materializeBuiltin(request: ThemeMaterializeBuiltinRequest): Promise<UserThemeEntry> {
      return invoke<UserThemeEntry>('theme_materialize_builtin', { request });
    }
  },

  workbench: {
    openSettings(navigationId?: string): Promise<void> {
      return invoke<void>('workbench_open_settings', { navigationId });
    },
    openSearch(): Promise<void> {
      return invoke<void>('workbench_open_search');
    },
    openRepositoryManager(
      request?: Extract<PluginDialogRequest, { kind: 'repository-manager' }>
    ): Promise<void> {
      return invoke<void>('workbench_open_repository_manager', { request });
    },
    takeRepositoryManagerRequest(): Promise<Extract<PluginDialogRequest, { kind: 'repository-manager' }> | undefined> {
      return invoke<Extract<PluginDialogRequest, { kind: 'repository-manager' }> | undefined>(
        'workbench_take_repository_manager_request'
      );
    },
    onRepositoryManagerRequest(
      listener: (request: Extract<PluginDialogRequest, { kind: 'repository-manager' }>) => void
    ): () => void {
      return subscribeEvent('workbench:repositoryManagerRequest', listener);
    },
    openSettingsTab(navigationId?: string): Promise<void> {
      return invoke<void>('workbench_open_settings_tab', { navigationId });
    },
    openSearchResult(relativePath: string): Promise<boolean> {
      return invoke<boolean>('workbench_open_search_result', { relativePathValue: relativePath });
    },
    onOpenSettingsTabRequested(listener: (event: { navigationId?: string }) => void): () => void {
      return subscribeEvent('workbench:openSettingsTabRequested', listener);
    },
    onSettingsWindowState(listener: (event: { open: boolean }) => void): () => void {
      return subscribeEvent('workbench:settingsWindowState', listener);
    }
  },

  plugins: {
    /** 管理插件包；执行代码须等待独立 Host 就绪。 */
    install(request: PluginInstallRequest): Promise<PluginSummary> {
      return invoke<PluginSummary>('plugin_install', { request });
    },
    update(request: PluginUpdateRequest): Promise<PluginSummary> {
      return invoke<PluginSummary>('plugin_update', { request });
    },
    rollback(id: string): Promise<PluginSummary> {
      return invoke<PluginSummary>('plugin_rollback', { id });
    },
    setEnabled(request: PluginSetEnabledRequest): Promise<PluginSummary> {
      return invoke<PluginSummary>('plugin_set_enabled', { request });
    },
    setPermissions(request: PluginSetPermissionsRequest): Promise<PluginSummary> {
      return invoke<PluginSummary>('plugin_set_permissions', { request });
    },
    uninstall(id: string): Promise<void> {
      return invoke<void>('plugin_uninstall', { id });
    },
    list(): Promise<PluginSummary[]> {
      return invoke<PluginSummary[]>('plugin_list');
    },
    listContributions(): Promise<PluginContributionSummary[]> {
      return invoke<PluginContributionSummary[]>('plugin_list_contributions');
    },
    getSettings(pluginId: string, settingId: string): Promise<Record<string, string | number | boolean>> {
      return invoke<Record<string, string | number | boolean>>('plugin_get_settings', {
        request: { pluginId, settingId }
      });
    },
    setSetting(request: PluginSetSettingRequest): Promise<Record<string, string | number | boolean>> {
      return invoke<Record<string, string | number | boolean>>('plugin_set_setting', { request });
    },
    executeCommand(pluginId: string, commandId: string): Promise<void> {
      return invoke<void>('plugin_execute_command', { request: { pluginId, commandId } });
    },
    disposeView(request: PluginViewRequest): Promise<void> {
      return invoke<void>('plugin_dispose_view', { request });
    },
    listWindows(): Promise<PluginWindow[]> {
      return invoke<PluginWindow[]>('plugin_window_list');
    },
    onSettingChanged(listener: (event: IpcEventMap['plugin:settingChanged']) => void): () => void {
      return subscribeEvent('plugin:settingChanged', listener);
    },
    onContributionsChanged(listener: (event: IpcEventMap['plugin:contributionsChanged']) => void): () => void {
      return subscribeEvent('plugin:contributionsChanged', listener);
    },
    onNotificationRequested(listener: (event: IpcEventMap['plugin:notificationRequested']) => void): () => void {
      return subscribeEvent('plugin:notificationRequested', listener);
    },
    onRegistryChanged(listener: (event: { pluginId: string }) => void): () => void {
      return subscribeEvent('plugin:registryChanged', listener);
    },
    onRuntimeChanged(listener: (event: { pluginId: string }) => void): () => void {
      return subscribeEvent('plugin:runtimeChanged', listener);
    }
  },

  system: {
    listFonts(): Promise<string[]> {
      return invoke<string[]>('system_list_fonts');
    }
  },

  window: {
    minimize(): Promise<void> { return invoke<void>('window_minimize'); },
    reportActivity(): Promise<void> { return invoke<void>('window_report_activity'); },
    toggleMaximize(): Promise<boolean> { return invoke<boolean>('window_toggle_maximize'); },
    close(): Promise<void> { return invoke<void>('window_close'); },
    isMaximized(): Promise<boolean> { return invoke<boolean>('window_is_maximized'); },
    getPosition(): Promise<[number, number]> { return invoke<[number, number]>('window_get_position'); },
    moveTo(x: number, y: number): Promise<void> { return invoke<void>('window_move_to', { x, y }); }
  },

  sql: {
    exec(request: SqlQueryRequest): Promise<void> {
      return invoke<void>('sql_exec', { request });
    },
    run(request: SqlQueryRequest): Promise<SqlRunResult> {
      return invoke<SqlRunResult>('sql_run', { request });
    },
    get(request: SqlQueryRequest): Promise<SqlRow | undefined> {
      return invoke<SqlRow | undefined>('sql_get', { request });
    },
    all(request: SqlQueryRequest): Promise<SqlRow[]> {
      return invoke<SqlRow[]>('sql_all', { request });
    }
  },

  appSettings: {
    get(key: AppSettingKey): Promise<string | null> {
      return invoke<string | null>('app_settings_get', { key });
    },
    set(key: AppSettingKey, value: string): Promise<void> {
      return invoke<void>('app_settings_set', { request: { key, value } });
    },
    remove(key: AppSettingKey): Promise<void> {
      return invoke<void>('app_settings_remove', { key });
    },
    onChanged(listener: (event: AppSettingChangedEvent) => void): () => void {
      return subscribeEvent('appSettings:changed', listener);
    }
  },

  aiConfigurations: {
    list(): Promise<AiConfiguration[]> {
      return invoke<AiConfiguration[]>('ai_configurations_list');
    },
    create(): Promise<AiConfiguration> {
      return invoke<AiConfiguration>('ai_configurations_create');
    },
    delete(configurationId: string): Promise<void> {
      return invoke<void>('ai_configurations_delete', { configurationId });
    },
    update(configurationId: string, request: UpdateAiConfigurationRequest): Promise<AiConfiguration> {
      return invoke<AiConfiguration>('ai_configurations_update', { configurationId, request });
    },
    onChanged(listener: (configurations: readonly AiConfiguration[]) => void): () => void {
      return subscribeEvent('aiConfigurations:changed', listener);
    }
  },

  aiModels: {
    list(configurationId: string): Promise<AiModel[]> {
      return invoke<AiModel[]>('ai_models_list', { configurationId });
    },
    listConnected(): Promise<AiConnectedModel[]> {
      return invoke<AiConnectedModel[]>('ai_models_list_connected');
    },
    create(configurationId: string, request: CreateAiModelRequest): Promise<AiModel> {
      return invoke<AiModel>('ai_models_create', { configurationId, request });
    },
    update(configurationId: string, request: UpdateAiModelRequest): Promise<AiModel> {
      return invoke<AiModel>('ai_models_update', { configurationId, request });
    },
    delete(configurationId: string, modelId: string): Promise<void> {
      return invoke<void>('ai_models_delete', { configurationId, modelId });
    },
    onConnectedChanged(listener: (models: readonly AiConnectedModel[]) => void): () => void {
      return subscribeEvent('aiModels:connectedChanged', listener);
    }
  },

  aiConnection: {
    getSettings(configurationId: string): Promise<AiConnectionSettings> {
      return invoke<AiConnectionSettings>('ai_connection_get_settings', { configurationId });
    },
    updateSettings(configurationId: string, request: UpdateAiConnectionSettingsRequest): Promise<AiConnectionSettings> {
      return invoke<AiConnectionSettings>('ai_connection_update_settings', { configurationId, request });
    },
    testModel(configurationId: string, modelId: string): Promise<AiConnectionTestResult> {
      return invoke<AiConnectionTestResult>('ai_connection_test_model', { configurationId, modelId });
    },
    cancelTest(configurationId: string): Promise<void> {
      return invoke<void>('ai_connection_cancel_test', { configurationId });
    }
  },

  aiChat: {
    start(request: AiChatBridgeStartRequest): Promise<void> {
      return invoke<void>('ai_chat_start', { request });
    },
    pause(sessionId: string): Promise<void> {
      return invoke<void>('ai_chat_pause', { sessionId });
    },
    resume(sessionId: string): Promise<void> {
      return invoke<void>('ai_chat_resume', { sessionId });
    },
    cancel(sessionId: string): Promise<void> {
      return invoke<void>('ai_chat_cancel', { sessionId });
    },
    onEvent(listener: (event: AiChatBridgeEvent) => void): NativeEventSubscription {
      return subscribe('aiChat:event', listener);
    }
  },

  workspace: {
    getRepository(): Promise<PluginRepository> {
      return invoke<PluginRepository>('workspace_get_repository');
    },

    pickEntry(options: WorkspacePickEntryOptions): Promise<string | undefined> {
      return invoke<string | null>('workspace_pick_entry', { options })
        .then(path => path ?? undefined);
    },

    async openRepository(): Promise<PluginRepository | undefined> {
      const path = await choosePath({ kind: 'folder' });
      return path ? invoke<PluginRepository>('workspace_open_repository', { path }) : undefined;
    },

    async createRepository(name?: string, parentPath?: string): Promise<PluginRepository | undefined> {
      return invoke<PluginRepository>('workspace_create_repository', { name, parentPath });
    },

    selectRepositoryLocation(): Promise<string | undefined> {
      return choosePath({ kind: 'folder' });
    },

    getDefaultRepositoryLocation(): Promise<string> {
      return invoke<string>('workspace_get_default_repository_location');
    },

    listRecentRepositories(): Promise<WorkspaceRecentRepository[]> {
      return invoke<WorkspaceRecentRepository[]>('workspace_list_recent_repositories');
    },

    openRecentRepository(id: string): Promise<PluginRepository | undefined> {
      return invoke<PluginRepository | undefined>('workspace_open_recent_repository', { id });
    },

    renameRecentRepository(id: string, name: string): Promise<void> {
      return invoke<void>('workspace_rename_recent_repository', { id, name });
    },

    async moveRecentRepository(id: string): Promise<boolean> {
      const targetParentPath = await choosePath({ kind: 'folder' });
      if (!targetParentPath) return false;
      return invoke<boolean>('workspace_move_recent_repository', { id, targetParentPath });
    },

    revealRecentRepository(id: string): Promise<void> {
      return invoke<boolean>('workspace_reveal_recent_repository', { id }).then(() => undefined);
    },

    removeRecentRepository(id: string): Promise<void> {
      return invoke<void>('workspace_remove_recent_repository', { id });
    },

    takeInitialOpenFile(): Promise<WorkspaceOpenFileRequest | undefined> {
      const filePath = typeof window === 'undefined'
        ? undefined
        : new URLSearchParams(window.location.search).get('initialFilePath')?.trim() || undefined;
      return invoke<WorkspaceOpenFileRequest | undefined>('workspace_take_initial_open_file', { filePath });
    },

    recordClosedTab(request: TaskbarClosedTabRequest): Promise<void> {
      return invoke<void>('taskbar_record_closed_tab', { request });
    },

    openInNewWindow(relativePath: string): Promise<boolean> {
      return invoke<boolean>('workspace_open_in_new_window', { requestedRelativePath: relativePath });
    },

    openWithSystem(relativePath: string): Promise<boolean> {
      return invoke<boolean>('workspace_open_with_system', { relativePath });
    },

    revealInFileManager(relativePath: string): Promise<boolean> {
      return invoke<boolean>('workspace_reveal_in_file_manager', { relativePath });
    },

    copyPath(relativePath: string, kind: WorkspaceCopyPathKind): Promise<boolean> {
      return invoke<boolean>('workspace_copy_path', { requestedRelativePath: relativePath, kind });
    },

    listFiles(): Promise<WorkspaceFileEntry[]> {
      return invoke<WorkspaceFileEntry[]>('workspace_list_files');
    },

    listMarkdownFiles(): Promise<WorkspaceMarkdownFileMetadata[]> {
      return invoke<WorkspaceMarkdownFileMetadata[]>('workspace_list_markdown_files');
    },

    openFile(
      filePath: string,
      disposition: 'current-group' | 'new-group' = 'current-group'
    ): Promise<WorkspaceOpenFileRequest | undefined> {
      return invoke<WorkspaceOpenFileRequest | undefined>('workspace_open_file', {
        filePath,
        disposition
      });
    },

    listDirectories(): Promise<WorkspaceDirectoryEntry[]> {
      return invoke<WorkspaceDirectoryEntry[]>('workspace_list_directories');
    },

    moveFile(request: WorkspaceMoveFileRequest): Promise<WorkspaceMoveFileResult> {
      return invoke<WorkspaceMoveFileResult>('workspace_move_file', { request });
    },

    readMarkdownFile(path: string): Promise<WorkspaceMarkdownFile | undefined> {
      return invoke<WorkspaceMarkdownFile | undefined>('workspace_read_markdown_file', { path });
    },

    updateMarkdownFile(request: UpdateWorkspaceMarkdownFileRequest): Promise<UpdateWorkspaceMarkdownFileResult> {
      return invoke<UpdateWorkspaceMarkdownFileResult>('workspace_update_markdown_file', { request });
    },

    createDateNote(request: CreateWorkspaceDateNoteRequest): Promise<CreateWorkspaceDateNoteResult> {
      return invoke<CreateWorkspaceDateNoteResult>('workspace_create_date_note', { request });
    },

    importExternalMediaFile(
      request: WorkspaceImportExternalMediaFileRequest
    ): Promise<WorkspaceImportExternalMediaFileResult> {
      return invoke<WorkspaceImportExternalMediaFileResult>('workspace_import_external_media_file', { request });
    },

    onOpenFileRequested(listener: (request: IpcEventMap['workspace:openFileRequested']) => void): () => void {
      return subscribeEvent('workspace:openFileRequested', listener);
    },

    onCloseTabsRequested(listener: (request: IpcEventMap['workspace:closeTabsRequested']) => void): () => void {
      return subscribeEvent('workspace:closeTabsRequested', listener);
    },

    onRepositoryChanged(listener: (repository: IpcEventMap['workspace:repositoryChanged']) => void): () => void {
      return subscribe('workspace:repositoryChanged', listener);
    },

    onDirectoryChanged(listener: (event: IpcEventMap['workspace:directoryChanged']) => void): () => void {
      return subscribe('workspace:directoryChanged', listener);
    },

    onFileChanged(listener: (event: IpcEventMap['workspace:fileChanged']) => void): () => void {
      return subscribeEvent('workspace:fileChanged', listener);
    }
  }
};
