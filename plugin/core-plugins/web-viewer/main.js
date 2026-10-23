/** 文件说明：网页浏览器插件入口，负责在通用插件视图中渲染导航栏。 */

const DEFAULT_HOME = 'https://www.baidu.com/';
const SETTINGS_PAGE_ID = 'com.wstudio.web-viewer.settings';
const HOME_FIELD_ID = 'com.wstudio.web-viewer.home';
const SEARCH_FIELD_ID = 'com.wstudio.web-viewer.search';
const CUSTOM_SEARCH_FIELD_ID = 'com.wstudio.web-viewer.custom-search';
const SEARCH_URLS = {
  duckduckgo: 'https://duckduckgo.com/?q={query}',
  google: 'https://www.google.com/search?q={query}',
  baidu: 'https://www.baidu.com/s?wd={query}',
  bing: 'https://www.bing.com/search?q={query}'
};

/** 返回由宿主统一渲染、校验和持久化的网页查看器设置定义。 */
function getSettingDefinitions() {
  return [
    {
      type: 'group',
      id: 'com.wstudio.web-viewer.startup-group',
      title: '启动',
      items: [
        {
          id: HOME_FIELD_ID,
          label: '默认主页',
          description: '新建网页视图时优先打开的地址。',
          type: 'text',
          defaultValue: DEFAULT_HOME,
          validate: [
            { type: 'required', message: '默认主页不能为空。' }
          ]
        }
      ]
    },
    {
      type: 'group',
      id: 'com.wstudio.web-viewer.search-group',
      title: '搜索',
      items: [
        {
          id: SEARCH_FIELD_ID,
          label: '搜索引擎',
          type: 'select',
          defaultValue: 'bing',
          options: [
            { label: 'DuckDuckGo', value: 'duckduckgo' },
            { label: 'Google', value: 'google' },
            { label: '百度', value: 'baidu' },
            { label: 'Bing', value: 'bing' },
            { label: '自定义', value: 'custom' }
          ]
        },
        {
          id: CUSTOM_SEARCH_FIELD_ID,
          label: '自定义搜索地址',
          description: '使用 {query} 作为搜索词占位符。',
          type: 'text',
          defaultValue: '',
          visible: { fieldId: SEARCH_FIELD_ID, operator: 'equals', value: 'custom' },
          validate: [
            { type: 'required', message: '自定义搜索地址不能为空。' },
            { type: 'pattern', value: '\\{query\\}', message: '搜索地址必须包含 {query} 占位符。' }
          ]
        }
      ]
    }
  ];
}

/** 激活网页浏览器插件并注册命令与设置页。 */
export function activate(context) {
  const registration = context.settings.registerPage({
    id: SETTINGS_PAGE_ID,
    title: '网页浏览器',
    getSettingDefinitions
  });
  void registration.ready.catch(error => {
    context.logger.error('网页查看器设置页注册失败。', {
      reason: error instanceof Error ? error.message : String(error)
    });
  });
  context.subscriptions.add(context.commands.register('com.wstudio.web-viewer.open', () => context.workspace.openView('com.wstudio.web-viewer.browser')));
  context.subscriptions.add(context.commands.register('com.wstudio.web-viewer.new-tab', () => context.workspace.openView('com.wstudio.web-viewer.browser', { instanceId: crypto.randomUUID() })));
}

