/**
 * 文件说明：统一维护渲染进程的当前仓库身份，并协调仓库切换与文件打开事件。
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { workspaceApi } from '@/api/workspace';
import { useDockingThreeStore } from '@/store/dockingThree';
import { useFootnoteReferenceStore } from '@/store/footnoteReferences';
import type {
  CreateWorkspaceDateNoteResult,
  UpdateWorkspaceMarkdownFileResult,
  WorkspaceCopyPathKind,
  WorkspaceDirectoryChangedEvent,
  WorkspaceDirectoryEntry,
  WorkspaceFileChangedEvent,
  WorkspaceFileEntry,
  WorkspaceMoveFileResult,
  WorkspaceOpenFileRequest
} from '@/types/ipc';
import type { PluginRepository } from '../../plugin/sdk';
import type { WorkspaceRecentRepository } from '@/types/ipc';
import type { WorkbenchListPickerItem } from '@/types/dialog';

const MOVE_FILE_ERROR_MESSAGES: Readonly<Record<
  Extract<WorkspaceMoveFileResult, { status: 'rejected' }>['reason'],
  string
>> = {
  'outside-workspace': '文件或目标目录不属于当前仓库。',
  'source-not-found': '源文件不存在或已经被移动。',
  'source-not-file': '当前标签关联的条目不是普通文件。',
  'target-not-found': '目标目录不存在。',
  'target-not-directory': '选择的目标不是目录。',
  'target-exists': '目标目录中已存在同名文件。',
  'same-directory': '文件已经位于所选目录。',
  'io-error': '移动文件失败，请检查文件权限后重试。',
  'bridge-unavailable': '工作区文件服务当前不可用。'
};

const DATE_NOTE_ERROR_MESSAGES: Readonly<Record<
  Extract<CreateWorkspaceDateNoteResult, { status: 'rejected' }>['reason'],
  string
>> = {
  'invalid-date': '日期无效，无法创建笔记。',
  'outside-workspace': '当前文件不属于工作区。',
  'source-not-found': '当前文件不存在，无法确定创建目录。',
  'source-not-file': '当前标签未关联普通文件。',
  'unsupported-encoding': '无法读取已有日期笔记。',
  'io-error': '创建日期笔记失败，请检查文件权限。',
  'bridge-unavailable': '工作区文件服务当前不可用。'
};

/** 渲染进程当前仓库及其宿主事件生命周期 Store。 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const repository = ref<PluginRepository>();
  const initialized = ref(false);
  const directories = ref<WorkspaceDirectoryEntry[]>([]);
  const directoriesLoading = ref(false);
  const workspaceFiles = ref<WorkspaceFileEntry[]>([]);
  const fileMovePending = ref(false);
  const fileMoveError = ref<string>();
  const dateNoteCreationPending = ref(false);
  const dateNoteCreationError = ref<string>();
  const savingEditorTabIds = new Set<string>();
  const directoryItems = computed<WorkbenchListPickerItem[]>(() => (
    directories.value.map(directory => ({
        label: directory.relativePath ? directory.name : '/',
        id: directory.relativePath || '.',
        depth: directory.relativePath ? directory.relativePath.split('/').length : 0
      }))
  ));
  let eventDisposers: Array<() => void> = [];

  /** 重新扫描当前仓库的 Markdown 文件索引，并在失败时保留工作台可用状态。 */
  async function refreshProjectIndex(): Promise<void> {
    try {
      const [, files] = await Promise.all([
        useFootnoteReferenceStore().refreshProjectIndex(),
        workspaceApi.listFiles()
      ]);
      workspaceFiles.value = files;
    } catch (error) {
      console.error('[workspace] Failed to refresh project index:', error);
    }
  }

    /** 应用仓库切换，关闭所有旧仓库编辑器标签。 */
  function handleRepositoryChanged(nextRepository: PluginRepository): void {
    const previousRepositoryId = repository.value?.id;
    repository.value = nextRepository;
    workspaceFiles.value = [];

    if (previousRepositoryId && previousRepositoryId !== nextRepository.id) {
      const dockingStore = useDockingThreeStore();
      dockingStore.clearRecentWorkspaceFiles();
      dockingStore.closeAllEditorGroups(false);
    }

    void refreshProjectIndex();
  }

  /** 将主进程已验证的仓库文件交给 DockingThree 路由到文本或媒体标签。 */
  function handleOpenFileRequested(request: WorkspaceOpenFileRequest): void {
    if (repository.value?.id !== request.repositoryId) {
      return;
    }

    useDockingThreeStore().openWorkspaceFile(request);
  }

  /** 鎺ユ敹鎻掍欢璇锋眰锛屽叧闂綋鍓嶄粨搴撳搴旂殑鏂囦欢鏍囩銆?*/
  function handleCloseTabsRequested(request: { paths?: readonly string[] }): void {
    const docking = useDockingThreeStore();
    if (request.paths) {
      docking.closeWorkspaceFileTabsByPath(request.paths);
    } else {
      docking.closeAllEditorGroups();
    }
  }

  /** 将当前仓库的目录变化交给文件列表 Store 做稳定增量同步。 */
  function handleDirectoryChanged(event: WorkspaceDirectoryChangedEvent): void {
    if (repository.value?.id !== event.repositoryId) return;
    void loadDirectories();
    void refreshProjectIndex();
  }

  /** 接收 Rust 细粒度文件变化事件，复用现有索引和目录刷新流程。 */
  function handleFileChanged(event: WorkspaceFileChangedEvent): void {
    if (repository.value?.id !== event.repositoryId) return;
    void loadDirectories();
    void refreshProjectIndex();
  }

  /** 读取初始仓库并注册主进程工作区事件。 */
  async function initialize(): Promise<void> {
    if (initialized.value) {
      return;
    }

    initialized.value = true;
    eventDisposers = [
      workspaceApi.onRepositoryChanged(handleRepositoryChanged),
      workspaceApi.onDirectoryChanged(handleDirectoryChanged),
      workspaceApi.onFileChanged(handleFileChanged),
      workspaceApi.onOpenFileRequested(handleOpenFileRequested),
      workspaceApi.onCloseTabsRequested(handleCloseTabsRequested)
    ];
    const currentRepository = await workspaceApi.getRepository();

    if (!initialized.value) {
      return;
    }

    repository.value = currentRepository;
    const initialOpenFileRequest = await workspaceApi.takeInitialOpenFile();
    if (initialOpenFileRequest) handleOpenFileRequested(initialOpenFileRequest);
    await refreshProjectIndex();
  }

  /** 打开系统目录选择器；仓库状态由随后到达的切换事件统一更新。 */
  async function openRepository(): Promise<PluginRepository | undefined> {
    return workspaceApi.openRepository();
  }

  /** 创建并切换到新的默认仓库。 */
  async function createRepository(name?: string, parentPath?: string): Promise<PluginRepository | undefined> {
    return workspaceApi.createRepository(name, parentPath);
  }

  /** 选择新仓库的保存位置。 */
  async function selectRepositoryLocation(): Promise<string | undefined> {
    return workspaceApi.selectRepositoryLocation();
  }

  /** 获取新仓库默认保存位置的真实路径。 */
  async function getDefaultRepositoryLocation(): Promise<string> {
    return workspaceApi.getDefaultRepositoryLocation();
  }

  /** 读取最近仓库列表。 */
  async function listRecentRepositories(): Promise<WorkspaceRecentRepository[]> {
    return workspaceApi.listRecentRepositories();
  }

  /** 打开最近仓库。 */
  async function openRecentRepository(id: string): Promise<PluginRepository | undefined> {
    return workspaceApi.openRecentRepository(id);
  }

  /** 使用系统默认应用打开当前仓库内文件。 */
  async function openWithSystem(relativePath: string): Promise<boolean> {
    return workspaceApi.openWithSystem(relativePath);
  }

  /** 在系统文件管理器中定位当前仓库内条目。 */
  async function revealInFileManager(relativePath: string): Promise<boolean> {
    return workspaceApi.revealInFileManager(relativePath);
  }

  /** 复制仓库条目的绝对路径、仓库根路径或内容根路径。 */
  async function copyPath(relativePath: string, kind: WorkspaceCopyPathKind): Promise<boolean> {
    return workspaceApi.copyPath(relativePath, kind);
  }

  /** 在新的完整工作台窗口中打开仓库文件标签。 */
  async function openInNewWindow(relativePath: string): Promise<boolean> {
    return workspaceApi.openInNewWindow(relativePath);
  }

  /** 复用宿主文件校验与 DockingThree 标签路由，在当前组打开或激活文件标签。 */
  async function openInNewTab(filePath: string): Promise<boolean> {
    const request = await workspaceApi.openFile(filePath, 'current-group');
    if (!request || repository.value?.id !== request.repositoryId) return false;
    handleOpenFileRequested(request);
    return true;
  }

  /** 加载当前仓库可用的文件移动目标目录。 */
  async function loadDirectories(): Promise<WorkspaceDirectoryEntry[]> {
    directoriesLoading.value = true;
    fileMoveError.value = undefined;
    try {
      directories.value = await workspaceApi.listDirectories();
      return directories.value;
    } catch {
      directories.value = [];
      fileMoveError.value = '无法读取仓库目录。';
      return [];
    } finally {
      directoriesLoading.value = false;
    }
  }

  /** 将文件移动到当前仓库目录，并同步所有打开标签的路径。 */
  async function moveFile(
    sourceRelativePath: string,
    targetDirectoryRelativePath: string
  ): Promise<WorkspaceMoveFileResult> {
    fileMovePending.value = true;
    fileMoveError.value = undefined;
    try {
      const result = await workspaceApi.moveFile({ sourceRelativePath, targetDirectoryRelativePath });
      if (result.status === 'moved') {
        useDockingThreeStore().updateWorkspaceFilePath(
          sourceRelativePath,
          result.filePath,
          result.relativePath
        );
        directories.value = [];
        void refreshProjectIndex();
      } else {
        fileMoveError.value = MOVE_FILE_ERROR_MESSAGES[result.reason];
      }
      return result;
    } catch {
      const result: WorkspaceMoveFileResult = { status: 'rejected', reason: 'io-error' };
      fileMoveError.value = MOVE_FILE_ERROR_MESSAGES[result.reason];
      return result;
    } finally {
      fileMovePending.value = false;
    }
  }

  /** 在当前笔记目录创建日期笔记，并在当前编辑器组打开创建结果。 */
  async function createDateNote(
    sourceFilePath: string,
    date: string
  ): Promise<CreateWorkspaceDateNoteResult> {
    dateNoteCreationPending.value = true;
    dateNoteCreationError.value = undefined;

    try {
      const result = await workspaceApi.createDateNote({ sourceFilePath, date });
      if (result.status === 'rejected') {
        dateNoteCreationError.value = DATE_NOTE_ERROR_MESSAGES[result.reason];
        return result;
      }

      const repositoryId = repository.value?.id;
      if (!repositoryId) {
        const rejectedResult: CreateWorkspaceDateNoteResult = {
          status: 'rejected',
          reason: 'bridge-unavailable'
        };
        dateNoteCreationError.value = DATE_NOTE_ERROR_MESSAGES[rejectedResult.reason];
        return rejectedResult;
      }

      const title = result.file.relativePath.replace(/\\/g, '/').split('/').pop()
        ?? `${date.replace(/\//gu, '-')}.md`;
      useDockingThreeStore().openWorkspaceFile({
        repositoryId,
        filePath: result.file.path,
        relativePath: result.file.relativePath,
        title,
        kind: 'text',
        content: result.file.content
      });
      await refreshProjectIndex();
      return result;
    } catch {
      const result: CreateWorkspaceDateNoteResult = {
        status: 'rejected',
        reason: 'io-error'
      };
      dateNoteCreationError.value = DATE_NOTE_ERROR_MESSAGES[result.reason];
      return result;
    } finally {
      dateNoteCreationPending.value = false;
    }
  }

  /** 保存当前活动编辑器关联的 Markdown 文件，并在未发生后续输入时更新保存基线。 */
  async function saveActiveEditor(): Promise<UpdateWorkspaceMarkdownFileResult | undefined> {
    const dockingThreeStore = useDockingThreeStore();
    const activeTab = dockingThreeStore.activeEditorTab;
    const filePath = activeTab?.filePath;

    if (!activeTab || !filePath || activeTab.temporary) {
      return undefined;
    }

    if (savingEditorTabIds.has(activeTab.id)) {
      return undefined;
    }

    const content = dockingThreeStore.editorDocuments[activeTab.id];
    const baseline = dockingThreeStore.getEditorDocumentBaseline(activeTab.id);

    if (content === undefined || baseline === undefined) {
      return undefined;
    }

    savingEditorTabIds.add(activeTab.id);

    try {
      const result = await useFootnoteReferenceStore().persistMarkdownFileContent(
        filePath,
        baseline,
        content
      );

      if (result.status === 'updated' || result.status === 'unchanged') {
        dockingThreeStore.updateEditorDocumentBaselineByFilePath(
          filePath,
          content,
          result.file.content
        );
      }

      return result;
    } finally {
      savingEditorTabIds.delete(activeTab.id);
    }
  }

  /** 释放工作区事件监听，避免工作台重复挂载时累积回调。 */
  function dispose(): void {
    initialized.value = false;

    for (const disposeEvent of eventDisposers) {
      disposeEvent();
    }

    eventDisposers = [];
  }

  return {
    repository,
    directories,
    workspaceFiles,
    directoryItems,
    directoriesLoading,
    fileMovePending,
    fileMoveError,
    dateNoteCreationPending,
    dateNoteCreationError,
    initialized,
    initialize,
    openRepository,
    createRepository,
    selectRepositoryLocation,
    getDefaultRepositoryLocation,
    listRecentRepositories,
    openRecentRepository,
    openWithSystem,
    revealInFileManager,
    copyPath,
    openInNewWindow,
    openInNewTab,
    loadDirectories,
    moveFile,
    createDateNote,
    saveActiveEditor,
    dispose
  };
});
