/**
 * 文件说明：定义 WStudio 3.0 第三方插件包和 Plugin SDK 的公开 TypeScript 契约。
 */

import type { DisposableStore } from './disposables';

export type PluginTrustLevel = 'standard' | 'privileged';
export type PluginApiVersion = '1.0';
export type PluginViewRegion = 'left-sidebar' | 'editor' | 'right-sidebar' | 'bottom';
export type PluginViewCapability = 'webViewer';

export interface Disposable {
  dispose(): void;
}

export type PluginPermissionId =
  | 'workspace.read'
  | 'workspace.write'
  | 'workspace.open'
  | 'window.manage'
  | 'network.request'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'notifications.show'
  | 'notifications.system'
  | 'dialogs.show'
  | 'external.open'
  | 'webViewer.navigate'
  | 'storage.plugin'
  | 'editor.read'
  | 'editor.write'
  | 'renderer.code'
  | 'node.fs'
  | 'node.process'
  | 'node.native'
  | 'electron.system';

export type PluginActivationEvent =
  | 'onStartupFinished'
  | `onCommand:${string}`
  | `onView:${string}`
  | `onLanguage:${string}`
  | `workspaceContains:${string}`;

export interface PluginAuthor {
  name: string;
  url?: string;
}

export interface PluginPermissionRequest {
  id: PluginPermissionId;
  reason: string;
  scope?: readonly string[];
}

export interface PluginCommandContribution {
  id: string;
  title: string;
  description?: string;
}

export interface PluginViewContribution {
  type: string;
  title: string;
  region?: PluginViewRegion;
  multiple?: boolean;
  /** 插件运行后由工作台自动创建该视图，核心与第三方插件使用相同规则。 */
  openOnStartup?: boolean;
  /** 声明视图需要的通用宿主集成，不绑定具体插件 ID。 */
  capabilities?: readonly PluginViewCapability[];
}

/** 描述宿主返回给工作台的视图贡献，包含已解析的插件资源图标 URL。 */
export interface PluginViewContributionSummary extends PluginViewContribution {
  iconUrl?: string;
}

export type PluginSettingFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'file'
  | 'folder';

export type PluginSettingValue = string | number | boolean;

/** 声明字段值比较条件，供宿主控制设置项可见性和禁用状态。 */
export interface PluginSettingValueCondition {
  fieldId: string;
  operator: 'equals' | 'not-equals';
  value: PluginSettingValue;
}

/** 支持固定布尔值或依赖同页字段值的声明式条件。 */
export type PluginSettingCondition = boolean | PluginSettingValueCondition;

/** 声明字符串不能为空的宿主校验规则。 */
export interface PluginSettingRequiredValidation {
  type: 'required';
  message: string;
}

/** 声明字符串最小长度的宿主校验规则。 */
export interface PluginSettingMinLengthValidation {
  type: 'minLength';
  value: number;
  message: string;
}

/** 声明字符串最大长度的宿主校验规则。 */
export interface PluginSettingMaxLengthValidation {
  type: 'maxLength';
  value: number;
  message: string;
}

/** 声明字符串正则表达式的宿主校验规则。 */
export interface PluginSettingPatternValidation {
  type: 'pattern';
  value: string;
  flags?: string;
  message: string;
}

/** 宿主可跨进程执行的声明式设置校验规则。 */
export type PluginSettingValidationRule =
  | PluginSettingRequiredValidation
  | PluginSettingMinLengthValidation
  | PluginSettingMaxLengthValidation
  | PluginSettingPatternValidation;

export interface PluginSettingOption {
  label: string;
  value: string;
}

export interface PluginSettingFieldBase {
  id: string;
  label: string;
  description?: string;
  visible?: PluginSettingCondition;
  disabled?: PluginSettingCondition;
  validate?: readonly PluginSettingValidationRule[];
}

export interface PluginSettingTextField extends PluginSettingFieldBase {
  type: 'text';
  defaultValue?: string;
  placeholder?: string;
}

