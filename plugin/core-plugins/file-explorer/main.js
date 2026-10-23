/** 文件说明：文件列表插件入口，独立渲染仓库选择、文件树、排序、定位和上下文操作。 */

const ROOT_DIRECTORY = '.';
const SORT_OPTIONS = [
  { id: 'name-asc', label: '文件名(A-Z)' },
  { id: 'name-desc', label: '文件名(Z-A)' },
  { id: 'type', label: '类型' },
  { id: 'modified-desc', label: '编辑时间(从新到旧)' },
  { id: 'modified-asc', label: '编辑时间(从旧到新)' },
  { id: 'created-desc', label: '创建时间(从新到旧)' },
  { id: 'created-asc', label: '创建时间(从旧到新)' }
];
const SORT_STORAGE_KEY = 'file-explorer.sort-preferences';
const FILE_DRAG_START_DISTANCE = 4;
const FILE_DRAG_AVATAR_OFFSET = 12;
const FILE_EXPLORER_SETTINGS_ID = 'com.wstudio.file-explorer.appearance';
const SHOW_FILE_COUNT_SETTING_ID = 'com.wstudio.file-explorer.show-file-count';
const SHOW_FILE_TYPE_SETTING_ID = 'com.wstudio.file-explorer.show-file-type';
const HIDE_FILE_EXTENSION_SETTING_ID = 'com.wstudio.file-explorer.hide-file-extension';
const DEFAULT_FILE_EXPLORER_EXTENSIONS = new Set([
  'txt', 'text', 'log', 'out', 'url',
  'md', 'markdown', 'mdown', 'mkdn', 'mkd', 'mdwn', 'rst', 'adoc', 'asciidoc', 'tex',
  'html', 'htm', 'xhtml', 'xml', 'xsl', 'xsd',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'properties',
  'csv', 'tsv', 'jsonl', 'ndjson',
  'avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp',
  'avi', 'm4v', 'mkv', 'mov', 'mp4', 'ogv', 'webm',
  'aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav'
]);
const DIRECTORY_COUNT_REQUEST_INTERVAL_MS = 80;
const DIRECTORY_REFRESH_DEBOUNCE_MS = 60;

/** 将宿主 RPC 错误转换为用户可理解的文件列表提示。 */
function getErrorMessage(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code === 'PLUGIN_PERMISSION_DENIED' || code === 'PLUGIN_PERMISSION_SCOPE_VIOLATION') {
    return '无法读取文件列表：请在“设置 > 插件管理 > 文件列表 > 权限授权”中勾选所需权限。';
  }
  if (code === 'PLUGIN_WORKSPACE_UNAVAILABLE' || code === 'PLUGIN_FILESYSTEM_NOT_FOUND') {
    return '无法读取文件列表：请先打开一个仓库。';
  }
  if (code === 'PLUGIN_RATE_LIMITED') {
    return '无法读取文件列表：文件统计请求过多，请稍后重试。';
  }
  return error && typeof error.message === 'string'
    ? `无法读取文件列表：${error.message}`
    : '无法读取文件列表：插件服务暂时不可用。';
}

/** 判断是否为插件 RPC 限流错误；此类错误不应覆盖当前可用的文件树。 */
function isRateLimitedError(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && error.code === 'PLUGIN_RATE_LIMITED');
}

/** 将单次文件操作错误显示为非阻断通知，避免错误状态覆盖整个文件树。 */
async function notifyOperationError(state, operation, error) {
  const detail = error && typeof error.message === 'string' ? error.message.trim() : '';
  const message = detail ? `${operation}失败：${detail}` : `${operation}失败。`;
  await state.context.notifications.show(message, { type: 'error' });
}

/** 生成跨平台安全的工作区相对路径。 */
function normalizePath(path) {
  return String(path || '.').replace(/\\/g, '/').replace(/^\.\//, '') || '.';
}

/** 返回文件扩展名，供文件过滤、类型排序和显示使用。 */
function extension(name) {
  const index = String(name).lastIndexOf('.');
  return index > 0 ? String(name).slice(index + 1).toLowerCase() : '';
}

/** 隐藏点开头的条目，并只保留默认支持格式的文件。 */
function filterFileExplorerEntries(entries) {
  return entries.filter(entry => {
    const name = String(entry.name || '');
    if (!name || name.startsWith('.')) return false;
    return entry.type === 'directory' || DEFAULT_FILE_EXPLORER_EXTENSIONS.has(extension(name));
  });
}

/** 创建插件内部状态，宿主只负责提供公开能力。 */
function createState(context) {
  return {
    context,
    repository: undefined,
    recentRepositories: [],
    entriesByDirectory: new Map(),
    expanded: new Set(),
    allExpanded: false,
    selectedPaths: new Set(),
    selectedPath: undefined,
    dragCandidate: undefined,
    draggedEntry: undefined,
    draggedEntries: undefined,
    externalFileDragActive: false,
    dragAvatar: undefined,
    dropTargetDirectory: undefined,
    suppressClickUntil: 0,
    sort: 'name-asc',
    foldersFirst: true,
    caseSensitive: false,
    showFileCount: false,
    showFileType: false,
    hideFileExtension: false,
    directoryFileCounts: new Map(),
    directoryFileCountStale: new Set(),
    directoryFileCountPromises: new Map(),
    directoryFileCountQueue: [],
    directoryFileCountWorkerPromise: undefined,
    directoryFileCountRetryTimers: new Map(),
    directoryFileCountRetryAttempts: new Map(),
    directoryCountEntries: new Map(),
    directoryEntryPromises: new Map(),
    directoryCountEntryPromises: new Map(),
    directoryFileCountElements: new Map(),
    directoryCountNextReadAt: 0,
    directoryFileCountErrors: new Set(),
    directoryFileCountGeneration: 0,
    directoryFileCountVersions: new Map(),
    directoryRefreshPending: new Set(),
    directoryRefreshPromise: undefined,
    directoryRefreshRetryTimer: undefined,
    directoryRefreshRetryAttempt: 0,
    refreshGeneration: 0,
    repositorySwitchDepth: 0,
    repositorySwitchGeneration: 0,
    pendingRepository: undefined,
    repositorySwitchPromise: undefined,
    clipboard: undefined,
    creating: undefined,
    createRow: undefined,
    newFile: false,
    renaming: undefined,
    busy: false,
    error: undefined,
    menu: undefined,
    sortMenu: undefined,
    sortMenuOutsideListener: undefined,
    repositoryMenu: undefined,
    repositoryMenuOutsideListener: undefined,
    moveDialog: undefined,
    moveDialogCleanup: undefined,
    moveDirectories: undefined,
    moveDirectoriesPromise: undefined,
    moveDirectoriesGeneration: 0,
    root: undefined,
    list: undefined,
    toolbar: undefined,
    repositoryButton: undefined,
    repositoryLabel: undefined,
    status: undefined,
  };
}

/** 从插件私有存储恢复排序配置，非法或旧版本值使用稳定默认值。 */
async function restoreSortPreferences(state) {
  try {
    const saved = await state.context.storage.get(SORT_STORAGE_KEY);
    if (!saved || typeof saved !== 'object') return;
    const preferences = saved;
    if (SORT_OPTIONS.some(option => option.id === preferences.sort)) state.sort = preferences.sort;
    if (typeof preferences.caseSensitive === 'boolean') state.caseSensitive = preferences.caseSensitive;
  } catch {
    // 存储不可用时保留内存中的默认排序，不影响文件列表读取。
  }
}

/** 保存当前排序配置到插件私有存储。 */
function persistSortPreferences(state) {
  void state.context.storage.set(SORT_STORAGE_KEY, {
    sort: state.sort,
    caseSensitive: state.caseSensitive
  });
}

/** 读取指定目录并保存条目，展开时保留已有文件计数，避免显示闪烁。 */
async function loadDirectory(state, directory) {
  await refreshDirectories(state, [directory], false, false);
}

/** 返回按当前排序设置排列的目录条目。 */
function sortedEntries(state, directory) {
  const entries = filterFileExplorerEntries([...(state.entriesByDirectory.get(directory) || [])]);
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
    let comparison = 0;
    if (state.sort.startsWith('modified')) comparison = (left.modifiedAt || 0) - (right.modifiedAt || 0);
    else if (state.sort.startsWith('created')) comparison = (left.createdAt || 0) - (right.createdAt || 0);
    else if (state.sort === 'type') comparison = extension(left.name).localeCompare(extension(right.name), 'zh-CN', { numeric: true });
    else comparison = left.name.localeCompare(right.name, 'zh-CN', {
      sensitivity: state.caseSensitive ? 'variant' : 'base',
      numeric: true
    });
    const descending = state.sort.endsWith('-desc');
    return (comparison || left.name.localeCompare(right.name, 'zh-CN', { numeric: true })) * (descending ? -1 : 1);
  });
  return entries;
}

/** 根据当前文件树选择确定新建目标：目录本身、文件父目录或仓库根目录。 */
function resolveCreateDirectory(state) {
  if (!state.selectedPath || state.selectedPath === ROOT_DIRECTORY) return ROOT_DIRECTORY;
  for (const entries of state.entriesByDirectory.values()) {
    const selectedEntry = entries.find(entry => entry.path === state.selectedPath);
    if (!selectedEntry) continue;
    return selectedEntry.type === 'directory' ? selectedEntry.path : parent(selectedEntry.path);
  }
  return ROOT_DIRECTORY;
}

/** 返回当前显示设置下的文件名称，目录与无后缀文件保持原样。 */
function visibleEntryName(state, entry) {
  if (entry.type !== 'file' || !state.hideFileExtension) return entry.name;
  const suffix = extension(entry.name);
  return suffix ? entry.name.slice(0, -(suffix.length + 1)) : entry.name;
}

/** 返回文件类型标签；没有后缀的文件使用明确的兜底文字。 */
function fileTypeLabel(entry) {
  return extension(entry.name) || '';
}

/** 从宿主持久化设置恢复文件列表的显示偏好。 */
async function restoreDisplayPreferences(state) {
  try {
    const [showFileCount, showFileType, hideFileExtension] = await Promise.all([
      state.context.settings.get(SHOW_FILE_COUNT_SETTING_ID),
      state.context.settings.get(SHOW_FILE_TYPE_SETTING_ID),
      state.context.settings.get(HIDE_FILE_EXTENSION_SETTING_ID)
    ]);
    state.showFileCount = showFileCount === true;
    state.showFileType = showFileType === true;
    state.hideFileExtension = hideFileExtension === true;
  } catch {
    // 设置服务短暂不可用时使用清单声明的稳定默认值。
  }
}

/** 将单个宿主设置变更同步到本地视图状态，并在计数开关变化时使目录缓存失效。 */
function applyDisplayPreference(state, fieldId, value) {
  if (typeof value !== 'boolean') return false;
  if (fieldId === SHOW_FILE_COUNT_SETTING_ID) {
    if (state.showFileCount === value) return true;
    state.showFileCount = value;
    invalidateDirectoryFileCounts(state);
    return true;
  }
  if (fieldId === SHOW_FILE_TYPE_SETTING_ID) {
    state.showFileType = value;
    return false;
  }
  if (fieldId === HIDE_FILE_EXTENSION_SETTING_ID) {
    state.hideFileExtension = value;
  }
  return false;
}

/** 将统计读取均匀分布在时间窗口内，避免大量目录同时触发 RPC 限流。 */
function scheduleDirectoryCountRead(state, read, generation, directory, version) {
  const versions = state.directoryFileCountVersions
    || (state.directoryFileCountVersions = new Map());
  const now = Date.now();
  const nextReadAt = Math.max(now, state.directoryCountNextReadAt || 0);
  state.directoryCountNextReadAt = nextReadAt + DIRECTORY_COUNT_REQUEST_INTERVAL_MS;
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (generation !== (state.directoryFileCountGeneration || 0)
        || version !== (versions.get(directory) || 0)) {
        resolve([]);
        return;
      }
      Promise.resolve().then(read).then(resolve, reject);
    }, Math.max(0, nextReadAt - now));
  });
}

/** 缓存过滤后的目录条目；统计读取使用独立请求，避免阻塞用户展开。 */
function loadDirectoryEntries(state, directory, refresh = false, countRead = false) {
  const entryCache = countRead
    ? (state.directoryCountEntries || (state.directoryCountEntries = new Map()))
    : state.entriesByDirectory;
  const cachedEntries = entryCache.get(directory)
    || (countRead ? state.entriesByDirectory.get(directory) : undefined);
  if (!refresh && cachedEntries) return Promise.resolve(cachedEntries);

  const pendingEntries = countRead
    ? (state.directoryCountEntryPromises
      || (state.directoryCountEntryPromises = new Map()))
    : (state.directoryEntryPromises
      || (state.directoryEntryPromises = new Map()));
  const existing = pendingEntries.get(directory);
  if (existing) return existing;

  const read = () => state.context.filesystem.listEntries(directory);
  const countGeneration = state.directoryFileCountGeneration || 0;
  const countVersions = state.directoryFileCountVersions
    || (state.directoryFileCountVersions = new Map());
  const countVersion = countVersions.get(directory) || 0;
  const request = (countRead
    ? scheduleDirectoryCountRead(state, read, countGeneration, directory, countVersion)
    : Promise.resolve().then(read))
    .then(entries => {
      const filteredEntries = filterFileExplorerEntries(entries);
      if (pendingEntries.get(directory) === request) {
        pendingEntries.delete(directory);
        if (!countRead
          || (countGeneration === (state.directoryFileCountGeneration || 0)
            && countVersion === (countVersions.get(directory) || 0))) {
          entryCache.set(directory, filteredEntries);
        }
      }
      return filteredEntries;
    })
    .catch(error => {
      if (pendingEntries.get(directory) === request) pendingEntries.delete(directory);
      throw error;
    });
  pendingEntries.set(directory, request);
  return request;
}

/** 判断文件是否符合文件列表的统计口径，避免为单个条目创建临时数组。 */
function isCountableDirectoryFile(entry) {
  const name = String(entry.name || '');
  return entry.type === 'file'
    && name.length > 0
    && !name.startsWith('.')
    && DEFAULT_FILE_EXPLORER_EXTENSIONS.has(extension(name));
}

/** 读取单个目录供统计使用；结果只在当前循环中存活，不写入目录条目缓存。 */
function loadDirectoryEntriesForCount(state, directory, generation, version, cacheEntries) {
  const loadedEntries = state.entriesByDirectory?.get(directory);
  if (loadedEntries) return Promise.resolve(loadedEntries);
  if (cacheEntries?.has(directory)) return Promise.resolve(cacheEntries.get(directory));
  return scheduleDirectoryCountRead(
    state,
    () => state.context.filesystem.listEntries(directory),
    generation,
    directory,
    version
  ).then(entries => {
    cacheEntries?.set(directory, entries);
    return entries;
  });
}