function normalizeAddress(value, searchTemplate) {
  const input = String(value || '').trim();
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[\w-]+(?:\.[\w-]+)+(?:[/:?#].*)?$/i.test(input)) return 'https://' + input;
  return (searchTemplate || SEARCH_URLS.bing).replace('{query}', encodeURIComponent(input));
}

function button(label, action, icon) {
  const element = document.createElement('button');
  element.type = 'button';
  element.setAttribute('aria-label', label);
  if (icon) element.innerHTML = icon;
  element.addEventListener('click', action);
  return element;
}

/** 挂载网页查看器视图并绑定公开 WebViewerApi。 */
export async function mountView(context) {
  const root = context.view.root;
  root.replaceChildren();
  const toolbar = document.createElement('div');
  toolbar.className = 'web-viewer-toolbar';
  const content = document.createElement('div');
  content.className = 'web-viewer-content';
  const progress = document.createElement('div');
  progress.className = 'web-viewer-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', '网页正在加载');
  progress.hidden = true;
  const address = document.createElement('input');
  address.type = 'text';
  address.autocomplete = 'off';
  address.autocapitalize = 'off';
  address.spellcheck = false;
  address.className = 'web-viewer-address';
  let search = 'bing';
  let custom = '';
  let home = DEFAULT_HOME;
  let searchTemplate = SEARCH_URLS.bing;

  /** 根据当前搜索设置刷新地址栏使用的查询模板。 */
  const refreshSearchTemplate = () => {
    searchTemplate = search === 'custom'
      ? custom || SEARCH_URLS.bing
      : SEARCH_URLS[search] || SEARCH_URLS.bing;
  };

  /** 将宿主持久化的任意页面字段变化应用到当前视图。 */
  const applySettingChange = event => {
    if (event.fieldId === HOME_FIELD_ID && typeof event.value === 'string') home = event.value || DEFAULT_HOME;
    if (event.fieldId === SEARCH_FIELD_ID && typeof event.value === 'string') search = event.value;
    if (event.fieldId === CUSTOM_SEARCH_FIELD_ID && typeof event.value === 'string') custom = event.value;
    refreshSearchTemplate();
  };

  context.settings.onDidChangePage(SETTINGS_PAGE_ID, applySettingChange);
  const [storedSearch, storedCustom, storedHome] = await Promise.all([
    context.settings.get(SEARCH_FIELD_ID),
    context.settings.get(CUSTOM_SEARCH_FIELD_ID),
    context.settings.get(HOME_FIELD_ID)
  ]);
  if (typeof storedSearch === 'string') search = storedSearch;
  if (typeof storedCustom === 'string') custom = storedCustom;
  if (typeof storedHome === 'string' && storedHome) home = storedHome;
  refreshSearchTemplate();
  let active;
  let tabs = await context.webViewer.list();
  let lastUrl = context.view.initialUrl || home;
  let failed = false;
  let opening = false;
  let disposed = false;
  context.subscriptions.add({ dispose: () => { disposed = true; } });

  const sync = nextTabs => {
    if (disposed) return;
    tabs = nextTabs;
    active = tabs.find(tab => tab.active);
    if (active) lastUrl = active.url;
    address.value = active?.url || lastUrl;
    back.disabled = !active?.canGoBack;
    forward.disabled = !active?.canGoForward;
    reload.disabled = opening || Boolean(active?.loading) || (!active && !failed);
    progress.hidden = !(opening || active?.loading);
    root.setAttribute('aria-busy', String(!progress.hidden));
  };
  const activeHandle = () => active ? context.webViewer.get(active.id) : undefined;
  /** 故障后只在用户操作时重建；沿用宿主缓存区域，不进行自动重启循环。 */
  const open = async url => {
    if (opening || disposed) return;
    opening = true;
    sync(tabs);
    try {
      await context.webViewer.open({ url });
      const nextTabs = await context.webViewer.list();
      if (disposed) return;
      failed = !nextTabs.some(tab => tab.active);
      if (!failed) content.textContent = '';
      sync(nextTabs);
      await updateBounds();
    } finally {
      opening = false;
      sync(tabs);
    }
  };
  const navigateTo = async url => {
    if (opening || disposed) return;
    if (active) await activeHandle()?.navigate(url);
    else await open(url);
  };
  /** DOM 事件中的异步错误由插件自身处理，保留刷新重试入口。 */
  const run = async action => {
    if (disposed) return;
    try { await action(); }
    catch (error) {
      if (disposed) return;
      content.textContent = '网页操作失败，请重试。';
      context.logger.error('网页操作失败。', { reason: error instanceof Error ? error.message : String(error) });
    }
  };
  const navigate = () => run(async () => {
    if (address.value.trim()) await navigateTo(normalizeAddress(address.value, searchTemplate));
  });
  const back = button('后退', () => run(() => activeHandle()?.back()), '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>');
  const forward = button('前进', () => run(() => activeHandle()?.forward()), '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>');
  const reload = button('刷新', () => run(() => active ? activeHandle()?.reload() : open(lastUrl)), '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>');
  const homeButton = button('首页', () => run(() => navigateTo(normalizeAddress(home, searchTemplate))), '<svg viewBox="0 0 24 24"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="m3 10 8-7 10 7"/></svg>');
  address.addEventListener('keydown', event => { if (event.key === 'Enter') void navigate(); });
  toolbar.append(back, forward, reload, homeButton, address);
  root.append(toolbar, progress, content);
  /** 使用内容区真实矩形，避免停靠移动或样式重新生效时沿用旧工具栏高度。 */
  const updateBounds = async () => {
    if (disposed) return;
    const rootBounds = root.getBoundingClientRect();
    const contentBounds = content.getBoundingClientRect();
    // 隐藏期间由宿主管理原生可见性，不缓存零高度工具栏导致恢复后覆盖地址栏。
    if (rootBounds.width <= 0 || rootBounds.height <= 0
      || contentBounds.width <= 0 || contentBounds.height <= 0) return;
    await context.view.setWebViewerBounds({
      x: contentBounds.left - rootBounds.left,
      y: contentBounds.top - rootBounds.top,
      width: contentBounds.width,
      height: contentBounds.height
    });
  };
  const onResize = () => {
    void updateBounds().catch(error => {
      if (!disposed) context.logger.error('网页区域同步失败。', {
        reason: error instanceof Error ? error.message : String(error)
      });
    });
  };
  // Shadow DOM 样式加载可能只改变内部区域，整个面板的 ResizeObserver 不会触发。
  const contentObserver = new ResizeObserver(onResize);
  contentObserver.observe(content);
  context.subscriptions.add({ dispose: () => contentObserver.disconnect() });
  context.subscriptions.add(context.view.onDidResize(onResize));
  context.subscriptions.add(context.webViewer.onDidChange(sync));
  context.subscriptions.add(context.webViewer.onDidFail(failure => {
    if (disposed || (active && active.id !== failure.tabId)) return;
    failed = true;
    lastUrl = failure.url || lastUrl;
    content.textContent = '网页进程已退出，点击刷新重新加载。';
    sync(tabs.filter(tab => tab.id !== failure.tabId));
  }));
  sync(tabs);
  if (!active && !failed) await open(context.view.initialUrl || home);
  await updateBounds();
}