export interface PluginSettingNumberField extends PluginSettingFieldBase {
  type: 'number';
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface PluginSettingBooleanField extends PluginSettingFieldBase {
  type: 'boolean';
  defaultValue?: boolean;
}

export interface PluginSettingSelectField extends PluginSettingFieldBase {
  type: 'select';
  defaultValue?: string;
  options: readonly PluginSettingOption[];
}

/** 选择工作区内相对文件路径的设置字段。 */
export interface PluginSettingFileField extends PluginSettingFieldBase {
  type: 'file';
  defaultValue?: string;
  extensions?: readonly string[];
}

/** 选择工作区内相对目录路径的设置字段。 */
export interface PluginSettingFolderField extends PluginSettingFieldBase {
  type: 'folder';
  defaultValue?: string;
}

export type PluginSettingField =
  | PluginSettingTextField
  | PluginSettingNumberField
  | PluginSettingBooleanField
  | PluginSettingSelectField
  | PluginSettingFileField
  | PluginSettingFolderField;

/** 将一组设置字段组织为同一列表内的命名分区。 */
export interface PluginSettingGroup {
  type: 'group';
  id: string;
  title: string;
  description?: string;
  visible?: PluginSettingCondition;
  disabled?: PluginSettingCondition;
  items: readonly PluginSettingField[];
}

/** 设置页中用于展示只读宿主状态的安全声明式特殊行。 */
export interface PluginSettingStatusRow {
  type: 'status';
  id: string;
  label: string;
  description?: string;
  value?: string;
  visible?: PluginSettingCondition;
}

/** 设置页中的子页面入口；子页面仍由同一列表组件渲染。 */
export interface PluginSettingPage {
  type: 'page';
  id: string;
  title: string;
  description?: string;
  visible?: PluginSettingCondition;
  disabled?: PluginSettingCondition;
  items: readonly PluginSettingDefinition[];
}

/** 设置页可返回的字段、分组、子页面或安全特殊行。 */
export type PluginSettingDefinition =
  | PluginSettingField
  | PluginSettingGroup
  | PluginSettingPage
  | PluginSettingStatusRow;

export interface PluginSettingContribution {
  id: string;
  title: string;
  description?: string;
  fields?: readonly PluginSettingField[];
  definitions?: readonly PluginSettingDefinition[];
}

/** 处理宿主已持久化的插件设置字段变更。 */
export type PluginSettingChangeHandler =
  (value: PluginSettingValue) => void | Promise<void>;

/** 描述当前插件单个设置页中已经持久化的字段变更。 */
export interface PluginSettingChangeEvent {
  settingId: string;
  fieldId: string;
  value: PluginSettingValue;
}

/** 处理当前插件指定设置页中的任意字段变更。 */
export type PluginSettingPageChangeHandler =
  (event: PluginSettingChangeEvent) => void | Promise<void>;

/** 提供与 Obsidian getSettingDefinitions 对齐的代码侧声明入口。 */
export interface PluginSettingPageRegistration {
  id: string;
  title?: string;
  description?: string;
  getSettingDefinitions(): readonly PluginSettingDefinition[];
}

/** 描述发送给宿主的可序列化设置页定义。 */
export interface PluginSettingPageDefinition {
  id: string;
  title?: string;
  description?: string;
  definitions?: readonly PluginSettingDefinition[];
}

/** 提供设置页注册完成状态和提前释放能力。 */
export interface PluginSettingPageRegistrationHandle extends Disposable {
  readonly ready: Promise<void>;
}

export interface PluginStatusBarContribution {
  id: string;
  text: string;
  tooltip?: string;
}

export interface PluginContributions {
  commands: readonly PluginCommandContribution[];
  views: readonly PluginViewContribution[];
  settings: readonly PluginSettingContribution[];
  statusBar: readonly PluginStatusBarContribution[];
}

/** 描述当前已运行插件可供工作台消费的贡献集合。 */
export interface PluginContributionSummary {
  /** 当前 Tauri 资源宿主代次；停用、重启和权限变化后失效。 */
  runtimeId?: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  trustLevel: PluginTrustLevel;
  /** 宿主可直接导入的插件入口 URL，所有插件使用同一公开运行时。 */
  entryUrl: string;
  /** 插件根样式 URL，由宿主分别挂载到每个插件视图的 ShadowRoot。 */
  stylesUrl: string;
  commands: readonly PluginCommandContribution[];
  views: readonly PluginViewContributionSummary[];
  settings: readonly PluginSettingContribution[];
  statusBar: readonly PluginStatusBarContribution[];
}

export interface PluginManifest {
  $schema?: string;
  id: string;
  name: string;
  version: string;
  description: string;
  author: PluginAuthor;
  license?: string;
  homepage?: string;
  repository?: string;
  /** 插件包内的图标相对路径，运行时由宿主解析为活动栏资源 URL。 */
  icon?: string;
  keywords?: readonly string[];
  minAppVersion: string;
  apiVersion: PluginApiVersion;
  main: string;
  /** 可选的独立进程声明；未提供时继续使用共享 Renderer Host。 */
  sidecar?: PluginSidecarManifest;
  activationEvents: readonly PluginActivationEvent[];
  permissions: readonly PluginPermissionRequest[];
  contributes: PluginContributions;
}

export interface PluginSidecarManifest {
  type: 'sidecar';
  executable: string;
  args?: readonly string[];
}

export interface PluginIdentity {
  id: string;
  name: string;
  version: string;
  trustLevel: PluginTrustLevel;
}

export interface PluginCommandExecutionContext {
  signal: AbortSignal;
}

export type PluginCommandHandler =
  (context: PluginCommandExecutionContext) => void | Promise<void>;

export interface CommandsApi {
  register(id: string, handler: PluginCommandHandler): Disposable;
}

/** 宿主公开图标库的稳定 kebab-case 名称。 */
export type PluginIconName = string;

/** 在插件 DOM 中插入宿主真实 SVG 的公开接口。 */
export interface IconsApi {
  /** 判断当前宿主版本是否提供指定图标。 */
  hasIcon(iconName: PluginIconName): boolean;
  /** 清空目标元素并插入一个继承 currentColor 的真实 SVG。 */
  setIcon(element: Element, iconName: PluginIconName): SVGSVGElement;
}

export type PluginFileType = 'file' | 'directory';

/** 描述工作区内不包含文件正文的文件系统条目。 */
export interface PluginFileEntry {
  /** 使用 `/` 分隔的工作区相对路径。 */
  path: string;
  /** 条目的最后一段名称。 */
  name: string;
  /** 条目是文件还是目录。 */
  type: PluginFileType;
  /** 文件字节数；目录由宿主返回文件系统统计值。 */
  size: number;
  /** 最后修改时间的 Unix 毫秒时间戳。 */
  modifiedAt: number;
  /** 创建时间的 Unix 毫秒时间戳。 */
  createdAt: number;
  /** 是否为 WStudio 文件系统生成的加密文件；目录始终为 false。 */
  encrypted?: boolean;
}

/** 描述宿主成功解码的 UTF-8 文本文件快照。 */
export interface PluginTextFile extends PluginFileEntry {
  type: 'file';
  encoding: 'utf-8';
  content: string;
}

/** 控制工作区文件列表查询。 */
export interface PluginFileListOptions {
  /** 查询起点，默认为工作区根目录 `.`。 */
  directory?: string;
  /** 是否递归读取子目录，默认为 false。 */
  recursive?: boolean;
  /** 可选扩展名过滤，例如 `.md` 或 `md`。 */
  extensions?: readonly string[];
  /** 最大返回数量，允许范围为 1 到 2000。 */
  limit?: number;
}

/** 文件列表结果；达到数量上限时通过 truncated 提示调用方。 */
export interface PluginFileListResult {
  entries: readonly PluginFileEntry[];
  truncated: boolean;
}

/** 控制工作区文件数量查询。 */

/** 当前仓库的公开身份，不包含本机绝对路径。 */
export interface PluginRepository {
  /** 每次切换仓库都会变化的非路径标识。 */
  id: string;
  /** 仓库根目录名称。 */
  name: string;
}

/** 描述宿主保存的最近仓库公开信息，不包含本机绝对路径。 */
export interface PluginRecentRepository {
  id: string;
  name: string;
  /** 去除盘符和中间目录后的显示路径，不包含完整绝对路径。 */
  displayPath?: string;
}

/** 文本文件比较写入选项。 */
export interface PluginWriteTextOptions {
  /** 调用方读取到的旧内容；不一致时宿主拒绝覆盖。 */
  expectedContent: string;
}

/** 控制目录创建行为。 */
export interface PluginCreateDirectoryOptions {
  /** 是否同时创建缺失的父目录，默认为 false。 */
  recursive?: boolean;
}

/** 控制文件或目录删除行为。 */
export interface PluginDeleteOptions {
  /** 是否允许递归删除非空目录，默认为 false。 */
  recursive?: boolean;
}

/** 控制文件或目录副本创建行为。 */
export interface PluginCopyOptions {
  /** 是否允许复制目录及其全部内容，默认为 false。 */
  recursive?: boolean;
}

/** 第三方插件访问授权工作区文件的稳定接口。 */
export interface FilesystemApi {
  /** 列出权限 scope 内的工作区文件，不返回文件正文。 */
  listFiles(options?: PluginFileListOptions): Promise<PluginFileListResult>;
  /** 列出指定目录直属的授权文件和可继续展开的目录。 */
  listEntries(directory?: string): Promise<readonly PluginFileEntry[]>;
  /** 统计指定目录中的授权文件数量，不返回文件条目数组。 */
  /** 读取权限 scope 内的 UTF-8 文本文件。 */
  readText(path: string): Promise<PluginTextFile>;
  /** 读取权限 scope 内文件或目录的元数据。 */
  stat(path: string): Promise<PluginFileEntry>;
  /** 在旧内容仍匹配时写入现有 UTF-8 文本文件。 */
  writeText(
    path: string,
    content: string,
    options: PluginWriteTextOptions
  ): Promise<PluginTextFile>;
  /** 创建新的 UTF-8 文本文件，目标已存在时拒绝覆盖。 */
  createFile(path: string, content?: string): Promise<PluginTextFile>;
  /** 创建新目录，目标已存在时拒绝覆盖。 */
  createDirectory(
    path: string,
    options?: PluginCreateDirectoryOptions
  ): Promise<PluginFileEntry>;
  /** 删除文件或目录；递归删除必须显式授权。 */
  delete(path: string, options?: PluginDeleteOptions): Promise<void>;
  /** 将文件或目录移动到新的工作区相对路径。 */
  move(sourcePath: string, destinationPath: string): Promise<PluginFileEntry>;
  /** 在当前父目录内重命名文件或目录。 */
  rename(path: string, newName: string): Promise<PluginFileEntry>;
  /** 创建文件或目录副本，目录复制必须显式授权。 */
  copy(
    sourcePath: string,
    destinationPath: string,
    options?: PluginCopyOptions
  ): Promise<PluginFileEntry>;
  /** 使用密码对现有文件执行版本化 AES-256-GCM 原地加密。 */
  encrypt(path: string, password: string): Promise<PluginFileEntry>;
  /** 使用密码对 WStudio 加密文件执行认证解密。 */
  decrypt(path: string, password: string): Promise<PluginFileEntry>;
}

export interface WorkspaceApi {
  /** 返回当前仓库公开身份，不暴露本机绝对路径。 */
  getRepository(): Promise<PluginRepository>;
  /** 在系统桌面创建唯一命名的默认仓库并切换当前工作区。 */
  createRepository(): Promise<PluginRepository | undefined>;
  /** 打开系统目录选择器；取消选择时返回 undefined。 */
  openRepository(): Promise<PluginRepository | undefined>;
  /** 打开系统文件选择器，并在当前工作台创建临时文件标签。 */
  openFile(): Promise<void>;
  /** 返回宿主保存的最近仓库列表。 */
  listRecentRepositories(): Promise<readonly PluginRecentRepository[]>;
  /** 按最近仓库标识切换当前仓库。 */
  openRecentRepository(id: string): Promise<PluginRepository | undefined>;
  /** 重命名宿主保存的最近仓库。 */
  renameRecentRepository(id: string, name: string): Promise<void>;
  /** 将宿主保存的最近仓库移动到用户选择的目录。 */
  moveRecentRepository(id: string): Promise<boolean>;
  /** 在系统资源管理器中显示宿主保存的最近仓库。 */
  revealRecentRepository(id: string): Promise<void>;
  /** 从宿主保存的最近仓库列表中移除仓库，不删除磁盘目录。 */
  removeRecentRepository(id: string): Promise<void>;
  /** 将授权工作区条目的指定路径形式写入系统剪贴板。 */
  copyPath(path: string, kind: 'absolute' | 'repository-root' | 'content-root'): Promise<void>;
  /** 使用操作系统默认应用打开授权工作区文件或目录。 */
  openWithDefaultApp(path: string): Promise<void>;
  /** 在系统资源管理器中定位授权工作区条目。 */
  revealInFileManager(path: string): Promise<void>;
  /** 订阅仓库切换事件。 */
  onDidChange(listener: (repository: PluginRepository) => void): Disposable;
  /** 订阅仓库目录内容变化事件。 */
  onDidChangeDirectory(listener: (event: PluginWorkspaceDirectoryChangeEvent) => void): Disposable;
  /** @deprecated 使用 context.filesystem.listFiles 和 readText。 */
  listMarkdownFiles(): Promise<readonly PluginWorkspaceMarkdownFile[]>;
  /** @deprecated 使用 context.filesystem.readText。 */
  readMarkdownFile(path: string): Promise<PluginWorkspaceMarkdownFile | undefined>;
  /** @deprecated 使用 context.filesystem.writeText。 */
  updateMarkdownFile(path: string, expectedContent: string, content: string): Promise<void>;
  openView(viewType: string, options?: { instanceId?: string }): Promise<void>;
  closeView(viewType: string, instanceId?: string): Promise<void>;
}

/** 仓库目录变化事件，仅包含当前仓库身份和受影响的父目录。 */
export interface PluginWorkspaceDirectoryChangeEvent {
  repositoryId: string;
  parentId?: string;
}

/** 插件可见的窗口种类。 */
export type PluginWindowKind = 'workbench' | 'plugin';
/** 插件可见的窗口状态。 */
export type PluginWindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';
/** 控制打开请求是否复用现有窗口。 */
export type PluginWindowReusePolicy = 'always-new' | 'reuse-focused' | 'reuse-existing';
/** 窗口左上角的屏幕坐标。 */
export interface PluginWindowPosition { x: number; y: number; }
/** 窗口外框尺寸。 */
export interface PluginWindowSize { width: number; height: number; }
/** 窗口位置和尺寸快照。 */
export interface PluginWindowBounds extends PluginWindowPosition, PluginWindowSize {}
/** 不暴露 Electron 实例的稳定窗口快照。 */
export interface PluginWindow {
  id: string;
  kind: PluginWindowKind;
  title?: string;
  state: PluginWindowState;
  bounds: PluginWindowBounds;
  focused: boolean;
  ownerPluginId?: string;
  viewType?: string;
}
/** 打开窗口的稳定参数。 */
export interface PluginWindowOpenOptions {
  kind?: PluginWindowKind;
  title?: string;
  filePath?: string;
  reuse?: PluginWindowReusePolicy;
  /** 初始显示位置；未提供时使用宿主默认位置。 */
  position?: PluginWindowPosition;
  /** 初始窗口尺寸；宽高必须不小于 200。 */
  size?: PluginWindowSize;
  /** 兼容性字段，同时设置初始位置和尺寸。 */
  bounds?: PluginWindowBounds;
  state?: Exclude<PluginWindowState, 'normal'>;
  /** kind 为 plugin 时必须是当前插件 manifest 已声明的视图类型。 */
  viewType?: string;
}
/** 修改窗口公开属性。 */
export interface PluginWindowUpdateOptions {
  title?: string;
  /** 更新窗口显示位置；未提供时保持当前位置。 */
  position?: PluginWindowPosition;
  /** 更新窗口尺寸；宽高必须不小于 200。 */
  size?: PluginWindowSize;
  /** 兼容性字段，同时更新位置和尺寸。 */
  bounds?: PluginWindowBounds;
  state?: PluginWindowState;
}
/** 多窗口管理 API。 */
export interface WindowsApi {
  /** 返回当前插件有权观察的应用窗口快照。 */
  list(): Promise<readonly PluginWindow[]>;
  /** 创建或按策略复用工作台窗口或当前插件的声明视图窗口。 */
  open(options?: PluginWindowOpenOptions): Promise<PluginWindow>;
  /** 修改指定窗口的标题、位置、尺寸或显示状态。 */
  update(windowId: string, options: PluginWindowUpdateOptions): Promise<PluginWindow>;
  /** 显示并聚焦指定窗口。 */
  focus(windowId: string): Promise<void>;
  /** 请求关闭指定窗口。 */
  close(windowId: string): Promise<void>;
  /** 订阅窗口创建、关闭和公开属性变化。 */
  onDidChange(listener: (windows: readonly PluginWindow[]) => void): Disposable;
}

export interface PluginWorkspaceMarkdownFile {
  path: string;
  relativePath: string;
  content: string;
}

/** 插件可读取的活动文本编辑器快照。 */
export interface PluginEditorDocument {
  path: string;
  content: string;
  selection?: PluginEditorRange;
}

/** 编辑器文本范围，偏移量采用 UTF-16 文档索引并使用左闭右开区间。 */
export interface PluginEditorRange {
  start: number;
  end: number;
}

/** 编辑器定位时允许插件请求的稳定纵向对齐策略。 */
export type PluginEditorVerticalAlignment = 'nearest' | 'center' | 'upper-center';

/** 编辑器范围定位的可选视口行为。 */
export interface PluginEditorRevealOptions {
  verticalAlignment?: PluginEditorVerticalAlignment;
}

/** 活动文档变化监听器。 */
export type PluginEditorDocumentChangeHandler = (
  document: PluginEditorDocument | undefined
) => void | Promise<void>;

/** 经过权限网关约束的编辑器公开能力。 */
export interface EditorApi {
  /** 返回当前活动文本编辑器的内存快照。 */
  getActiveDocument(): Promise<PluginEditorDocument | undefined>;
  /** 订阅当前窗口活动文档或正文变化。 */
  onDidChangeActiveDocument(listener: PluginEditorDocumentChangeHandler): Disposable;
  /** 打开授权范围内的默认文本或媒体文件。 */
  openFile(path: string, options?: { disposition?: 'current-group' | 'new-group' }): Promise<void>;
  /** 报告文件拖拽状态，供宿主编辑器计算停靠预览。 */
  beginFileDrag(path: string, title?: string): void;
  updateFileDrag(clientX: number, clientY: number): void;
  endFileDrag(clientX: number, clientY: number): void;
  cancelFileDrag(): void;
  closeTab(path: string): Promise<void>;
  closeTabs(paths: readonly string[]): Promise<void>;
  closeAllTabs(): Promise<void>;
  /** 激活当前文档中的文本范围并按可选策略滚动到可视区域。 */
  revealRange(
    path: string,
    range: PluginEditorRange,
    options?: PluginEditorRevealOptions
  ): Promise<void>;
  /** 使用旧内容快照保护的兼容性全文写入接口。 */
  applyTextChange(path: string, expectedContent: string, content: string): Promise<void>;
}

export interface SettingsApi {
  /** 为 manifest 已声明的页面注册静态字段或代码侧声明定义。 */
  registerPage(
    page: PluginSettingContribution | PluginSettingPageRegistration
  ): PluginSettingPageRegistrationHandle;
  /** 读取当前有效设置页字段的当前值。 */
  get(fieldId: string): Promise<PluginSettingValue | undefined>;
  /** 订阅当前有效字段的宿主持久化变更。 */
  onDidChange(fieldId: string, handler: PluginSettingChangeHandler): Disposable;
  /** 订阅当前有效设置页中的全部宿主持久化变更。 */
  onDidChangePage(
    settingId: string,
    handler: PluginSettingPageChangeHandler
  ): Disposable;
}

export interface StatusBarApi {
  registerItem(item: PluginStatusBarContribution): Disposable;
}

export interface StorageApi {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export type PluginNotificationType = 'normal' | 'warning' | 'error';

export interface PluginNotificationOptions {
  type?: PluginNotificationType;
  title?: string;
  duration?: number;
}

export interface PluginNotificationRequest {
  pluginId: string;
  pluginName: string;
  message: string;
  type: PluginNotificationType;
  title?: string;
  duration?: number;
}

export interface NotificationsApi {
  /** 在 WStudio 工作台内显示应用级通知。 */
  show(message: string, options?: PluginNotificationOptions): Promise<void>;
  /** 显示操作系统级通知，需要额外的 notifications.system 权限。 */
  showSystem(message: string, options?: Pick<PluginNotificationOptions, 'title'>): Promise<void>;
}

/** 插件通用列表选择对话框中的声明式选项。 */
export interface PluginDialogPickItem {
  id: string;
  label: string;
  description?: string;
  depth?: number;
  disabled?: boolean;
}

/** 插件列表选择对话框参数。 */
export interface PluginDialogPickOptions {
  title: string;
  subtitle?: string;
  items: readonly PluginDialogPickItem[];
  currentItemId?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  confirmLabel?: string;
}

/** 仓库管理对话框右侧的操作项。 */
export interface PluginDialogRepositoryAction {
  id: string;
  label: string;
  description: string;
}

/** 文件列表使用的左右分栏仓库管理对话框参数。 */
export interface PluginDialogRepositoryManagerOptions {
  title: string;
  items: readonly PluginDialogPickItem[];
  currentItemId?: string;
  version: string;
  actions: readonly PluginDialogRepositoryAction[];
}

/** 插件文本输入对话框参数。 */
export interface PluginDialogPromptOptions {
  title: string;
  subtitle?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}

/** 插件确认对话框参数。 */
export interface PluginDialogConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
}

/** 插件请求宿主显示的声明式通用对话框。 */
export type PluginDialogRequest = {
  requestId: string;
  pluginId: string;
  pluginName: string;
} & (
  | { kind: 'pick'; options: PluginDialogPickOptions }
  | { kind: 'repository-manager'; options: PluginDialogRepositoryManagerOptions }
  | { kind: 'prompt'; options: PluginDialogPromptOptions }
  | { kind: 'confirm'; options: PluginDialogConfirmOptions }
);

/** 可信渲染进程返回给插件对话框能力的结果。 */
export type PluginDialogResponse =
  | { requestId: string; status: 'cancelled' }
  | { requestId: string; status: 'confirmed'; value: string | boolean };

/** 插件可使用的声明式工作台对话框 API。 */
export interface DialogsApi {
  pick(options: PluginDialogPickOptions): Promise<string | undefined>;
  repositoryManager(options: PluginDialogRepositoryManagerOptions): Promise<string | undefined>;
  prompt(options: PluginDialogPromptOptions): Promise<string | undefined>;
  confirm(options: PluginDialogConfirmOptions): Promise<boolean>;
}

/** 网页查看器标签的公开状态快照。 */
export interface WebViewerTabSummary {
  id: string;
  instanceId: string;
  title: string;
  /** 所属公开视图类型，用于区分同名实例。 */
  viewType?: string;
  /** 原生浏览器报告的 HTTP/HTTPS 网站图标；空值表示没有可用图标。 */
  faviconUrl?: string;
  url: string;
  active: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/** 网页查看器创建参数。 */
export interface WebViewerOpenOptions {
  url?: string;
  title?: string;
}

/** 网页查看器状态变化处理器。 */
export type WebViewerChangeHandler = (
  tabs: readonly WebViewerTabSummary[]
) => void;

/** 原生网页进程退出通知；旧句柄已失效，恢复需显式重新 open。 */
export interface WebViewerFailure {
  tabId: string;
  instanceId: string;
  viewType: string;
  url: string;
  reason: 'renderer-exited' | 'browser-exited';
}

/** 公开网页动作；仓库保存只写入 URL，收藏复用受控插件私有存储。 */
export type WebViewerAction = 'new-window' | 'open-external' | 'zoom-in' | 'zoom-reset' | 'zoom-out' | 'save-to-repository' | 'favorite';

/** 网页句柄仅操作当前视图实例；附加动作仍经过宿主权限网关。 */
export interface WebViewerTab {
  readonly id: string;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  /** 执行网页菜单动作；新窗口与外部打开需要对应的附加授权。 */
  executeAction(action: WebViewerAction): Promise<boolean>;
}

/** 多标签网页查看器公开接口。 */
export interface WebViewerApi {
  open(options?: WebViewerOpenOptions): Promise<WebViewerTab>;
  list(): Promise<readonly WebViewerTabSummary[]>;
  /** 返回已有网页标签的操作句柄。 */
  get(tabId: string): WebViewerTab;
  activate(tabId: string): Promise<void>;
  onDidChange(listener: WebViewerChangeHandler): Disposable;
  onDidFail(listener: (failure: WebViewerFailure) => void): Disposable;
}

export interface LoggerApi {
  debug(message: string, details?: Readonly<Record<string, unknown>>): void;
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

/** 网络请求选项；请求由宿主执行并受 manifest 权限和大小限制。 */
export interface NetworkRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

/** 宿主网络请求结果，不暴露底层 Node/Electron 对象。 */
export interface NetworkResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface NetworkApi {
  request(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse>;
}

export interface PluginContext {
  readonly plugin: PluginIdentity;
  readonly subscriptions: DisposableStore;
  readonly commands: CommandsApi;
  readonly icons: IconsApi;
  readonly filesystem: FilesystemApi;
  readonly workspace: WorkspaceApi;
  readonly windows: WindowsApi;
  readonly editor: EditorApi;
  readonly settings: SettingsApi;
  readonly statusBar: StatusBarApi;
  readonly storage: StorageApi;
  readonly notifications: NotificationsApi;
  readonly dialogs: DialogsApi;
  readonly webViewer: WebViewerApi;
  readonly logger: LoggerApi;
  readonly network: NetworkApi;
}

export interface PluginRpcRequest<TParams = unknown> {
  protocolVersion: 1;
  requestId: string;
  pluginId: string;
  method: string;
  params: TParams;
  deadline: number;
}

export interface PluginRpcError {
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface PluginRpcResponse<TResult = unknown> {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  result?: TResult;
  error?: PluginRpcError;
}

export type PluginRuntimeState =
  | 'disabled'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'blocked';

export interface InstalledPluginRecord {
  id: string;
  version: string;
  enabled: boolean;
  trustLevel: PluginTrustLevel;
  state: PluginRuntimeState;
  grantedPermissions: readonly PluginPermissionId[];
  installPath: string;
  dataPath: string;
  signature?: PluginSignatureRecord;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  authorName: string;
  enabled: boolean;
  trustLevel: PluginTrustLevel;
  state: PluginRuntimeState;
  permissions: readonly PluginPermissionId[];
  permissionRequests: readonly PluginPermissionRequest[];
  grantedPermissions: readonly PluginPermissionId[];
  /** 是否为随应用发布、不可卸载的核心插件。 */
  isCore: boolean;
  /** 可回滚到的上一版本；没有保留版本时为空。 */
  rollbackVersion?: string;
}

export interface PluginSignatureRecord {
  algorithm: 'ed25519';
  keyId: string;
  value: string;
}

/** 插件入口的生命周期函数签名。 */
export type PluginActivate = (context: PluginContext) => void | Promise<void>;

/** 插件退出时释放自身资源的生命周期函数签名。 */
export type PluginDeactivate = () => void | Promise<void>;

/** 插件入口模块必须导出的生命周期函数。 */
export interface PluginEntryModule {
  activate: PluginActivate;
  deactivate?: PluginDeactivate;
  mountView?: PluginViewMount;
}

/** 一个已打开插件视图的宿主容器上下文。 */
export interface PluginViewMountContext extends PluginContext {
  view: {
    type: string;
    instanceId: string;
    initialUrl?: string;
    /** DockingThree 为当前 WorkspaceLeaf 提供的 Shadow DOM 内部真实容器。 */
    root: HTMLElement;
    /** 当前视图尺寸变化事件；关闭视图时由宿主自动释放。 */
    onDidResize(listener: () => void): Disposable;
    /** 同步网页原生承载区域相对当前插件视图的边界。 */
    setWebViewerBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  };
}

/** 插件主入口的可选视图挂载导出。 */
export type PluginViewMount = (
  context: PluginViewMountContext
) => void | Disposable | Promise<void | Disposable>;