/** 递归统计目录子树，并一次性计算本次遍历遇到的所有目录数量。 */
async function countDirectorySubtree(state, directory, useCache = false) {
  const generation = state.directoryFileCountGeneration || 0;
  const versions = state.directoryFileCountVersions
    || (state.directoryFileCountVersions = new Map());
  const pendingDirectories = [directory];
  const counts = new Map([[directory, 0]]);
  const versionSnapshots = new Map();
  let count = 0;
  const cacheEntries = useCache
    ? (state.directoryCountEntries || (state.directoryCountEntries = new Map()))
    : undefined;

  const parentDirectory = value => {
    const parts = normalizePath(value).split('/');
    parts.pop();
    return parts.length ? parts.join('/') : '.';
  };

  while (pendingDirectories.length > 0) {
    if (generation !== (state.directoryFileCountGeneration || 0)) break;
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) continue;
    const currentVersion = versions.get(currentDirectory) || 0;
    versionSnapshots.set(currentDirectory, currentVersion);
    const entries = await loadDirectoryEntriesForCount(
      state,
      currentDirectory,
      generation,
      currentVersion,
      cacheEntries
    );
    if (generation !== (state.directoryFileCountGeneration || 0)) break;

    if (!counts.has(currentDirectory)) counts.set(currentDirectory, 0);
    for (const entry of entries) {
      if (entry.type === 'file') count += 1;
      if (entry.type === 'file' && !isCountableDirectoryFile(entry)) {
        count -= 1;
        continue;
      }
      if (entry.type === 'file') {
        counts.set(currentDirectory, (counts.get(currentDirectory) || 0) + 1);
        continue;
      }
      if (entry.type !== 'directory' || String(entry.name || '').startsWith('.')) continue;
      const childDirectory = normalizePath(entry.path);
      if (!counts.has(childDirectory)) counts.set(childDirectory, 0);
      pendingDirectories.push(entry.path);
    }
  }

  const orderedDirectories = [...counts.keys()]
    .filter(currentDirectory => currentDirectory !== directory)
    .sort((left, right) => right.split('/').length - left.split('/').length);
  for (const currentDirectory of orderedDirectories) {
    const parentDirectoryPath = parentDirectory(currentDirectory);
    if (counts.has(parentDirectoryPath)) {
      counts.set(parentDirectoryPath, (counts.get(parentDirectoryPath) || 0)
        + (counts.get(currentDirectory) || 0));
    }
  }

  return {
    count,
    rootDirectory: directory,
    counts,
    versionSnapshots,
    generation
  };
}

/** 递归统计目录子树中的文件数量，不将目录本身计入结果。 */
// Kept for legacy source-contract tests; the worker uses the richer batch result directly.
async function countDirectoryFiles(state, directory) {
  const result = await countDirectorySubtree(state, directory, true);
  return result.count;
}

/** 将一次子树扫描得到的数字缓存到目录级结果，释放条目对象后继续处理队列。 */
function applyDirectoryFileCountBatch(state, result) {
  if (result.generation !== (state.directoryFileCountGeneration || 0)
    || !state.showFileCount) return;
  const versions = state.directoryFileCountVersions
    || (state.directoryFileCountVersions = new Map());
  for (const [directory, count] of result.counts) {
    if (directory !== result.rootDirectory && !state.directoryFileCountElements.has(directory)) continue;
    if (result.versionSnapshots.get(directory) !== (versions.get(directory) || 0)) continue;
    state.directoryFileCounts.set(directory, count);
    state.directoryFileCountStale.delete(directory);
    state.directoryFileCountErrors.delete(directory);
    state.directoryFileCountRetryAttempts.delete(directory);
    updateDirectoryFileCountElements(state, directory, `[ ${count} ]`);
  }
  if (result.versionSnapshots.get(result.rootDirectory)
    === (versions.get(result.rootDirectory) || 0)) {
    state.directoryFileCounts.set(result.rootDirectory, result.count);
    updateDirectoryFileCountElements(state, result.rootDirectory, `[ ${result.count} ]`);
  }
}

/** 串行消费目录统计队列，避免多个递归遍历同时保留大型条目数组。 */
function startDirectoryFileCountWorker(state) {
  if (state.directoryFileCountWorkerPromise) return;
  const worker = (async () => {
    while (state.directoryFileCountQueue.length > 0) {
      const request = state.directoryFileCountQueue.shift();
      if (!request) continue;
      const currentVersion = state.directoryFileCountVersions.get(request.directory) || 0;
      if (request.generation !== state.directoryFileCountGeneration
        || request.version !== currentVersion
        || !state.showFileCount
        || !state.repository) {
        request.resolve(0);
        continue;
      }
      if (state.directoryFileCounts.has(request.directory)
        && !state.directoryFileCountStale.has(request.directory)) {
        request.resolve(state.directoryFileCounts.get(request.directory));
        continue;
      }
      try {
        const result = await countDirectorySubtree(state, request.directory, true);
        if (request.generation !== state.directoryFileCountGeneration
          || request.version !== (state.directoryFileCountVersions.get(request.directory) || 0)) {
          request.resolve(0);
          continue;
        }
        applyDirectoryFileCountBatch(state, result);
        request.resolve(result.count);
      } catch (error) {
        request.reject(error);
      }
    }
  })();
  let workerPromise;
  workerPromise = worker.finally(() => {
    if (state.directoryFileCountWorkerPromise === workerPromise) {
      state.directoryFileCountWorkerPromise = undefined;
      if (state.directoryFileCountQueue.length > 0) startDirectoryFileCountWorker(state);
    }
  });
  state.directoryFileCountWorkerPromise = workerPromise;
}

/** 在后台延迟重试被限流的目录统计，不阻断文件树交互。 */
function scheduleDirectoryFileCountRetry(state, directory, generation, version) {
  if (state.directoryFileCountRetryTimers.has(directory)) return;
  const attempts = state.directoryFileCountRetryAttempts.get(directory) || 0;
  const delay = Math.min(4_000, 250 * (2 ** attempts));
  state.directoryFileCountRetryAttempts.set(directory, Math.min(attempts + 1, 5));
  const timer = setTimeout(() => {
    state.directoryFileCountRetryTimers.delete(directory);
    if (generation !== state.directoryFileCountGeneration
      || version !== (state.directoryFileCountVersions.get(directory) || 0)
      || !state.showFileCount
      || !state.repository) return;
    state.directoryFileCountErrors.delete(directory);
    ensureDirectoryFileCount(state, directory);
  }, delay);
  state.directoryFileCountRetryTimers.set(directory, timer);
}

/** 异步加载目录文件计数，复用请求并防止旧仓库结果覆盖当前状态。 */
function ensureDirectoryFileCount(state, directory) {
  if (!state.showFileCount || !state.repository) return;
  const versions = state.directoryFileCountVersions
    || (state.directoryFileCountVersions = new Map());
  if ((state.directoryFileCounts.has(directory) && !state.directoryFileCountStale.has(directory))
    || state.directoryFileCountErrors.has(directory)) return;
  if (state.directoryFileCountRetryTimers.has(directory)) return;
  const existing = state.directoryFileCountPromises.get(directory);
  if (existing) return;
  const generation = state.directoryFileCountGeneration;
  const version = versions.get(directory) || 0;
  let resolveCount;
  let rejectCount;
  const countRequest = new Promise((resolve, reject) => {
    resolveCount = resolve;
    rejectCount = reject;
  });
  state.directoryFileCountQueue.push({
    directory,
    generation,
    version,
    resolve: resolveCount,
    reject: rejectCount
  });
  startDirectoryFileCountWorker(state);
  const request = countRequest
    .then(count => {
      if (generation !== state.directoryFileCountGeneration
        || version !== (versions.get(directory) || 0)
        || !state.showFileCount) return;
      state.directoryFileCounts.set(directory, count);
      state.directoryFileCountStale.delete(directory);
      state.directoryFileCountErrors.delete(directory);
      state.directoryFileCountRetryAttempts.delete(directory);
      updateDirectoryFileCountElements(state, directory, `[ ${count} ]`);
    })
    .catch(error => {
      if (generation !== state.directoryFileCountGeneration
        || version !== (versions.get(directory) || 0)
        || !state.showFileCount) return;
      if (isRateLimitedError(error)) {
        if (state.directoryFileCounts.has(directory)) {
          updateDirectoryFileCountElements(
            state,
            directory,
            `[ ${state.directoryFileCounts.get(directory)} ]`
          );
        }
        scheduleDirectoryFileCountRetry(state, directory, generation, version);
        return;
      }
      state.directoryFileCountErrors.add(directory);
      state.directoryFileCountRetryAttempts.delete(directory);
      if (!state.directoryFileCounts.has(directory)) updateDirectoryFileCountElements(state, directory, '');
    })
    .finally(() => {
      if (state.directoryFileCountPromises.get(directory) === request) {
        state.directoryFileCountPromises.delete(directory);
      }
    });
  state.directoryFileCountPromises.set(directory, request);
}

/** 只更新指定目录的统计文本，不重建文件列表 DOM。 */
function updateDirectoryFileCountElements(state, directory, text) {
  const elements = state.directoryFileCountElements.get(directory);
  if (!elements) return;
  for (const element of elements) element.textContent = text;
}

/** 在目录行名称右侧追加递归文件数量，并为未加载或失败状态提供稳定占位。 */
function appendDirectoryFileCount(state, row, entry) {
  if (entry.type !== 'directory' || !state.showFileCount) return;
  const count = document.createElement('span');
  count.className = 'file-explorer-directory-count';
  count.setAttribute('aria-label', '目录文件数量');
  const elements = state.directoryFileCountElements.get(entry.path) || new Set();
  elements.add(count);
  state.directoryFileCountElements.set(entry.path, elements);
  if (state.directoryFileCounts.has(entry.path)) {
    count.textContent = `[ ${state.directoryFileCounts.get(entry.path)} ]`;
    if (state.directoryFileCountStale.has(entry.path)) ensureDirectoryFileCount(state, entry.path);
  } else if (state.directoryFileCountErrors.has(entry.path)) {
    count.textContent = '';
  } else {
    count.textContent = '';
    ensureDirectoryFileCount(state, entry.path);
  }
  const label = row.querySelector('.file-explorer-row__label');
  if (label) label.append(count);
  else row.append(count);
}

/** 取消尚未开始的统计请求，避免仓库切换后队列继续保留旧目录。 */
function clearQueuedDirectoryFileCounts(state) {
  const queue = state.directoryFileCountQueue.splice(0);
  for (const request of queue) request.resolve(0);
}

/** 使目录文件计数全量失效，或仅标记受影响目录及祖先等待后台重算。 */
function invalidateDirectoryFileCounts(state, directories) {
  if (!directories) {
    state.directoryFileCountGeneration += 1;
    clearQueuedDirectoryFileCounts(state);
    state.directoryFileCountPromises.clear();
    state.directoryCountNextReadAt = 0;
    state.directoryCountEntries.clear();
    state.directoryEntryPromises.clear();
    state.directoryCountEntryPromises.clear();
    for (const timer of state.directoryFileCountRetryTimers.values()) clearTimeout(timer);
    state.directoryFileCountRetryTimers.clear();
    state.directoryFileCountRetryAttempts.clear();
    if (state.directoryRefreshRetryTimer) clearTimeout(state.directoryRefreshRetryTimer);
    state.directoryRefreshRetryTimer = undefined;
    state.directoryRefreshRetryAttempt = 0;
    state.directoryFileCounts.clear();
    state.directoryFileCountStale.clear();
    state.directoryFileCountVersions.clear();
    state.directoryFileCountErrors.clear();
    state.directoryFileCountElements.clear();
    return;
  }
  const affectedDirectories = new Set();
  for (const directory of directories) {
    let currentDirectory = normalizePath(directory);
    while (true) {
      affectedDirectories.add(currentDirectory);
      if (currentDirectory === ROOT_DIRECTORY) break;
      currentDirectory = parent(currentDirectory);
    }
  }
  for (const directory of affectedDirectories) {
    state.directoryFileCountVersions.set(directory, (state.directoryFileCountVersions.get(directory) || 0) + 1);
    if (state.directoryFileCounts.has(directory)) state.directoryFileCountStale.add(directory);
    state.directoryFileCountErrors.delete(directory);
    const retryTimer = state.directoryFileCountRetryTimers.get(directory);
    if (retryTimer) clearTimeout(retryTimer);
    state.directoryFileCountRetryTimers.delete(directory);
    state.directoryFileCountRetryAttempts.delete(directory);
    state.directoryFileCountPromises.delete(directory);
    state.directoryCountEntries.delete(directory);
    state.directoryCountEntryPromises.delete(directory);
  }
  for (const directory of directories) {
    const normalizedDirectory = normalizePath(directory);
    state.directoryEntryPromises.delete(normalizedDirectory);
  }
  const pendingQueue = state.directoryFileCountQueue.splice(0);
  for (const request of pendingQueue) {
    const currentVersion = state.directoryFileCountVersions.get(request.directory) || 0;
    if (request.version !== currentVersion) request.resolve(0);
    else state.directoryFileCountQueue.push(request);
  }
  startDirectoryFileCountWorker(state);
}

/** 使用公开 SDK 在插件元素内插入宿主真实 SVG。 */
function icon(state, iconName, label) {
  const element = document.createElement('span');
  element.className = 'file-explorer-icon';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', label);
  state.context.icons.setIcon(element, iconName);
  return element;
}

/** 创建文件行使用的展开箭头占位，使文件图标与文件夹图标保持同列对齐。 */
function entryExpandSpacer() {
  const element = document.createElement('span');
  element.className = 'file-explorer-icon file-explorer-icon--placeholder';
  element.setAttribute('aria-hidden', 'true');
  return element;
}

/** 创建普通文件使用的折角文档图标，保持文件列表与拖拽预览图标一致。 */
function documentFileIcon(state, label) {
  return icon(state, 'document', label);
}

/** 创建文件列表插件自有的内联加密文件 SVG 图标。 */
function encryptedFileIcon(label) {
  const namespace = 'http://www.w3.org/2000/svg';
  const element = document.createElement('span');
  const svg = document.createElementNS(namespace, 'svg');
  const body = document.createElementNS(namespace, 'rect');
  const shackle = document.createElementNS(namespace, 'path');
  element.className = 'file-explorer-icon';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', label);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  body.setAttribute('x', '3');
  body.setAttribute('y', '11');
  body.setAttribute('width', '18');
  body.setAttribute('height', '11');
  body.setAttribute('rx', '2');
  shackle.setAttribute('d', 'M7 11V7a5 5 0 0 1 10 0v4');
  svg.append(body, shackle);
  element.append(svg);
  return element;
}

