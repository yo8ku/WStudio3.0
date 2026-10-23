/**
 * 文件说明：通过 Tauri 调用 Rust 工作区文件和仓库服务。
 */
import type {
  CreateWorkspaceDateNoteRequest,
  CreateWorkspaceDateNoteResult,
  IpcEventMap,
  UpdateWorkspaceMarkdownFileRequest,
  UpdateWorkspaceMarkdownFileResult,
  WorkspaceImportExternalMediaFileRequest,
  WorkspaceImportExternalMediaFileResult,
  WorkspaceFileEntry,
  WorkspaceFileChangedEvent,
  WorkspaceMarkdownFile,
  WorkspaceMarkdownFileMetadata,
  WorkspaceOpenFileRequest,
  TaskbarClosedTabRequest,
  WorkspaceCopyPathKind
} from '@/types/ipc';
import type {
  WorkspaceDirectoryEntry,
  WorkspaceMoveFileRequest,
  WorkspaceMoveFileResult
} from '@/types/ipc';
import type { WorkspacePickEntryOptions } from '@/types/ipc';

import { nativeApi } from './native';
import type { PluginRepository } from '../../plugin/sdk';

export const workspaceApi = {
  /** 获取当前仓库公开身份，不暴露本机绝对路径。 */
  getRepository(): Promise<PluginRepository | undefined> {
    return nativeApi.workspace.getRepository();
  },

  /** 请求宿主选择工作区内文件或目录，并仅返回相对路径。 */
  pickEntry(options: WorkspacePickEntryOptions): Promise<string | undefined> {
    return nativeApi.workspace.pickEntry(options);
  },

  /** 请求主进程打开系统目录选择器。 */
  openRepository(): Promise<PluginRepository | undefined> {
    return nativeApi.workspace.openRepository();
  },

  /** 创建并切换到系统文档目录下的新仓库。 */
  createRepository(name?: string, parentPath?: string): Promise<PluginRepository | undefined> {
    return nativeApi.workspace.createRepository(name, parentPath);
  },

  /** 请求用户选择新仓库的父目录。 */
  selectRepositoryLocation(): Promise<string | undefined> {
    return nativeApi.workspace.selectRepositoryLocation();
  },

  /** 获取宿主系统文档目录的真实绝对路径。 */
  getDefaultRepositoryLocation(): Promise<string> {
    return nativeApi.workspace.getDefaultRepositoryLocation();
  },

  /** 获取最近打开的仓库列表。 */
  listRecentRepositories() {
    return nativeApi.workspace.listRecentRepositories();
  },

  /** 按最近仓库标识切换仓库。 */
  openRecentRepository(id: string): Promise<PluginRepository | undefined> {
    return nativeApi.workspace.openRecentRepository(id);
  },

  renameRecentRepository(id: string, name: string): Promise<void> {
    return nativeApi.workspace.renameRecentRepository(id, name);
  },

  moveRecentRepository(id: string): Promise<boolean> {
    return nativeApi.workspace.moveRecentRepository(id);
  },

  revealRecentRepository(id: string): Promise<void> {
    return nativeApi.workspace.revealRecentRepository(id);
  },

  removeRecentRepository(id: string): Promise<void> {
    return nativeApi.workspace.removeRecentRepository(id);
  },

  /** 使用操作系统默认应用打开仓库内文件。 */
  openWithSystem(relativePath: string): Promise<boolean> {
    return nativeApi.workspace.openWithSystem(relativePath);
  },

  /** 在操作系统文件管理器中定位仓库内条目。 */
  revealInFileManager(relativePath: string): Promise<boolean> {
    return nativeApi.workspace.revealInFileManager(relativePath);
  },

  /** 由主进程解析并复制指定形式的可信仓库路径。 */
  copyPath(relativePath: string, kind: WorkspaceCopyPathKind): Promise<boolean> {
    return nativeApi.workspace.copyPath(relativePath, kind);
  },

  /** 请求主进程创建新工作台窗口并准备打开指定仓库文件。 */
  openInNewWindow(relativePath: string): Promise<boolean> {
    return nativeApi.workspace.openInNewWindow(relativePath);
  },

  /** 枚举当前仓库内可作为移动目标的目录。 */
  listDirectories(): Promise<WorkspaceDirectoryEntry[]> {
    return nativeApi.workspace.listDirectories();
  },

  /** 将当前仓库内文件移动到指定仓库目录。 */
  moveFile(request: WorkspaceMoveFileRequest): Promise<WorkspaceMoveFileResult> {
    return nativeApi.workspace.moveFile(request);
  },

  /** 将外部媒体复制到当前 Markdown 所在目录，并返回仓库内引用路径。 */
  importExternalMediaFile(
    request: WorkspaceImportExternalMediaFileRequest
  ): Promise<WorkspaceImportExternalMediaFileResult> {
    return nativeApi.workspace.importExternalMediaFile(request);
  },

  /** 领取当前窗口启动时绑定的可信文件打开请求。 */
  takeInitialOpenFile(): Promise<IpcEventMap['workspace:openFileRequested'] | undefined> {
    return nativeApi.workspace.takeInitialOpenFile();
  },

  /** 将文件标签加入任务栏最近关闭列表。 */
  recordClosedTab(request: TaskbarClosedTabRequest): Promise<void> {
    return nativeApi.workspace.recordClosedTab(request);
  },

  /** 枚举并读取当前工作区中的全部 Markdown 文件。 */
  listMarkdownFiles(): Promise<WorkspaceMarkdownFileMetadata[]> {
    return nativeApi.workspace.listMarkdownFiles();
  },

  /** 按需读取单个 Markdown 正文，索引阶段不保留全量内容。 */
  readMarkdownFile(filePath: string): Promise<WorkspaceMarkdownFile | undefined> {
    return nativeApi.workspace.readMarkdownFile(filePath);
  },

  /** 请求主进程验证并构造工作区文件打开请求。 */
  openFile(
    filePath: string,
    disposition: 'current-group' | 'new-group' = 'current-group'
  ): Promise<WorkspaceOpenFileRequest | undefined> {
    return nativeApi.workspace.openFile(filePath, disposition);
  },

  /** 枚举当前工作区中的全部文件条目，不读取文件内容。 */
  listFiles(): Promise<WorkspaceFileEntry[]> {
    return nativeApi.workspace.listFiles();
  },

  /** 以期望内容为版本条件写入单个工作区 Markdown 文件。 */
  updateMarkdownFile(
    request: UpdateWorkspaceMarkdownFileRequest
  ): Promise<UpdateWorkspaceMarkdownFileResult> {
    return nativeApi.workspace.updateMarkdownFile(request);
  },

  /** 在当前笔记目录创建日期命名的 Markdown 笔记。 */
  createDateNote(
    request: CreateWorkspaceDateNoteRequest
  ): Promise<CreateWorkspaceDateNoteResult> {
    return nativeApi.workspace.createDateNote(request);
  },

  /** 订阅仓库切换事件，并返回监听释放函数。 */
  onRepositoryChanged(
    listener: (repository: IpcEventMap['workspace:repositoryChanged']) => void
  ): () => void {
    return nativeApi.workspace.onRepositoryChanged(listener);
  },

  /** 订阅仓库目录内容变化，并返回监听释放函数。 */
  onDirectoryChanged(
    listener: (event: IpcEventMap['workspace:directoryChanged']) => void
  ): () => void {
    return nativeApi.workspace.onDirectoryChanged(listener);
  },

  /** 订阅主进程已验证文件的编辑器打开请求。 */
  onFileChanged(listener: (event: WorkspaceFileChangedEvent) => void): () => void {
    return nativeApi.workspace.onFileChanged(listener);
  },

  onOpenFileRequested(
    listener: (request: IpcEventMap['workspace:openFileRequested']) => void
  ): () => void {
    return nativeApi.workspace.onOpenFileRequested(listener);
  },
  onCloseTabsRequested(listener: (request: IpcEventMap['workspace:closeTabsRequested']) => void): () => void {
    return nativeApi.workspace.onCloseTabsRequested(listener);
  },
};