/** 使用插件自有的内联 SVG 创建全部展开图标。 */
function expandAllIcon(label) {
  const namespace = 'http://www.w3.org/2000/svg';
  const element = document.createElement('span');
  const svg = document.createElementNS(namespace, 'svg');
  const expandDown = document.createElementNS(namespace, 'path');
  const expandUp = document.createElementNS(namespace, 'path');
  element.className = 'file-explorer-icon';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', label);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  expandDown.setAttribute('d', 'm7 15 5 5 5-5');
  expandUp.setAttribute('d', 'm7 9 5-5 5 5');
  svg.append(expandDown, expandUp);
  element.append(svg);
  return element;
}

/** 使用插件自有的内联 SVG 创建全部折叠图标。 */
function collapseAllIcon(label) {
  const namespace = 'http://www.w3.org/2000/svg';
  const element = document.createElement('span');
  const svg = document.createElementNS(namespace, 'svg');
  const collapseUp = document.createElementNS(namespace, 'path');
  const collapseDown = document.createElementNS(namespace, 'path');
  element.className = 'file-explorer-icon';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', label);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  collapseUp.setAttribute('d', 'm7 20 5-5 5 5');
  collapseDown.setAttribute('d', 'm7 4 5 5 5-5');
  svg.append(collapseUp, collapseDown);
  element.append(svg);
  return element;
}

/** 创建排序菜单选中状态使用的插件内联勾选 SVG。 */
function sortCheckIcon(label) {
  const namespace = 'http://www.w3.org/2000/svg';
  const element = document.createElement('span');
  const svg = document.createElementNS(namespace, 'svg');
  const path = document.createElementNS(namespace, 'path');
  element.className = 'file-explorer-sort-check';
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('aria-label', label);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', 'M20 6 9 17l-5-5');
  svg.append(path);
  element.append(svg);
  return element;
}

/** 创建右键菜单二级菜单使用的插件内联箭头 SVG。 */
function contextMenuArrowIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const element = document.createElement('span');
  const svg = document.createElementNS(namespace, 'svg');
  const path = document.createElementNS(namespace, 'path');
  element.className = 'file-explorer-menu-submenu__arrow';
  element.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', 'm9 18 6-6-6-6');
  svg.append(path);
  element.append(svg);
  return element;
}

/** 关闭文件条目右键菜单。 */
function closeContextMenu(state) {
  state.menu?.remove();
  state.menu = undefined;
}

/** 关闭排序选项菜单。 */
function closeSortMenu(state) {
  state.sortMenu?.remove();
  state.sortMenu = undefined;
  if (state.sortMenuOutsideListener) {
    document.removeEventListener('click', state.sortMenuOutsideListener);
    state.sortMenuOutsideListener = undefined;
  }
}

/** 关闭仓库选择菜单并释放插件自己的全局点击监听。 */
function closeRepositoryMenu(state) {
  state.repositoryMenu?.remove();
  state.repositoryMenu = undefined;
  if (state.repositoryMenuOutsideListener) {
    document.removeEventListener('click', state.repositoryMenuOutsideListener);
    state.repositoryMenuOutsideListener = undefined;
  }
  state.repositoryButton?.classList.remove('is-open');
  state.repositoryButton?.setAttribute('aria-expanded', 'false');
}

/** 关闭依附于仓库头部工具栏的下拉菜单。 */
function closeHeaderMenus(state) {
  closeSortMenu(state);
  closeRepositoryMenu(state);
}

/** 统一关闭插件视图中的临时浮层。 */
function closeMenuSurfaces(state) {
  closeContextMenu(state);
  closeHeaderMenus(state);
}

/** 统一关闭插件视图中的临时浮层。 */
function closeTransientMenus(state) {
  closeMenuSurfaces(state);
  closeMoveDialog(state);
}

/** 关闭插件自有的移动目标选择窗口。 */
function closeMoveDialog(state) {
  state.moveDialogCleanup?.();
  state.moveDialogCleanup = undefined;
  state.moveDialog?.remove();
  state.moveDialog = undefined;
}

/** 为移动目标列表创建插件自有的主题化纵向滚动条。 */
function createOperationScrollArea(scroller) {
  const container = document.createElement('div');
  const scrollbar = document.createElement('div');
  const thumb = document.createElement('button');
  let resizeObserver;
  let mutationObserver;
  let scheduledSyncFrame = 0;
  let activePointerId;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  container.className = 'file-explorer-operation-scroll-area';
  scrollbar.className = 'file-explorer-operation-scrollbar';
  scrollbar.setAttribute('aria-hidden', 'true');
  thumb.type = 'button';
  thumb.tabIndex = -1;
  thumb.className = 'file-explorer-operation-scrollbar__thumb';
  scrollbar.append(thumb);
  container.append(scroller, scrollbar);

  /** 根据列表尺寸和滚动位置刷新滑块。 */
  const sync = () => {
    const trackHeight = scrollbar.clientHeight;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const isScrollable = maxScrollTop > 1 && trackHeight > 0;
    scrollbar.classList.toggle('is-visible', isScrollable);
    if (!isScrollable) {
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0)';
      return;
    }
    thumb.style.height = `${(scroller.clientHeight / scroller.scrollHeight) * trackHeight}px`;
    const thumbHeight = Math.min(trackHeight, thumb.offsetHeight);
    const maxThumbOffset = trackHeight - thumbHeight;
    const thumbOffset = maxThumbOffset <= 0 ? 0 : (scroller.scrollTop / maxScrollTop) * maxThumbOffset;
    thumb.style.transform = `translateY(${thumbOffset}px)`;
  };

  /** 合并同一帧内的尺寸同步请求。 */
  const scheduleSync = () => {
    if (scheduledSyncFrame !== 0) window.cancelAnimationFrame(scheduledSyncFrame);
    scheduledSyncFrame = window.requestAnimationFrame(() => {
      scheduledSyncFrame = 0;
      sync();
    });
  };

  /** 结束滑块拖动并释放窗口级指针监听。 */
  const stopDragging = event => {
    if (event && activePointerId !== event.pointerId) return;
    activePointerId = undefined;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', stopDragging);
    window.removeEventListener('pointercancel', stopDragging);
  };

  /** 将滑块拖动距离转换为列表滚动距离。 */
  function handlePointerMove(event) {
    if (activePointerId !== event.pointerId) return;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    const maxThumbOffset = scrollbar.clientHeight - thumb.offsetHeight;
    if (maxScrollTop <= 0 || maxThumbOffset <= 0) return;
    const nextScrollTop = dragStartScrollTop
      + ((event.clientY - dragStartY) / maxThumbOffset) * maxScrollTop;
    scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
    sync();
  }

  /** 开始拖动滚动条滑块。 */
  const startDragging = event => {
    event.preventDefault();
    event.stopPropagation();
    activePointerId = event.pointerId;
    dragStartY = event.clientY;
    dragStartScrollTop = scroller.scrollTop;
    thumb.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
  };

  scroller.addEventListener('scroll', scheduleSync, { passive: true });
  thumb.addEventListener('pointerdown', startDragging);
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(scroller);
    resizeObserver.observe(container);
  }
  if (typeof MutationObserver !== 'undefined') {
    mutationObserver = new MutationObserver(scheduleSync);
    mutationObserver.observe(scroller, { childList: true, subtree: true, characterData: true });
  }
  scheduleSync();

  return {
    element: container,
    sync: scheduleSync,
    /** 关闭移动窗口时释放滚动条观察器和事件。 */
    dispose() {
      if (scheduledSyncFrame !== 0) window.cancelAnimationFrame(scheduledSyncFrame);
      scheduledSyncFrame = 0;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      scroller.removeEventListener('scroll', scheduleSync);
      thumb.removeEventListener('pointerdown', startDragging);
      stopDragging();
    }
  };
}

/** 执行一次仓库选择，失败时保留当前文件树并显示非阻断通知。 */
async function executeRepositoryAction(state, operation, operationLabel) {
  try {
    const repository = await operation();
    if (repository) await refreshRepository(state);
  } catch (error) {
    await notifyOperationError(state, operationLabel, error);
  }
}

async function executeRepositorySelection(state, operation) {
  await executeRepositoryAction(state, operation, '打开仓库');
}

/** 执行独立文件选择并由宿主创建临时编辑器标签。 */
async function executeFileSelection(state) {
  try {
    await state.context.workspace.openFile();
  } catch (error) {
    await notifyOperationError(state, '打开文件', error);
  }
}

/** 按名称去重最近仓库，保留最近列表中最靠前的一项。 */
function uniqueRecentRepositories(repositories) {
  const names = new Set();
  return repositories.filter(repository => {
    const name = repositoryDisplayName(repository).toLocaleLowerCase();
    const key = name || String(repository.id || '');
    if (names.has(key)) return false;
    names.add(key);
    return true;
  });
}

/** 确保旧版最近仓库记录在界面上显示根目录名称，而不是完整路径。 */
function repositoryDisplayName(repository) {
  const name = String(repository.name || '').trim();
  if (name && !name.includes('\\') && !name.includes('/') && !/^[A-Za-z]:/u.test(name)) {
    return name;
  }
  const displayPath = repositoryDisplayPath(repository);
  const segments = displayPath.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] || name || '未命名仓库';
}

/** 兼容旧版记录缺少 displayPath 时的路径显示。 */
function repositoryDisplayPath(repository) {
  const displayPath = String(repository.displayPath || '').trim();
  if (displayPath) return displayPath;
  const name = String(repository.name || '').trim();
  return name.includes('\\') || name.includes('/') || /^[A-Za-z]:/u.test(name) ? name : '';
}

/** 创建单个仓库菜单项，仅显示仓库名称。 */
function createRepositoryMenuItem(state, repository) {
  const item = document.createElement('button');
  const label = document.createElement('span');
  const isActive = repository.id === state.repository?.id;
  item.type = 'button';
  item.className = 'file-explorer-menu-item file-explorer-repository-menu__item';
  item.setAttribute('role', 'menuitem');
  label.className = 'file-explorer-repository-menu__name';
  label.textContent = repositoryDisplayName(repository);
  item.append(label);
  if (isActive) {
    item.classList.add('is-active');
  }
  item.addEventListener('click', event => {
    event.stopPropagation();
    closeRepositoryMenu(state);
    if (!isActive) {
      void executeRepositorySelection(
        state,
        () => state.context.workspace.openRecentRepository(repository.id)
      );
    }
  });
  return item;
}

/** 打开仓库选择菜单，并根据触发按钮位置约束弹层尺寸。 */
function openRepositoryMenu(state) {
  closeContextMenu(state);
  closeSortMenu(state);
  closeRepositoryMenu(state);
  const anchor = state.repositoryButton;
  if (!anchor) return;

  const menu = document.createElement('div');
  menu.className = 'file-explorer-menu-surface file-explorer-repository-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '选择仓库');
  for (const repository of uniqueRecentRepositories(state.recentRepositories)) {
    menu.append(createRepositoryMenuItem(state, repository));
  }

  const separator = document.createElement('div');
  separator.className = 'file-explorer-menu-separator file-explorer-repository-menu__separator';
  separator.setAttribute('role', 'separator');
  menu.append(separator);

  const open = document.createElement('button');
  const openLabel = document.createElement('span');
  open.type = 'button';
  open.className = 'file-explorer-menu-item file-explorer-repository-menu__item';
  open.setAttribute('role', 'menuitem');
  openLabel.className = 'file-explorer-repository-menu__label';
  openLabel.textContent = '打开仓库...';
  open.append(icon(state, 'folder', '打开仓库'), openLabel);
  open.addEventListener('click', event => {
    event.stopPropagation();
    closeRepositoryMenu(state);
    void executeRepositorySelection(state, () => state.context.workspace.openRepository());
  });
  menu.append(open);

  const create = document.createElement('button');
  const createLabel = document.createElement('span');
  create.type = 'button';
  create.className = 'file-explorer-menu-item file-explorer-repository-menu__item';
  create.setAttribute('role', 'menuitem');
  createLabel.className = 'file-explorer-repository-menu__label';
  createLabel.textContent = '新建仓库';
  create.append(icon(state, 'folder', '新建仓库'), createLabel);
  create.addEventListener('click', event => {
    event.stopPropagation();
    closeRepositoryMenu(state);
    void executeRepositoryAction(
      state,
      () => state.context.workspace.createRepository(),
      '新建仓库'
    );
  });
  menu.append(create);

  const openFile = document.createElement('button');
  const openFileLabel = document.createElement('span');
  openFile.type = 'button';
  openFile.className = 'file-explorer-menu-item file-explorer-repository-menu__item';
  openFile.setAttribute('role', 'menuitem');
  openFileLabel.className = 'file-explorer-repository-menu__label';
  openFileLabel.textContent = '打开文件';
  openFile.append(icon(state, 'document', '打开文件'), openFileLabel);
  openFile.addEventListener('click', event => {
    event.stopPropagation();
    closeRepositoryMenu(state);
    void executeFileSelection(state);
  });
  menu.append(openFile);

  state.root?.append(menu);
  state.repositoryMenu = menu;
  const bounds = anchor.getBoundingClientRect();
  const menuBounds = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(bounds.left, window.innerWidth - menuBounds.width - 4));
  const top = Math.max(4, Math.min(bounds.bottom + 4, window.innerHeight - menuBounds.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  state.repositoryMenuOutsideListener = event => {
    const target = event.target;
    if (target instanceof Node && (menu.contains(target) || anchor.contains(target))) return;
    closeRepositoryMenu(state);
  };
  setTimeout(() => {
    if (state.repositoryMenuOutsideListener) {
      document.addEventListener('click', state.repositoryMenuOutsideListener);
    }
  }, 0);
  anchor.classList.add('is-open');
  anchor.setAttribute('aria-expanded', 'true');
}

/** 打开排序选项菜单，排序状态由插件本地维护。 */
function openSortMenu(state, anchor) {
  closeContextMenu(state);
  closeSortMenu(state);
  closeRepositoryMenu(state);

  const menu = document.createElement('div');
  menu.className = 'file-explorer-menu-surface file-explorer-sort-menu';
  for (const option of SORT_OPTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'file-explorer-menu-item file-explorer-sort-menu__item';
    if (state.sort === option.id) item.classList.add('is-active');
    const selected = state.sort === option.id;
    const marker = selected ? sortCheckIcon('已选择') : document.createElement('span');
    marker.className = 'file-explorer-sort-check';
    const label = document.createElement('span');
    label.textContent = option.label;
    item.append(marker, label);
    item.setAttribute('aria-checked', String(state.sort === option.id));
    item.setAttribute('role', 'menuitemradio');
    item.addEventListener('click', () => {
      state.sort = option.id;
      persistSortPreferences(state);
      closeSortMenu(state);
      render(state);
    });
    menu.append(item);
    if (option.id === 'type' || option.id === 'modified-asc') {
      const separator = document.createElement('div');
      separator.className = 'file-explorer-menu-separator file-explorer-sort-menu__separator';
      menu.append(separator);
    }
  }
  const folderOrder = document.createElement('button');
  folderOrder.type = 'button';
  folderOrder.className = 'file-explorer-menu-item file-explorer-sort-menu__item';
  folderOrder.classList.add('is-active');
  folderOrder.append(sortCheckIcon('已启用'), document.createTextNode('文件夹总在最前'));
  folderOrder.disabled = true;
  menu.append(folderOrder);

  state.root?.append(menu);
  state.sortMenu = menu;
  const bounds = anchor.getBoundingClientRect();
  const menuBounds = menu.getBoundingClientRect();
  // 排序菜单与触发按钮左边缘对齐；菜单可以向右延伸到宿主浮层区域。
  const left = Math.max(4, bounds.left);
  const top = Math.max(4, Math.min(bounds.bottom + 4, window.innerHeight - menuBounds.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  state.sortMenuOutsideListener = () => closeSortMenu(state);
  setTimeout(() => {
    if (state.sortMenuOutsideListener) {
      document.addEventListener('click', state.sortMenuOutsideListener);
    }
  }, 0);
}

/** 将当前状态完整绘制为插件自有 DOM。 */
function render(state) {
  if (!state.list) return;
  state.directoryFileCountElements.clear();
  state.list.replaceChildren();
  renderStatus(state);
  if (state.error) return;
  renderDirectory(state, ROOT_DIRECTORY, 0);
  updateSelectedRows(state);
  updateExpandCollapseButton(state);
}

/** 更新选中样式，并为连续多选分组标记首尾圆角。 */
function updateSelectedRows(state) {
  const rows = [...(state.list?.querySelectorAll('.file-explorer-row') || [])];
  const selectedStates = rows.map(row => Boolean(row.dataset.path && state.selectedPaths.has(row.dataset.path)));
  rows.forEach((row, index) => {
    const selected = selectedStates[index];
    row.classList.toggle('is-active', selected);
    row.classList.toggle('is-selection-start', selected && !selectedStates[index - 1]);
    row.classList.toggle('is-selection-end', selected && !selectedStates[index + 1]);
  });
}

/** 设置单个主选中项，并清除其它多选项。 */
function setSingleSelection(state, path) {
  state.selectedPaths.clear();
  state.selectedPath = normalizePath(path);
  if (state.selectedPath !== ROOT_DIRECTORY) state.selectedPaths.add(state.selectedPath);
  updateSelectedRows(state);
}

/** 根据 Ctrl/Command 点击切换文件条目的选中状态。 */
function toggleEntrySelection(state, entry) {
  const path = normalizePath(entry.path);
  if (state.selectedPaths.has(path)) {
    state.selectedPaths.delete(path);
    const remaining = [...state.selectedPaths];
    state.selectedPath = remaining.length ? remaining[remaining.length - 1] : undefined;
  } else {
    state.selectedPaths.add(path);
    state.selectedPath = path;
  }
  updateSelectedRows(state);
}

/** 判断指针或鼠标事件是否请求追加多选。 */
function isMultiSelectionEvent(event) {
  return Boolean(event.ctrlKey || event.metaKey);
}

/** 从已加载的目录缓存中解析当前多选条目。 */
function getSelectedEntries(state) {
  const entriesByPath = new Map();
  for (const entries of state.entriesByDirectory.values()) {
    for (const entry of entries) entriesByPath.set(normalizePath(entry.path), entry);
  }
  return [...state.selectedPaths]
    .map(path => entriesByPath.get(path))
    .filter(Boolean);
}

/** 移除同时选中的父目录下的子条目，避免重复移动或删除。 */
function reduceNestedEntries(entries) {
  const uniqueEntries = [...new Map(entries.map(entry => [normalizePath(entry.path), entry])).values()];
  const selectedDirectories = uniqueEntries
    .filter(entry => entry.type === 'directory')
    .map(entry => normalizePath(entry.path));
  return uniqueEntries.filter(entry => {
    const path = normalizePath(entry.path);
    return !selectedDirectories.some(directory => path !== directory && path.startsWith(`${directory}/`));
  });
}

/** 返回右键菜单动作对应的单项或当前多选条目集合。 */
function getContextActionEntries(state, entry) {
  if (entry.path === ROOT_DIRECTORY || !state.selectedPaths.has(normalizePath(entry.path))) return [entry];
  return reduceNestedEntries(getSelectedEntries(state));
}

/** 判断文件或目录是否可以移动到指定目录。 */
function canMoveEntryToDirectory(entry, directory) {
  const targetDirectory = normalizePath(directory);
  if (parent(entry.path) === targetDirectory) return false;
  return entry.type !== 'directory'
    || (targetDirectory !== entry.path && !targetDirectory.startsWith(`${entry.path}/`));
}

/** 判断多选条目能否整体移动到指定目录。 */
function canMoveEntriesToDirectory(entries, directory) {
  const reducedEntries = reduceNestedEntries(entries);
  if (!reducedEntries.length) return false;
  if (reducedEntries.some(entry => entry.type === 'directory'
    && (normalizePath(directory) === normalizePath(entry.path)
      || normalizePath(directory).startsWith(`${normalizePath(entry.path)}/`)))) return false;
  return reducedEntries.some(entry => canMoveEntryToDirectory(entry, directory));
}

/** 清除当前文件拖放目标的视觉状态。 */
function clearFileDropTarget(state) {
  state.root?.querySelectorAll('.is-drop-target').forEach(element => element.classList.remove('is-drop-target'));
  state.dropTargetDirectory = undefined;
}

/** 将一个目录显示为当前文件拖放目标。 */
function showFileDropTarget(state, directory, element) {
  if (state.dropTargetDirectory === directory && element.classList.contains('is-drop-target')) return;
  clearFileDropTarget(state);
  state.dropTargetDirectory = directory;
  element.classList.add('is-drop-target');
}

/** 结束文件拖动并清理仅在当前视图内存在的拖放状态。 */
function clearFileDragState(state) {
  const candidate = state.dragCandidate;
  if (candidate?.row?.hasPointerCapture?.(candidate.pointerId)) {
    candidate.row.releasePointerCapture?.(candidate.pointerId);
  }
  clearFileDropTarget(state);
  if (state.externalFileDragActive) {
    state.context.editor.cancelFileDrag();
    state.externalFileDragActive = false;
  }
  state.dragAvatar?.remove();
  state.dragAvatar = undefined;
  state.dragCandidate = undefined;
  state.draggedEntry = undefined;
  state.draggedEntries = undefined;
  state.context.view.root.classList.remove('file-explorer-pointer-dragging');
}

/** 执行拖放移动并通过公开通知接口报告失败。 */
async function dropDraggedEntry(state, directory) {
  const entries = reduceNestedEntries(state.draggedEntries || (state.draggedEntry ? [state.draggedEntry] : []));
  clearFileDragState(state);
  if (!entries.length || !canMoveEntriesToDirectory(entries, directory)) return;
  try {
    await moveEntriesToDirectory(state, entries, directory);
  } catch (error) {
    await notifyOperationError(state, entries.length > 1 ? `移动 ${entries.length} 个条目` : entries[0].type === 'directory' ? '移动目录' : '移动文件', error);
  }
}

/** 将 CSS 像素字符串转换为 Canvas 绘制所需的数字。 */
function readDragPixel(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 将文件名截断到 Canvas 头像的可用宽度，并保留省略号。 */
function truncateDragLabel(canvasContext, label, maxWidth) {
  if (maxWidth <= 0 || canvasContext.measureText(label).width <= maxWidth) return label;
  const suffix = '...';
  const characters = [...label];
  while (characters.length > 0 && canvasContext.measureText(`${characters.join('')}${suffix}`).width > maxWidth) {
    characters.pop();
  }
  return `${characters.join('')}${suffix}`;
}

/** 将真实宿主 SVG 转换为 Canvas 可绘制的图片。 */
function loadDragAvatarIcon(iconElement, color) {
  const sourceSvg = iconElement.querySelector('svg');
  if (!(sourceSvg instanceof SVGElement)) return Promise.resolve(undefined);
  const svg = sourceSvg.cloneNode(true);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('color', color);
  svg.style.color = color;
  if (svg.getAttribute('stroke') === 'currentColor') svg.setAttribute('stroke', color);
  if (svg.getAttribute('fill') === 'currentColor') svg.setAttribute('fill', color);
  svg.querySelectorAll('[stroke="currentColor"]').forEach(element => element.setAttribute('stroke', color));
  svg.querySelectorAll('[fill="currentColor"]').forEach(element => element.setAttribute('fill', color));
  const serialized = new XMLSerializer().serializeToString(svg);
  const image = new Image();
  return new Promise(resolve => {
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
  });
}

/** 在透明 Canvas 上绘制文件图标和文件名，完全绕开原生拖拽快照。 */
function drawDragAvatarCanvas(canvas, entry, sourceRow, iconImage) {
  const bounds = canvas.getBoundingClientRect();
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext || bounds.width <= 0 || bounds.height <= 0) return;
  const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
  canvas.width = Math.ceil(bounds.width * devicePixelRatio);
  canvas.height = Math.ceil(bounds.height * devicePixelRatio);
  canvasContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  canvasContext.clearRect(0, 0, bounds.width, bounds.height);

  const avatarStyles = window.getComputedStyle(canvas);
  const labelElement = sourceRow.querySelector('.file-explorer-row__label');
  const labelStyles = window.getComputedStyle(labelElement || sourceRow);
  const font = labelStyles.font || `${labelStyles.fontWeight} ${labelStyles.fontSize} ${labelStyles.fontFamily}`;
  canvasContext.font = font;
  canvasContext.fillStyle = labelStyles.color;
  canvasContext.textBaseline = 'middle';

  const paddingInline = readDragPixel(avatarStyles.getPropertyValue('--file-explorer-drag-avatar-padding-inline'));
  const gap = readDragPixel(avatarStyles.getPropertyValue('--file-explorer-drag-avatar-gap'));
  const sourceIcon = sourceRow.querySelector('.file-explorer-icon');
  const iconBounds = sourceIcon?.getBoundingClientRect();
  const iconWidth = iconBounds?.width || 16;
  const iconHeight = iconBounds?.height || 16;
  const iconX = paddingInline;
  const iconY = (bounds.height - iconHeight) / 2;
  if (iconImage) canvasContext.drawImage(iconImage, iconX, iconY, iconWidth, iconHeight);

  const labelX = iconX + iconWidth + gap;
  const labelWidth = Math.max(0, bounds.width - labelX - paddingInline);
  const label = truncateDragLabel(canvasContext, entry.name, labelWidth);
  canvasContext.fillText(label, labelX, bounds.height / 2, labelWidth);
}

/** 创建跟随鼠标的透明 Canvas 拖拽头像，文字直接绘制为像素。 */
function createDragAvatar(state, entry, sourceRow, entryCount = 1) {
  const avatar = document.createElement('canvas');
  const sourceStyles = window.getComputedStyle(sourceRow);
  const previewEntry = entryCount > 1 ? { ...entry, name: `${entry.name} +${entryCount - 1}` } : entry;
  const avatarIcon = entry.type === 'directory'
    ? icon(state, 'folder', '目录')
    : entry.encrypted ? encryptedFileIcon('加密文件') : documentFileIcon(state, '文件');
  avatar.className = 'file-explorer-drag-avatar';
  avatar.setAttribute('role', 'img');
  avatar.setAttribute('aria-label', previewEntry.name);
  avatar.style.color = sourceStyles.color;
  state.context.view.root.append(avatar);
  drawDragAvatarCanvas(avatar, previewEntry, sourceRow);
  void loadDragAvatarIcon(avatarIcon, sourceStyles.color).then(iconImage => {
    if (!avatar.isConnected) return;
    drawDragAvatarCanvas(avatar, previewEntry, sourceRow, iconImage);
  });
  return avatar;
}

/** 更新透明拖拽头像的位置，使其显示在鼠标右下方。 */
function updateDragAvatar(state, event) {
  if (!state.dragAvatar) return;
  const bounds = state.dragAvatar.getBoundingClientRect();
  const left = Math.min(event.clientX + FILE_DRAG_AVATAR_OFFSET, window.innerWidth - bounds.width - 4);
  const top = Math.min(event.clientY + FILE_DRAG_AVATAR_OFFSET, window.innerHeight - bounds.height - 4);
  state.dragAvatar.style.left = `${Math.max(4, left)}px`;
  state.dragAvatar.style.top = `${Math.max(4, top)}px`;
}

/** 根据指针位置解析目录行、仓库标题或列表留白对应的移动目标。 */
function resolvePointerDropTarget(state, clientX, clientY) {
  const viewRoot = state.context.view.root;
  const rootNode = viewRoot.getRootNode();
  if (!(rootNode instanceof ShadowRoot)) return undefined;
  const target = rootNode.elementFromPoint(clientX, clientY);
  if (!(target instanceof Element) || !viewRoot.contains(target)) return undefined;
  const row = target.closest('.file-explorer-row');
  if (row) {
    const rowPath = normalizePath(row.dataset.path);
    if (row.classList.contains('file-explorer-row--directory')) {
      return { directory: rowPath, element: row };
    }
    const directory = parent(rowPath);
    const directoryElement = directory === ROOT_DIRECTORY
      ? state.repositoryButton
      : state.root?.querySelector(`.file-explorer-row--directory[data-path="${CSS.escape(directory)}"]`);
    return { directory, element: directoryElement || state.repositoryButton };
  }
  if (state.repositoryButton?.contains(target)) {
    return { directory: ROOT_DIRECTORY, element: state.repositoryButton };
  }
  if (state.list?.contains(target)) {
    return { directory: ROOT_DIRECTORY, element: state.repositoryButton };
  }
  if (target === state.root || target === viewRoot) {
    return { directory: ROOT_DIRECTORY, element: state.repositoryButton };
  }
  return undefined;
}

/** 根据指针位置更新目录行的拖拽目标样式。 */
function updatePointerDropTarget(state, event) {
  if (!state.draggedEntries?.length) return;
  const target = resolvePointerDropTarget(state, event.clientX, event.clientY);
  if (!target || !canMoveEntriesToDirectory(state.draggedEntries, target.directory)) {
    clearFileDropTarget(state);
    return;
  }
  showFileDropTarget(state, target.directory, target.element);
}

/** 将候选指针拖拽提升为正式拖拽并创建插件自绘头像。 */
function startPointerDrag(state, candidate, event) {
  if (!state.selectedPaths.has(normalizePath(candidate.entry.path))) {
    if (candidate.additive) {
      state.selectedPaths.add(normalizePath(candidate.entry.path));
      state.selectedPath = candidate.entry.path;
      updateSelectedRows(state);
    } else setSingleSelection(state, candidate.entry.path);
  }
  const selectedEntries = getSelectedEntries(state);
  const orderedEntries = [candidate.entry, ...selectedEntries.filter(entry => entry.path !== candidate.entry.path)];
  state.draggedEntries = reduceNestedEntries(orderedEntries);
  state.draggedEntry = state.draggedEntries[0];
  candidate.row.setPointerCapture?.(candidate.pointerId);
  state.dragAvatar = createDragAvatar(state, state.draggedEntry, candidate.row, state.draggedEntries.length);
  if (state.draggedEntries.length === 1 && state.draggedEntry?.type === 'file') {
    state.externalFileDragActive = true;
    state.context.editor.beginFileDrag(state.draggedEntry.path, state.draggedEntry.name);
  }
  state.context.view.root.classList.add('file-explorer-pointer-dragging');
  updateDragAvatar(state, event);
  if (state.externalFileDragActive) {
    state.context.editor.updateFileDrag(event.clientX, event.clientY);
  }
}

/** 为文件树条目注册插件内部的指针拖拽。 */
function configureEntryPointerDrag(state, row, entry) {
  row.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return;
    state.dragCandidate = {
      entry,
      row,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      additive: isMultiSelectionEvent(event)
    };
  });
}

/** 处理指针移动，超过启动距离后显示自绘拖拽头像。 */
function handleFilePointerMove(state, event) {
  const candidate = state.dragCandidate;
  if (!candidate || candidate.pointerId !== event.pointerId) return;
  if (!state.draggedEntries?.length) {
    const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
    if (distance < FILE_DRAG_START_DISTANCE) return;
    startPointerDrag(state, candidate, event);
  }
  event.preventDefault();
  event.stopPropagation();
  updateDragAvatar(state, event);
  if (state.externalFileDragActive) {
    state.context.editor.updateFileDrag(event.clientX, event.clientY);
  }
  updatePointerDropTarget(state, event);
}

/** 处理指针释放，在合法目录上调用公开文件系统移动接口。 */
function handleFilePointerUp(state, event) {
  const candidate = state.dragCandidate;
  if (!candidate || candidate.pointerId !== event.pointerId) return;
  if (!state.draggedEntries?.length) {
    clearFileDragState(state);
    return;
  }
  const target = resolvePointerDropTarget(state, event.clientX, event.clientY);
  if (state.externalFileDragActive && !target) {
    state.externalFileDragActive = false;
    state.context.editor.endFileDrag(event.clientX, event.clientY);
    clearFileDragState(state);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  state.suppressClickUntil = performance.now() + 250;
  updatePointerDropTarget(state, event);
  const directory = state.dropTargetDirectory;
  if (!directory || !canMoveEntriesToDirectory(state.draggedEntries, directory)) {
    clearFileDragState(state);
    return;
  }
  void dropDraggedEntry(state, directory);
}

/** 处理指针拖拽取消并清理候选、头像和目标状态。 */
function handleFilePointerCancel(state, event) {
  if (state.dragCandidate?.pointerId !== event.pointerId) return;
  clearFileDragState(state);
}

/** 渲染目录树节点及其已展开的子目录。 */
function renderDirectory(state, directory, depth) {
  const entries = sortedEntries(state, directory);
  const isCreatingInDirectory = state.creating?.directory === directory;
  const createPosition = state.creating?.position || 'before-files';
  let createRowRendered = false;
  if (isCreatingInDirectory && createPosition === 'start') {
    renderCreateRow(state, directory, depth);
    createRowRendered = true;
  }
  if (entries.length === 0 && directory === ROOT_DIRECTORY && !state.busy && !state.creating) {
    const empty = document.createElement('p');
    empty.className = 'file-explorer-empty';
    empty.textContent = '当前仓库为空。';
    state.list.append(empty);
    return;
  }
  for (const entry of entries) {
    if (isCreatingInDirectory && !createRowRendered && createPosition === 'before-files' && entry.type === 'file') {
      renderCreateRow(state, directory, depth);
      createRowRendered = true;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `file-explorer-row file-explorer-row--${entry.type}`;
    row.style.setProperty('--file-explorer-depth', String(depth));
    row.dataset.path = normalizePath(entry.path);
    if (entry.type === 'directory') {
      const expanded = state.expanded.has(entry.path);
      row.append(icon(state, expanded ? 'arrow-down' : 'arrow-forward', expanded ? '收起' : '展开'));
      row.append(icon(state, expanded ? 'fold-open' : 'folder', expanded ? '展开的文件夹' : '文件夹'));
      appendEntryName(state, row, entry);
      appendDirectoryFileCount(state, row, entry);
      row.addEventListener('click', async event => {
        if (isMultiSelectionEvent(event)) {
          toggleEntrySelection(state, entry);
          return;
        }
        setSingleSelection(state, entry.path);
        state.allExpanded = false;
        if (state.expanded.has(entry.path)) {
          state.expanded.delete(entry.path);
        } else {
          await ensureDirectory(state, entry.path);
          state.expanded.add(entry.path);
        }
        render(state);
      });
      row.addEventListener('contextmenu', event => openContextMenu(state, event, entry));
      configureEntryPointerDrag(state, row, entry);
      state.list.append(row);
      if (expanded && state.entriesByDirectory.has(entry.path)) renderDirectory(state, entry.path, depth + 1);
    } else {
      row.append(entryExpandSpacer());
      row.append(entry.encrypted ? encryptedFileIcon('加密文件') : documentFileIcon(state, '文件'));
      appendEntryName(state, row, entry);
      row.addEventListener('click', event => {
        if (isMultiSelectionEvent(event)) toggleEntrySelection(state, entry);
        else setSingleSelection(state, entry.path);
      });
      row.addEventListener('dblclick', () => void openEntry(state, entry));
      row.addEventListener('contextmenu', event => openContextMenu(state, event, entry));
      configureEntryPointerDrag(state, row, entry);
      state.list.append(row);
    }
  }
  if (isCreatingInDirectory && !createRowRendered) renderCreateRow(state, directory, depth);
}

/** 渲染普通条目名称或当前条目的内联重命名输入框。 */
function appendEntryName(state, row, entry) {
  if (state.renaming?.path !== entry.path) {
    const label = document.createElement('span');
    label.className = 'file-explorer-row__label';
    label.textContent = visibleEntryName(state, entry);
    row.append(label);
    if (entry.type === 'file' && state.showFileType) {
      const type = document.createElement('span');
      type.className = 'file-explorer-row__type';
      type.textContent = fileTypeLabel(entry);
      type.title = `文件类型：${type.textContent}`;
      row.append(type);
    }
    return;
  }
  const input = document.createElement('input');
  input.className = 'file-explorer-create-input file-explorer-rename-input';
  input.value = state.renaming.name;
  input.setAttribute('aria-label', '重命名');
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('mousedown', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void submitInlineRename(state, input.value);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelInlineRename(state);
    }
  });
  input.addEventListener('blur', () => void submitInlineRename(state, input.value));
  row.append(input);
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

/** 在原文件行启动重命名，不依赖 dialogs.show 权限。 */
function startInlineRename(state, entry) {
  state.renaming = { path: entry.path, name: entry.name, type: entry.type };
  setSingleSelection(state, entry.path);
  render(state);
}

/** 提交内联重命名并刷新原父目录。 */
async function submitInlineRename(state, rawName) {
  const renaming = state.renaming;
  if (!renaming) return;
  const name = rawName.trim();
  if (!name || name === renaming.name) {
    cancelInlineRename(state);
    return;
  }
  state.renaming = undefined;
  try {
    const renamedEntry = await state.context.filesystem.rename(renaming.path, name);
    setSingleSelection(state, renamedEntry.path);
    if (renaming.type === 'directory') {
      refreshMoveDirectories(state);
      invalidateDirectoryFileCounts(state);
    }
    await refreshDirectory(state, parent(renaming.path));
  } catch (error) {
    render(state);
    await notifyOperationError(state, '重命名', error);
  }
}

/** 取消当前内联重命名。 */
function cancelInlineRename(state) {
  if (!state.renaming) return;
  state.renaming = undefined;
  render(state);
}

/** 鍦ㄧ洰鏍囩洰褰曚腑娓叉煋鎴栭噸鐢ㄥ唴鑱旀柊寤鸿緭鍏ヨ锛岀‘淇濆悓涓€浼氳瘽鍙湁涓€涓緭鍏ユ銆?*/
function renderCreateRow(state, directory, depth) {
  const creating = state.creating;
  const existing = state.createRow;
  if (existing
    && existing.directory === directory
    && existing.type === creating.type
    && existing.extension === creating.extension
    && existing.position === creating.position) {
    existing.row.style.setProperty('--file-explorer-depth', String(depth));
    state.list.append(existing.row);
    requestAnimationFrame(() => {
      if (state.creating === creating) {
        existing.input.focus();
      }
    });
    return;
  }
  const row = document.createElement('div');
  const input = document.createElement('input');
  row.className = 'file-explorer-row file-explorer-create-row';
  row.style.setProperty('--file-explorer-depth', String(depth));
  if (state.creating.type === 'directory') {
    row.append(icon(state, 'arrow-forward', '展开'), icon(state, 'folder', '文件夹'));
  } else {
    row.append(entryExpandSpacer(), documentFileIcon(state, '文件'));
  }
  input.className = 'file-explorer-create-input';
  input.placeholder = state.creating.type === 'directory' ? '目录名称' : `文件名称${state.creating.extension}`;
  input.setAttribute('aria-label', input.placeholder);
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitInlineCreate(state, input.value);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelInlineCreate(state);
    }
  });
  input.addEventListener('blur', () => {
    if (!input.value.trim()) {
      // Allow toolbar clicks to refocus the existing input before cancelling it.
      window.setTimeout(() => {
        const currentInput = state.list?.querySelector(
          '.file-explorer-create-input:not(.file-explorer-rename-input)'
        );
        if (currentInput !== input || state.newFile || !state.creating || currentInput.matches(':focus')) return;
        cancelInlineCreate(state);
      }, 0);
    }
  });
  row.append(input);
  state.createRow = { row, input, directory, type: creating.type, extension: creating.extension, position: creating.position };
  state.list.append(row);
  requestAnimationFrame(() => input.focus());
}

/** 在文件树中启动新建文件或目录，不依赖 dialogs.show 权限。 */
function isInlineCreateControl(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    '.file-explorer-create-input:not(.file-explorer-rename-input),'
      + '[data-action="new-file"], [data-action="new-folder"],'
      + '[data-action="new-file-inline"], [data-action="new-text"], [data-action="new-json"]'
  ));
}

function isInlineCreateEvent(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  return path.some(target => isInlineCreateControl(target));
}

function handleInlineCreatePointerDown(state, event) {
  if (isInlineCreateEvent(event)) {
    if (state.creating) state.newFile = true;
    return;
  }
  if (!state.newFile) return;
  state.newFile = false;
  const input = state.list?.querySelector('.file-explorer-create-input:not(.file-explorer-rename-input)');
  if (input instanceof HTMLInputElement && !input.value.trim()) cancelInlineCreate(state);
}

function focusInlineCreate(state) {
  const input = state.list?.querySelector('.file-explorer-create-input:not(.file-explorer-rename-input)');
  if (!(input instanceof HTMLInputElement)) return;
  input.focus();
  input.select();
}

function hasInlineCreateInput(state) {
  return state.list?.querySelector('.file-explorer-create-input:not(.file-explorer-rename-input)') instanceof HTMLInputElement;
}

function clearStaleInlineCreate(state) {
  if (hasInlineCreateInput(state)) return false;
  state.newFile = false;
  state.creating = undefined;
  state.createRow = undefined;
  return true;
}

/** 在文件与文件夹内联新建之间切换，复用当前会话并保留已输入的名称。 */
function switchInlineCreateType(state, directory, type, extension, position) {
  const creating = state.creating;
  const input = state.list?.querySelector('.file-explorer-create-input:not(.file-explorer-rename-input)');
  if (!creating || !(input instanceof HTMLInputElement) || creating.directory !== directory) return false;
  if (creating.type === type && creating.extension === extension && creating.position === position) {
    state.newFile = true;
    focusInlineCreate(state);
    return true;
  }
  const value = input.value;
  creating.type = type;
  creating.extension = extension;
  creating.position = position;
  state.newFile = true;
  state.createRow = undefined;
  render(state);
  const nextInput = state.list?.querySelector('.file-explorer-create-input:not(.file-explorer-rename-input)');
  if (nextInput instanceof HTMLInputElement) {
    nextInput.value = value;
    nextInput.focus();
    nextInput.select();
  }
  return true;
}

/** 在文件树中启动新建文件或目录，不重复销毁当前的内联输入。 */
async function startInlineCreate(state, directory, type, extension = '', position = 'before-files') {
  if (state.newFile || state.creating) {
    if (clearStaleInlineCreate(state)) {
      // A previous asynchronous request ended without rendering its input row.
    } else if (switchInlineCreateType(state, directory, type, extension, position)) {
      return;
    } else {
      state.newFile = true;
      focusInlineCreate(state);
      return;
    }
  }
  state.newFile = true;
  state.creating = { directory, type, extension, position };
  if (directory !== ROOT_DIRECTORY) {
    const creating = state.creating;
    await ensureDirectory(state, directory);
    if (state.creating !== creating) return;
    state.expanded.add(directory);
  }
  if (!state.creating) return;
  render(state);
}

/** 提交文件树内联新建并刷新目标目录。 */
async function submitInlineCreate(state, rawName) {
  const creating = state.creating;
  const name = rawName.trim();
  if (!creating || !name) return;
  const finalName = creating.type === 'file' && !name.toLowerCase().endsWith(creating.extension)
    ? `${name}${creating.extension}`
    : name;
  const target = creating.directory === ROOT_DIRECTORY ? finalName : `${creating.directory}/${finalName}`;
  state.newFile = false;
  state.creating = undefined;
  state.createRow = undefined;
  try {
    if (creating.type === 'directory') {
      await state.context.filesystem.createDirectory(target);
      refreshMoveDirectories(state);
    }
    else await state.context.filesystem.createFile(target, '');
    setSingleSelection(state, target);
    await refreshDirectory(state, creating.directory);
  } catch (error) {
    render(state);
    await notifyOperationError(state, creating.type === 'directory' ? '新建目录' : '新建文件', error);
  }
}

/** 取消尚未提交的内联新建。 */
function cancelInlineCreate(state) {
  state.newFile = false;
  if (!state.creating) return;
  state.creating = undefined;
  state.createRow = undefined;
  render(state);
}

/** 确保展开目录已加载。 */
async function ensureDirectory(state, directory) {
  if (state.entriesByDirectory.has(directory)) return;
  await loadDirectory(state, directory);
}

/** 显示加载、错误和空状态。 */
function renderStatus(state) {
  if (!state.status) return;
  state.status.replaceChildren();
  if (state.error) {
    state.status.textContent = state.error;
    state.status.hidden = false;
  } else state.status.hidden = true;
}

/** 打开文件或目录的默认操作。 */
async function openEntry(state, entry) {
  try {
    if (entry.type === 'directory') {
      state.allExpanded = false;
      state.expanded.add(entry.path);
      await ensureDirectory(state, entry.path);
      render(state);
    } else await state.context.editor.openFile(entry.path);
  } catch (error) {
    await notifyOperationError(state, entry.type === 'directory' ? '打开目录' : '打开文件', error);
  }
}

/** 打开插件自有的原生上下文菜单，并根据触发行自动选择展开方向。 */
function openContextMenu(state, event, entry, providedActions, placement = 'auto') {
  event.preventDefault();
  const entryPath = normalizePath(entry.path);
  if (entryPath === ROOT_DIRECTORY || !state.selectedPaths.has(entryPath)) setSingleSelection(state, entryPath);
  else {
    state.selectedPath = entryPath;
    updateSelectedRows(state);
  }
  closeContextMenu(state);
  closeSortMenu(state);
  closeRepositoryMenu(state);
  const menu = document.createElement('div');
  menu.className = 'file-explorer-menu-surface file-explorer-menu';
  const actions = providedActions
    || (entry.type === 'directory' ? folderContextActions(state) : fileContextActions(entry));
  appendContextActions(state, menu, actions, entry);
  state.root?.append(menu);
  state.menu = menu;
  const menuBounds = menu.getBoundingClientRect();
  const anchorBounds = event.currentTarget instanceof Element
    ? event.currentTarget.getBoundingClientRect()
    : undefined;
  const anchorBottom = anchorBounds?.bottom ?? event.clientY;
  const availableBelow = window.innerHeight - anchorBottom - 4;
  const opensAbove = placement === 'above'
    || (placement === 'auto' && menuBounds.height > availableBelow);
  const upwardEdge = placement === 'above' ? event.clientY : anchorBottom;
  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - menuBounds.width - 4))}px`;
  const preferredTop = opensAbove
    ? upwardEdge - menuBounds.height
    : event.clientY;
  menu.style.top = `${Math.max(4, Math.min(preferredTop, window.innerHeight - menuBounds.height - 4))}px`;
  menu.classList.toggle('file-explorer-menu--opens-above', opensAbove);
  setTimeout(() => document.addEventListener('click', () => closeContextMenu(state), { once: true }), 0);
}

/** 删除右键命中条目或当前多选集合，并在批量操作结束后统一刷新。 */
async function deleteContextEntries(state, anchorEntry) {
  const entries = reduceNestedEntries(getContextActionEntries(state, anchorEntry));
  if (!entries.length) return;
  const multiple = entries.length > 1;
  const confirmed = await state.context.dialogs.confirm({
    title: multiple ? `删除 ${entries.length} 个条目` : '删除条目',
    message: multiple ? `确定删除选中的 ${entries.length} 个条目吗？` : `确定删除“${entries[0].name}”吗？`,
    confirmLabel: '删除',
    destructive: true
  });
  if (!confirmed) return;

  const deletedEntries = [];
  let failure;
  for (const entry of entries) {
    try {
      await state.context.filesystem.delete(entry.path, { recursive: entry.type === 'directory' });
      deletedEntries.push(entry);
    } catch (error) {
      failure = error;
      break;
    }
  }
  for (const entry of deletedEntries) {
    if (entry.type === 'directory') discardMovedDirectoryState(state, entry.path);
  }
  for (const entry of deletedEntries) {
    const deletedPath = normalizePath(entry.path);
    for (const path of [...state.selectedPaths]) {
      if (path === deletedPath || (entry.type === 'directory' && path.startsWith(`${deletedPath}/`))) {
        state.selectedPaths.delete(path);
      }
    }
  }
  const remaining = [...state.selectedPaths];
  state.selectedPath = remaining.length ? remaining[remaining.length - 1] : undefined;
  const deletedFilePaths = deletedEntries
    .filter(entry => entry.type === 'file')
    .map(entry => normalizePath(entry.path));
  if (deletedFilePaths.length) {
    await state.context.editor.closeTabs(deletedFilePaths);
  }
  if (deletedEntries.some(entry => entry.type === 'directory')) refreshMoveDirectories(state);
  if (deletedEntries.length) await refreshAll(state);
  if (failure) throw failure;
}

/** 返回文件树目录通用的新建子菜单。 */
function createEntryContextAction() {
  return { label: '新建', children: [
    { id: 'new-file-inline', label: '文件' },
    { id: 'new-file', label: '笔记' },
    { id: 'new-folder', label: '目录' },
    { id: 'new-text', label: '文本文档' },
    { id: 'new-json', label: 'JSON 文件' }
  ] };
}

/** 返回与旧版文件列表一致的目录右键菜单结构。 */
function folderContextActions(state) {
  return [
    createEntryContextAction(),
    null,
    { id: 'cut', label: '剪切' }, { id: 'clipboard-copy', label: '复制' },
    { label: '复制路径', children: pathCopyActions() },
    { id: 'paste', label: '粘贴', disabled: !state.clipboard },
    null,
    { id: 'duplicate', label: '创建副本' },
    { id: 'move', label: '移动文件夹到...' },
    { id: 'find', label: '在文件中查找', disabled: true },
    { id: 'replace', label: '在文件中替换', disabled: true },
    { id: 'favorite', label: '收藏', disabled: true },
    null,
    { id: 'reveal', label: '在系统资源管理器中显示' },
    null,
    { id: 'rename', label: '重命名' }, { id: 'delete', label: '删除', danger: true }
  ];
}

/** 返回文件树空白区域使用的仓库根目录菜单。 */
function rootContextActions(state) {
  return [
    createEntryContextAction(),
    null,
    { id: 'paste', label: '粘贴', disabled: !state.clipboard },
    { id: 'system-open', label: '在资源管理器中打开' }
  ];
}

/** 在文件树空白区域打开仓库根目录菜单。 */
function openRootContextMenu(state, event) {
  const rootEntry = {
    type: 'directory',
    path: ROOT_DIRECTORY,
    name: state.repository?.name || '/',
    createPosition: 'before-files',
    isRootContext: true
  };
  openContextMenu(state, event, rootEntry, rootContextActions(state), 'above');
}

/** 返回与旧版文件列表一致的文件右键菜单结构。 */
function fileContextActions(entry) {
  return [
    { id: 'open', label: '在新标签页中打开' },
    { id: 'new-group', label: '在新标签组中打开' },
    { id: 'new-window', label: '在新窗口中打开' },
    null,
    { id: 'duplicate', label: '创建副本' },
    { label: '复制路径', children: pathCopyActions() },
    { id: 'move', label: '将文件移动到...' },
    { id: 'favorite', label: '收藏', disabled: true },
    { id: entry.encrypted ? 'decrypt' : 'encrypt', label: entry.encrypted ? '解密' : '加密' },
    null,
    { id: 'system-open', label: '使用系统默认应用打开' },
    { id: 'reveal', label: '在资源管理器中显示' },
    null,
    { id: 'rename', label: '重命名' }, { id: 'delete', label: '删除', danger: true }
  ];
}

/** 返回复制路径二级菜单的三种稳定路径形式。 */
function pathCopyActions() {
  return [
    { id: 'copy-path-absolute', label: '绝对路径' },
    { id: 'copy-path-repository-root', label: '仓库根路径' },
    { id: 'copy-path-content-root', label: '内容根路径' }
  ];
}

/** 将声明式菜单项渲染为插件自有 DOM，支持分割线和悬停二级菜单。 */
function appendContextActions(state, menu, actions, entry) {
  for (const action of actions) {
    if (!action) {
      const separator = document.createElement('div');
      separator.className = 'file-explorer-menu-separator';
      menu.append(separator);
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'file-explorer-menu-item file-explorer-menu-action';
    if (action.id) item.dataset.action = action.id;
    item.disabled = Boolean(action.disabled);
    if (action.danger) item.classList.add('is-danger');
    item.textContent = action.label;
    if (action.children) {
      const container = document.createElement('div');
      const submenu = document.createElement('div');
      const arrow = contextMenuArrowIcon();
      container.className = 'file-explorer-menu-submenu';
      submenu.className = 'file-explorer-menu-surface file-explorer-menu-submenu__panel';
      item.append(arrow);
      appendContextActions(state, submenu, action.children, entry);
      container.append(item, submenu);
      menu.append(container);
      continue;
    }
    item.addEventListener('click', () => { closeContextMenu(state); void contextAction(state, action.id, entry); });
    menu.append(item);
  }
}

/** 为根目录右键菜单直接生成不重名的默认文件名。 */
async function createDefaultContextFile(state, directory, baseName, extension, sequenceStart = 1) {
  const entries = await state.context.filesystem.listEntries(directory);
  const names = new Set(entries.map(entry => String(entry.name || '').toLowerCase()));
  let name = `${baseName}${extension}`;
  let sequence = sequenceStart;
  while (names.has(name.toLowerCase())) {
    name = `${baseName}${sequence}${extension}`;
    sequence += 1;
  }
  const target = directory === ROOT_DIRECTORY ? name : `${directory}/${name}`;
  await state.context.filesystem.createFile(target, '');
  setSingleSelection(state, target);
  await state.context.editor.openFile(target);
  await refreshDirectory(state, directory);
}

/** 执行文件树上下文菜单动作。 */
async function contextAction(state, action, entry) {
  try {
    if (action === 'open') return void openEntry(state, entry);
    if (action === 'new-group') return void state.context.editor.openFile(entry.path, { disposition: 'new-group' });
    if (action === 'new-window') return void state.context.windows.open({ kind: 'workbench', filePath: entry.path, reuse: 'always-new' });
    if (action === 'new-file' || action === 'new-file-inline') {
      if (action === 'new-file' && entry.isRootContext) return await createDefaultContextFile(state, entry.path, '未命名', '.md');
      if (entry.createPosition === 'before-files') return void startInlineCreate(state, entry.path, 'file', '.md', entry.createPosition);
      return void startInlineCreate(state, entry.path, 'file', '.md');
    }
    if (action === 'new-text') {
      if (entry.isRootContext) return await createDefaultContextFile(state, entry.path, '新建文本文档', '.txt');
      if (entry.createPosition === 'before-files') return void startInlineCreate(state, entry.path, 'file', '.txt', entry.createPosition);
      return void startInlineCreate(state, entry.path, 'file', '.txt');
    }
    if (action === 'new-json') {
      if (entry.isRootContext) return await createDefaultContextFile(state, entry.path, 'Untitled', '.json', 2);
      if (entry.createPosition === 'before-files') return void startInlineCreate(state, entry.path, 'file', '.json', entry.createPosition);
      return void startInlineCreate(state, entry.path, 'file', '.json');
    }
    if (action === 'new-folder') {
      return void startInlineCreate(state, entry.path, 'directory', '', 'start');
    }
    if (action === 'rename') return void startInlineRename(state, entry);
    if (action === 'move') return void moveEntry(state, entry);
    if (action === 'duplicate') return void copyEntry(state, entry);
    if (action === 'cut' || action === 'clipboard-copy') {
      state.clipboard = { entry, operation: action === 'cut' ? 'move' : 'copy' };
      return;
    }
    if (action === 'paste') return void pasteEntry(state, entry.path);
    if (action.startsWith('copy-path-')) return void copyEntryPath(state, entry, action.slice('copy-path-'.length));
    if (action === 'system-open') {
      await state.context.workspace.openWithDefaultApp(entry.path);
      return;
    }
    if (action === 'reveal') {
      await state.context.workspace.revealInFileManager(entry.path);
      return;
    }
    if (action === 'encrypt' || action === 'decrypt') return void protectEntry(state, entry, action);
    if (action === 'delete') {
      await deleteContextEntries(state, entry);
      return;
    }
  } catch (error) {
    await notifyOperationError(state, '执行文件操作', error);
  }
}

/** 复制工作区路径并将权限拒绝转换为明确的授权提示。 */
async function copyEntryPath(state, entry, kind) {
  try {
    await state.context.workspace.copyPath(entry.path, kind);
    await state.context.notifications.show('路径已复制。');
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : '';
    if (code === 'PLUGIN_PERMISSION_DENIED') {
      await state.context.notifications.show('复制路径需要“写入剪贴板”权限，请在插件管理的权限授权中启用。', { type: 'warning' });
      return;
    }
    throw error;
  }
}

/** 收集工作区目录供移动条目时选择，并在仓库切换后停止旧扫描。 */
async function collectDirectories(state, directory = ROOT_DIRECTORY, depth = 0, result = [], generation = state.moveDirectoriesGeneration) {
  if (generation !== state.moveDirectoriesGeneration) return result;
  result.push({ id: directory, label: directory === ROOT_DIRECTORY ? '仓库根目录' : directory.split('/').pop(), depth });
  const entries = await state.context.filesystem.listEntries(directory);
  if (generation !== state.moveDirectoriesGeneration) return result;
  for (const entry of filterFileExplorerEntries(entries)) {
    if (entry.type === 'directory') {
      await collectDirectories(state, entry.path, depth + 1, result, generation);
      if (generation !== state.moveDirectoriesGeneration) return result;
    }
  }
  return result;
}

/** 返回复用的移动目录索引，避免每次打开窗口重新扫描仓库。 */
function loadMoveDirectories(state) {
  if (state.moveDirectories) return Promise.resolve(state.moveDirectories);
  if (state.moveDirectoriesPromise) {
    const pending = state.moveDirectoriesPromise;
    return pending.then(() => {
      if (state.moveDirectories) return state.moveDirectories;
      return loadMoveDirectories(state);
    });
  }
  const generation = state.moveDirectoriesGeneration;
  const request = collectDirectories(state, ROOT_DIRECTORY, 0, [], generation).then(directories => {
    if (generation === state.moveDirectoriesGeneration) state.moveDirectories = directories;
    return directories;
  }).finally(() => {
    if (state.moveDirectoriesPromise === request) state.moveDirectoriesPromise = undefined;
  });
  state.moveDirectoriesPromise = request;
  return request;
}

/** 目录结构变化后使移动目录索引失效，按需重新读取。 */
function refreshMoveDirectories(state) {
  state.moveDirectoriesGeneration += 1;
  state.moveDirectories = undefined;
}

/** 过滤非法或无效的移动目标，同时保留原父目录作为禁用提示。 */
function resolveMoveTargets(directories, entry, currentParent) {
  return directories.filter(directory => (
    directory.id !== entry.path
    && !directory.id.startsWith(`${entry.path}/`)
  )).map(directory => ({ ...directory, disabled: directory.id === currentParent }));
}

/** 判断移动目标目录是否符合当前搜索文字。 */
function matchesMoveDirectory(directory, query) {
  if (!query) return true;
  const displayName = directory.id === ROOT_DIRECTORY ? '/' : directory.label;
  return displayName.toLocaleLowerCase().includes(query)
    || directory.id.toLocaleLowerCase().includes(query);
}

/** 根据展开状态或搜索结果返回当前应显示的目录树节点。 */
function visibleMoveDirectories(directories, expandedDirectories, query) {
  if (query) {
    const visibleIds = new Set();
    for (const directory of directories) {
      if (!matchesMoveDirectory(directory, query)) continue;
      let path = directory.id;
      while (true) {
        visibleIds.add(path);
        if (path === ROOT_DIRECTORY) break;
        path = parent(path);
      }
    }
    return directories.filter(directory => visibleIds.has(directory.id));
  }
  return directories.filter(directory => {
    if (directory.id === ROOT_DIRECTORY) return true;
    let ancestor = parent(directory.id);
    while (true) {
      if (!expandedDirectories.has(ancestor)) return false;
      if (ancestor === ROOT_DIRECTORY) return true;
      ancestor = parent(ancestor);
    }
  });
}

/** 判断目标目录是否位于指定目录之下。 */
function isMoveDirectoryDescendant(path, ancestor) {
  if (!path || path === ancestor) return false;
  return ancestor === ROOT_DIRECTORY || path.startsWith(`${ancestor}/`);
}

/** 使用公开目录选择对话框移动文件或文件夹。 */
function moveEntry(state, entry) {
  const currentParent = parent(entry.path);
  openMoveDialog(state, entry, currentParent);
}

/** 使用公开文件系统接口移动条目，并只刷新受影响的源目录和目标目录。 */
async function moveEntryToDirectory(state, entry, directory) {
  await moveEntriesToDirectory(state, [entry], directory);
}

/** 立即显示移动窗口，再异步加载可选目录。 */
function openMoveDialog(state, entry, currentParent) {
  closeMoveDialog(state);
  const overlay = document.createElement('div');
  const dialog = document.createElement('section');
  const title = document.createElement('h2');
  const search = document.createElement('input');
  const list = document.createElement('div');
  const scrollArea = createOperationScrollArea(list);
  const actions = document.createElement('footer');
  const hints = document.createElement('span');
  const cancel = document.createElement('button');
  const confirm = document.createElement('button');
  let directories = state.moveDirectories
    ? resolveMoveTargets(state.moveDirectories, entry, currentParent)
    : [{ id: ROOT_DIRECTORY, label: '仓库根目录', depth: 0, disabled: currentParent === ROOT_DIRECTORY }];
  const expandedDirectories = new Set([ROOT_DIRECTORY]);
  let selected = directories.find(directory => !directory.disabled)?.id;
  let loading = !state.moveDirectories;

  overlay.className = 'file-explorer-operation-overlay';
  dialog.className = 'file-explorer-operation-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  title.textContent = entry.type === 'directory' ? '移动文件夹到' : '移动文件到';
  search.className = 'file-explorer-operation-search';
  search.placeholder = '搜索文件夹';
  list.className = 'file-explorer-operation-list';
  list.setAttribute('role', 'tree');
  actions.className = 'file-explorer-operation-actions';
  hints.className = 'file-explorer-operation-hints';
  for (const hint of ['↑↓ 导航', '↵ 确认', 'Esc 退出']) {
    const hintItem = document.createElement('span');
    hintItem.textContent = hint;
    hints.append(hintItem);
  }
  cancel.type = 'button';
  cancel.textContent = '取消';
  confirm.type = 'button';
  confirm.textContent = '移动';
  confirm.disabled = true;

  /** 只更新移动目录的选中状态，避免重建节点导致键盘焦点丢失。 */
  const updateMoveDirectorySelection = () => {
    list.querySelectorAll('.file-explorer-operation-list__item').forEach(item => {
      const isSelected = item.dataset.directoryId === selected;
      item.classList.toggle('is-active', isSelected);
      item.setAttribute('aria-selected', String(isSelected));
    });
  };

  /** 根据搜索文字重新渲染可选目录。 */
  const renderDirectories = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const visibleDirectories = visibleMoveDirectories(directories, expandedDirectories, query);
    const directoryParents = new Set(directories
      .filter(directory => directory.id !== ROOT_DIRECTORY)
      .map(directory => parent(directory.id)));
    const visibleDirectoryParents = new Set(visibleDirectories
      .filter(directory => directory.id !== ROOT_DIRECTORY)
      .map(directory => parent(directory.id)));
    if (!visibleDirectories.some(directory => directory.id === selected && !directory.disabled)) {
      selected = visibleDirectories.find(directory => !directory.disabled)?.id;
      confirm.disabled = !selected;
    }
    list.replaceChildren();
    if (!loading && visibleDirectories.length === 0) {
      const status = document.createElement('p');
      status.className = 'file-explorer-operation-status';
      status.textContent = query ? '没有匹配的目录。' : '没有可用的目标目录。';
      list.append(status);
      scrollArea.sync();
      return;
    }
    for (const directory of visibleDirectories) {
      const item = document.createElement('div');
      const hasChildren = directoryParents.has(directory.id);
      const isExpanded = query
        ? visibleDirectoryParents.has(directory.id)
        : expandedDirectories.has(directory.id);
      const toggle = hasChildren ? document.createElement('button') : document.createElement('span');
      const target = document.createElement('button');
      const label = document.createElement('span');
      item.className = 'file-explorer-operation-list__item';
      item.dataset.directoryId = directory.id;
      item.style.setProperty('--file-explorer-move-depth', String(directory.depth));
      item.setAttribute('role', 'treeitem');
      item.setAttribute('aria-level', String(directory.depth + 1));
      item.setAttribute('aria-selected', String(selected === directory.id));
      if (hasChildren) item.setAttribute('aria-expanded', String(isExpanded));
      item.classList.toggle('is-disabled', Boolean(directory.disabled));
      item.classList.toggle('is-active', selected === directory.id);
      toggle.className = 'file-explorer-operation-list__toggle';
      if (hasChildren) {
        toggle.type = 'button';
        toggle.disabled = Boolean(query);
        toggle.setAttribute('aria-label', isExpanded ? '折叠目录' : '展开目录');
        toggle.append(icon(state, isExpanded ? 'arrow-down' : 'arrow-forward', isExpanded ? '折叠目录' : '展开目录'));
        toggle.addEventListener('click', event => {
          event.stopPropagation();
          if (isExpanded) expandedDirectories.delete(directory.id);
          else expandedDirectories.add(directory.id);
          if (isExpanded && isMoveDirectoryDescendant(selected, directory.id)) {
            selected = directory.disabled ? undefined : directory.id;
            confirm.disabled = !selected;
          }
          renderDirectories();
          search.focus({ preventScroll: true });
        });
      } else {
        toggle.setAttribute('aria-hidden', 'true');
      }
      target.type = 'button';
      target.className = 'file-explorer-operation-list__target';
      target.disabled = Boolean(directory.disabled);
      label.className = 'file-explorer-operation-list__label';
      label.textContent = directory.id === ROOT_DIRECTORY ? '/' : directory.label;
      target.append(icon(state, 'folder', '目录'), label);
      target.addEventListener('click', () => {
        if (directory.disabled) return;
        selected = directory.id;
        confirm.disabled = false;
        updateMoveDirectorySelection();
        search.focus({ preventScroll: true });
      });
      item.append(toggle, target);
      list.append(item);
    }
    scrollArea.sync();
  };

  search.addEventListener('input', renderDirectories);
  cancel.addEventListener('click', () => closeMoveDialog(state));
  confirm.addEventListener('click', async () => {
    if (!selected) return;
    confirm.disabled = true;
    try {
      await moveEntryToDirectory(state, entry, selected);
      closeMoveDialog(state);
    } catch (error) {
      closeMoveDialog(state);
      render(state);
      await notifyOperationError(state, entry.type === 'directory' ? '移动目录' : '移动文件', error);
    }
  });
  overlay.addEventListener('mousedown', event => {
    if (event.target === overlay) closeMoveDialog(state);
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMoveDialog(state);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
    if (event.key === 'Enter' && event.target !== search) return;
    event.preventDefault();
    if (event.key === 'Enter') {
      confirm.click();
      return;
    }
    const query = search.value.trim().toLocaleLowerCase();
    const available = visibleMoveDirectories(directories, expandedDirectories, query)
      .filter(directory => !directory.disabled);
    if (available.length === 0) return;
    const currentIndex = available.findIndex(directory => directory.id === selected);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + offset + available.length) % available.length;
    selected = available[nextIndex].id;
    confirm.disabled = false;
    updateMoveDirectorySelection();
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  });

  actions.append(hints, cancel, confirm);
  dialog.append(title, search, scrollArea.element, actions);
  overlay.append(dialog);
  state.root?.append(overlay);
  state.moveDialog = overlay;
  state.moveDialogCleanup = scrollArea.dispose;
  renderDirectories();
  requestAnimationFrame(() => search.focus());
  void loadMoveDirectories(state).catch(() => undefined);
  void loadMoveDirectories(state).then(result => {
    if (state.moveDialog !== overlay) return;
    directories = resolveMoveTargets(result, entry, currentParent);
    selected = directories.find(directory => !directory.disabled)?.id;
    loading = false;
    confirm.disabled = !selected;
    renderDirectories();
  }).catch(error => {
    if (state.moveDialog !== overlay) return;
    loading = false;
    closeMoveDialog(state);
    render(state);
    void notifyOperationError(state, '读取目标目录', error);
  });
}

/** 在同一目录中创建文件或文件夹副本。 */
async function copyEntry(state, entry) {
  const name = await state.context.dialogs.prompt({
    title: entry.type === 'directory' ? '创建文件夹副本' : '创建文件副本',
    value: entry.name,
    confirmLabel: '复制'
  });
  if (!name || name === entry.name) return;
  const directory = parent(entry.path);
  const destination = directory === ROOT_DIRECTORY ? name : `${directory}/${name}`;
  await state.context.filesystem.copy(entry.path, destination, { recursive: entry.type === 'directory' });
  if (entry.type === 'directory') refreshMoveDirectories(state);
  await refreshDirectory(state, directory);
}

/** 将插件本地剪贴板中的条目复制或移动到目标目录。 */
async function pasteEntry(state, targetDirectory) {
  const clipboardEntry = state.clipboard;
  if (!clipboardEntry) return;
  const destination = targetDirectory === ROOT_DIRECTORY
    ? clipboardEntry.entry.name
    : `${targetDirectory}/${clipboardEntry.entry.name}`;
  if (clipboardEntry.operation === 'move') {
    await state.context.filesystem.move(clipboardEntry.entry.path, destination);
    state.clipboard = undefined;
  } else {
    await state.context.filesystem.copy(clipboardEntry.entry.path, destination, {
      recursive: clipboardEntry.entry.type === 'directory'
    });
  }
  if (clipboardEntry.entry.type === 'directory') refreshMoveDirectories(state);
  await refreshAll(state);
}

/** 使用公开文件系统接口加密或解密文件。 */
async function protectEntry(state, entry, action) {
  const password = await state.context.dialogs.prompt({
    title: action === 'encrypt' ? '加密文件' : '解密文件',
    placeholder: '输入密码',
    confirmLabel: action === 'encrypt' ? '加密' : '解密'
  });
  if (!password) return;
  if (action === 'encrypt') await state.context.filesystem.encrypt(entry.path, password);
  else await state.context.filesystem.decrypt(entry.path, password);
  await refreshDirectory(state, parent(entry.path));
}

/** 返回工作区路径的父目录。 */
function parent(path) {
  const parts = normalizePath(path).split('/');
  parts.pop();
  return parts.length ? parts.join('/') : ROOT_DIRECTORY;
}

/** 为同名移动条目生成最小可用的序号名称。 */
function resolveAvailableEntryName(entry, existingEntries) {
  const existingNames = new Set(existingEntries.map(item => String(item.name || '').toLowerCase()));
  const originalName = String(entry.name || '');
  if (!existingNames.has(originalName.toLowerCase())) return originalName;

  const extensionIndex = entry.type === 'file' ? originalName.lastIndexOf('.') : -1;
  const stem = extensionIndex > 0 ? originalName.slice(0, extensionIndex) : originalName;
  const extension = extensionIndex > 0 ? originalName.slice(extensionIndex) : '';
  let sequence = 1;
  let candidate = `${stem}-${sequence}${extension}`;
  while (existingNames.has(candidate.toLowerCase())) {
    sequence += 1;
    candidate = `${stem}-${sequence}${extension}`;
  }
  return candidate;
}

/** 批量移动独立条目，统一处理同名编号、局部失败、选中状态与目录刷新。 */
async function moveEntriesToDirectory(state, entries, directory) {
  const reducedEntries = reduceNestedEntries(entries);
  if (!canMoveEntriesToDirectory(reducedEntries, directory)) return [];
  const movableEntries = reducedEntries.filter(entry => canMoveEntryToDirectory(entry, directory));
  const existingEntries = [...await state.context.filesystem.listEntries(directory)];
  const operations = movableEntries.map(entry => {
    const name = resolveAvailableEntryName(entry, existingEntries);
    existingEntries.push({ name, type: entry.type });
    return {
      entry,
      sourceDirectory: parent(entry.path),
      destination: directory === ROOT_DIRECTORY ? name : `${directory}/${name}`
    };
  });

  const movedOperations = [];
  let failure;
  for (const operation of operations) {
    try {
      await state.context.filesystem.move(operation.entry.path, operation.destination);
      movedOperations.push(operation);
    } catch (error) {
      failure = error;
      break;
    }
  }

  if (movedOperations.length) {
    const movedDirectories = movedOperations.filter(operation => operation.entry.type === 'directory');
    for (const operation of movedDirectories) discardMovedDirectoryState(state, operation.entry.path);
    if (movedDirectories.length) refreshMoveDirectories(state);
    if (directory !== ROOT_DIRECTORY) state.expanded.add(directory);
    state.selectedPaths.clear();
    for (const operation of movedOperations) state.selectedPaths.add(operation.destination);
    state.selectedPath = movedOperations[0].destination;
    await refreshDirectories(state, [
      ...new Set(movedOperations.map(operation => operation.sourceDirectory)),
      directory
    ]);
  }
  if (failure) throw failure;
  return movedOperations;
}

/** 清理目录移动后仍引用原路径的展开状态与目录缓存。 */
function discardMovedDirectoryState(state, sourcePath) {
  for (const directory of state.expanded) {
    if (directory === sourcePath || directory.startsWith(`${sourcePath}/`)) state.expanded.delete(directory);
  }
  for (const directory of state.entriesByDirectory.keys()) {
    if (directory === sourcePath || directory.startsWith(`${sourcePath}/`)) state.entriesByDirectory.delete(directory);
  }
  const affectedDirectories = [...state.directoryFileCounts.keys()]
    .filter(directory => directory === sourcePath || directory.startsWith(`${sourcePath}/`));
  invalidateDirectoryFileCounts(state, affectedDirectories);
}

/** 批量读取目录，并在全部完成后一次性更新缓存和文件树。 */
async function refreshDirectories(state, directories, replaceCache = false, invalidateCounts = true) {
  const refreshGeneration = state.refreshGeneration + 1;
  state.refreshGeneration = refreshGeneration;
  if (state.directoryRefreshRetryTimer) {
    clearTimeout(state.directoryRefreshRetryTimer);
    state.directoryRefreshRetryTimer = undefined;
  }
  const targets = [...new Set(directories.map(directory => normalizePath(directory)))];
  if (invalidateCounts) invalidateDirectoryFileCounts(state, replaceCache ? undefined : targets);
  state.busy = true;
  state.error = undefined;
  try {
    const results = await Promise.all(targets.map(async target => ({
      target,
      entries: await loadDirectoryEntries(state, target, true)
    })));
    if (refreshGeneration !== state.refreshGeneration) return;
    if (replaceCache) state.entriesByDirectory.clear();
    for (const result of results) state.entriesByDirectory.set(result.target, result.entries);
    state.directoryRefreshRetryAttempt = 0;
  } catch (error) {
    if (refreshGeneration !== state.refreshGeneration) return;
    if (isRateLimitedError(error)) {
      const delay = Math.min(2_000, 250 * (2 ** state.directoryRefreshRetryAttempt));
      state.directoryRefreshRetryAttempt = Math.min(state.directoryRefreshRetryAttempt + 1, 4);
      if (!state.directoryRefreshRetryTimer) {
        state.directoryRefreshRetryTimer = setTimeout(() => {
          state.directoryRefreshRetryTimer = undefined;
          if (refreshGeneration === state.refreshGeneration) {
            void refreshDirectories(state, targets, replaceCache, invalidateCounts);
          }
        }, delay);
      }
    } else {
      state.error = getErrorMessage(error);
    }
  } finally {
    if (refreshGeneration !== state.refreshGeneration) return;
    state.busy = false;
    render(state);
  }
}

/** 重新读取一个目录并保持当前展开状态。 */
async function refreshDirectory(state, directory) {
  await refreshDirectories(state, [directory]);
}

/** 重新读取树根和已展开目录。 */
async function refreshAll(state) {
  const directories = [ROOT_DIRECTORY, ...state.expanded];
  await refreshDirectories(state, directories, true);
}

/** 合并短时间内的目录变化，避免多个 watcher 事件连续重绘文件树。 */
function queueDirectoryRefresh(state, directory) {
  state.directoryRefreshPending.add(directory);
  if (state.directoryRefreshPromise) return state.directoryRefreshPromise;
  const run = async () => {
    while (state.directoryRefreshPending.size > 0) {
      await new Promise(resolve => setTimeout(resolve, DIRECTORY_REFRESH_DEBOUNCE_MS));
      const targets = [...state.directoryRefreshPending];
      state.directoryRefreshPending.clear();
      await refreshDirectories(state, targets, false, true);
    }
  };
  const promise = run().finally(() => {
    if (state.directoryRefreshPromise === promise) state.directoryRefreshPromise = undefined;
  });
  state.directoryRefreshPromise = promise;
  return promise;
}

/** 递归加载并展开全部目录，只在遍历完成后重绘文件树。 */
async function expandAllDirectories(state) {
  if (state.busy) return;
  state.busy = true;
  state.error = undefined;
  const pending = [ROOT_DIRECTORY];
  const visited = new Set();
  try {
    while (pending.length > 0) {
      const directory = pending.shift();
      if (!directory || visited.has(directory)) continue;
      visited.add(directory);
      let entries = state.entriesByDirectory.get(directory);
      if (!entries) {
        entries = filterFileExplorerEntries(await state.context.filesystem.listEntries(directory));
        state.entriesByDirectory.set(directory, entries);
      }
      for (const entry of entries) {
        if (entry.type !== 'directory') continue;
        state.expanded.add(entry.path);
        pending.push(entry.path);
      }
    }
  } catch (error) {
    if (!isRateLimitedError(error)) state.error = getErrorMessage(error);
  } finally {
    state.busy = false;
    state.allExpanded = !state.error && pending.length === 0;
    render(state);
  }
}

/** 折叠全部已展开目录，不重新读取文件系统内容。 */
function collapseAllDirectories(state) {
  if (state.busy) return;
  state.expanded.clear();
  state.allExpanded = false;
  render(state);
}

/** 根据当前全部展开状态刷新唯一的展开/折叠切换按钮。 */
function updateExpandCollapseButton(state) {
  const button = state.toolbar?.querySelector('[data-action="expand-collapse"]');
  if (!button) return;
  button.replaceChildren(state.allExpanded ? collapseAllIcon('全部折叠') : expandAllIcon('全部展开'));
  button.setAttribute('aria-label', state.allExpanded ? '全部折叠' : '全部展开');
}

/** 定位当前编辑器文件并展开其父级目录。 */
async function locateActiveFile(state) {
  try {
    const activeDocument = await state.context.editor.getActiveDocument();
    const activePath = normalizePath(activeDocument?.path);
    if (!activeDocument || !activePath || activePath === ROOT_DIRECTORY) {
      await state.context.notifications.show('当前没有可定位的活动文件。', { type: 'warning' });
      return;
    }
    setSingleSelection(state, activePath);
    const parts = activePath.split('/');
    parts.pop();
    let directory = ROOT_DIRECTORY;
    for (const segment of parts) {
      if (!segment) continue;
      directory = directory === ROOT_DIRECTORY ? segment : `${directory}/${segment}`;
      state.expanded.add(directory);
      await ensureDirectory(state, directory);
    }
    await ensureDirectory(state, ROOT_DIRECTORY);
    render(state);
    state.root?.querySelector(`[data-path="${CSS.escape(activePath)}"]`)?.scrollIntoView({ block: 'center' });
  } catch (error) {
    await notifyOperationError(state, '定位当前文件', error);
  }
}

/** 初始化仓库下拉菜单、工具栏和树容器。 */
function buildView(state) {
  const shell = document.createElement('section');
  shell.className = 'file-explorer';
  shell.addEventListener('pointerleave', () => closeHeaderMenus(state));
  const header = document.createElement('header');
  header.className = 'file-explorer-header';
  const repository = document.createElement('button');
  const repositoryLabel = document.createElement('span');
  const repositoryArrow = icon(state, 'arrow-down', '展开仓库菜单');
  repository.type = 'button';
  repository.className = 'file-explorer-repository';
  repository.setAttribute('aria-haspopup', 'menu');
  repository.setAttribute('aria-expanded', 'false');
  repositoryLabel.className = 'file-explorer-repository__label';
  repositoryArrow.classList.add('file-explorer-repository__arrow');
  repository.append(repositoryLabel, repositoryArrow);
  repository.addEventListener('click', event => {
    event.stopPropagation();
    if (state.repositoryMenu) closeRepositoryMenu(state);
    else openRepositoryMenu(state);
  });
  state.repositoryButton = repository;
  state.repositoryLabel = repositoryLabel;
  const toolbar = document.createElement('div');
  toolbar.className = 'file-explorer-toolbar';
  state.toolbar = toolbar;
  const actions = [
    ['new-file', 'new-file', '新建笔记'],
    ['new-folder', 'new-folder', '新建文件夹'],
    ['locate', 'open-current', '定位当前文件']
  ];
  for (const [id, iconName, label] of actions) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.action = id; button.setAttribute('aria-label', label); button.append(icon(state, iconName, label));
    button.addEventListener('click', () => {
      if (id === 'locate') {
        void locateActiveFile(state);
        return;
      }
      const createDirectory = resolveCreateDirectory(state);
      if (id === 'new-file') void startInlineCreate(state, createDirectory, 'file', '.md');
      if (id === 'new-folder') void startInlineCreate(state, createDirectory, 'directory', '', 'start');
    });
    toolbar.append(button);
  }
  const expandCollapse = document.createElement('button');
  expandCollapse.type = 'button';
  expandCollapse.dataset.action = 'expand-collapse';
  expandCollapse.addEventListener('click', () => {
    if (state.allExpanded) collapseAllDirectories(state);
    else void expandAllDirectories(state);
  });
  toolbar.append(expandCollapse);
  const sort = document.createElement('button');
  sort.type = 'button'; sort.setAttribute('aria-label', '排序'); sort.append(icon(state, 'sort', '排序'));
  sort.addEventListener('click', event => {
    event.stopPropagation();
    openSortMenu(state, sort);
  });
  toolbar.append(sort);
  header.append(repository, toolbar);
  const list = document.createElement('div');
  list.className = 'file-explorer-list ws-no-text-selection';
  list.addEventListener('click', event => {
    if (event.target !== list) return;
    setSingleSelection(state, ROOT_DIRECTORY);
  });
  list.addEventListener('contextmenu', event => {
    if (event.target instanceof Element && event.target.closest('.file-explorer-row')) return;
    openRootContextMenu(state, event);
  });
  state.list = list;
  const status = document.createElement('p'); status.className = 'file-explorer-status'; state.status = status;
  shell.append(header, status, list);
  state.root = shell;
  return shell;
}

/** 刷新仓库选择菜单和当前仓库显示。 */
async function refreshRepository(state, nextRepository) {
  try {
    state.repository = nextRepository || await state.context.workspace.getRepository();
    try {
      state.recentRepositories = [...await state.context.workspace.listRecentRepositories()];
    } catch (error) {
      if (!isRateLimitedError(error)) throw error;
    }
  } catch (error) {
    if (!isRateLimitedError(error)) state.error = getErrorMessage(error);
    renderStatus(state);
    return;
  }
  const currentName = state.repository?.name || '选择仓库';
  state.error = undefined;
  state.repositoryLabel.textContent = currentName;
  state.repositoryButton.setAttribute('aria-label', currentName);
  closeRepositoryMenu(state);
  renderStatus(state);
}

/** 仓库切换时清理所有依赖旧仓库路径的插件本地状态。 */
function resetRepositoryViewState(state) {
  clearFileDragState(state);
  state.entriesByDirectory.clear();
  state.expanded.clear();
  state.allExpanded = false;
  state.selectedPaths.clear();
  state.selectedPath = undefined;
  state.clipboard = undefined;
  state.creating = undefined;
  state.createRow = undefined;
  state.newFile = false;
  state.renaming = undefined;
  state.error = undefined;
  state.refreshGeneration += 1;
  state.directoryRefreshPending.clear();
  invalidateDirectoryFileCounts(state);
  closeTransientMenus(state);
}

/** 挂载文件列表插件视图。 */
export async function mountView(context) {
  const state = createState(context);
  await restoreSortPreferences(state);
  await restoreDisplayPreferences(state);
  const handleWindowBlur = () => {
    clearFileDragState(state);
    closeTransientMenus(state);
    state.newFile = false;
  };
  const handleDocumentPointerMove = event => handleFilePointerMove(state, event);
  const handleDocumentPointerUp = event => handleFilePointerUp(state, event);
  const handleDocumentPointerCancel = event => handleFilePointerCancel(state, event);
  const handleDocumentPointerDown = event => handleInlineCreatePointerDown(state, event);
  const handleDocumentClick = event => {
    if (performance.now() < state.suppressClickUntil) {
      state.suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const handleDocumentContextMenu = () => closeMenuSurfaces(state);
  const handleDocumentKeydown = event => {
    if (event.key !== 'Escape') return;
    clearFileDragState(state);
    closeTransientMenus(state);
  };
  context.view.root.replaceChildren();
  context.view.root.append(buildView(state));
  state.root.addEventListener('pointerdown', handleDocumentPointerDown, true);
  window.addEventListener('blur', handleWindowBlur);
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('pointermove', handleDocumentPointerMove, true);
  document.addEventListener('pointerup', handleDocumentPointerUp, true);
  document.addEventListener('pointercancel', handleDocumentPointerCancel, true);
  document.addEventListener('click', handleDocumentClick, true);
  document.addEventListener('contextmenu', handleDocumentContextMenu, true);
  document.addEventListener('keydown', handleDocumentKeydown);
  context.subscriptions.add({
    dispose: () => {
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('pointermove', handleDocumentPointerMove, true);
      document.removeEventListener('pointerup', handleDocumentPointerUp, true);
      document.removeEventListener('pointercancel', handleDocumentPointerCancel, true);
      document.removeEventListener('click', handleDocumentClick, true);
      document.removeEventListener('contextmenu', handleDocumentContextMenu, true);
      document.removeEventListener('keydown', handleDocumentKeydown);
      state.root?.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      clearFileDragState(state);
      closeTransientMenus(state);
      for (const timer of state.directoryFileCountRetryTimers.values()) clearTimeout(timer);
      state.directoryFileCountRetryTimers.clear();
      state.directoryFileCountRetryAttempts.clear();
    }
  });
  context.subscriptions.add(context.workspace.onDidChange(repository => {
    state.repositorySwitchGeneration += 1;
    state.pendingRepository = repository;
    if (state.repositorySwitchPromise) return;
    const run = async () => {
      while (state.pendingRepository) {
        const nextRepository = state.pendingRepository;
        state.pendingRepository = undefined;
        state.repositorySwitchDepth += 1;
        resetRepositoryViewState(state);
        refreshMoveDirectories(state);
        try {
          await refreshRepository(state, nextRepository);
          await refreshAll(state);
        } finally {
          state.repositorySwitchDepth = Math.max(0, state.repositorySwitchDepth - 1);
        }
      }
    };
    const promise = run().finally(() => {
      if (state.repositorySwitchPromise === promise) state.repositorySwitchPromise = undefined;
    });
    state.repositorySwitchPromise = promise;
  }));
  context.subscriptions.add(context.workspace.onDidChangeDirectory(event => {
    if (state.repositorySwitchDepth > 0
      || event?.repositoryId !== state.repository?.id) return;
    const directory = normalizePath(event.parentId || ROOT_DIRECTORY);
    const shouldRefreshEntries = directory === ROOT_DIRECTORY
      || state.expanded.has(directory);
    if (shouldRefreshEntries) {
      void queueDirectoryRefresh(state, directory);
    } else {
      invalidateDirectoryFileCounts(state, [directory]);
      const directoriesToRefresh = new Set();
      if (state.directoryFileCountElements.has(directory)) directoriesToRefresh.add(directory);
      for (const ancestor of state.expanded) {
        if (ancestor === ROOT_DIRECTORY || directory.startsWith(`${ancestor}/`)) directoriesToRefresh.add(ancestor);
      }
      for (const target of directoriesToRefresh) ensureDirectoryFileCount(state, target);
    }
  }));
  context.settings.onDidChangePage(FILE_EXPLORER_SETTINGS_ID, event => {
    applyDisplayPreference(state, event.fieldId, event.value);
    render(state);
  });
  await refreshRepository(state);
  await loadDirectory(state, ROOT_DIRECTORY);
}

/** 激活文件列表插件并注册打开命令。 */
export function activate(context) {
  context.subscriptions.add(context.commands.register('com.wstudio.file-explorer.open', async () => {
    await context.workspace.openRepository();
    await context.workspace.openView('com.wstudio.file-explorer.files');
  }));
}
