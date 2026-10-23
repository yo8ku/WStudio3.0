/** 文件说明：回归验证 Tauri 事件释放竞态与 RPC 传输契约，不启动桌面宿主。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));

/** Run the real LoginDialog script with controlled native promises and lifecycle hooks. */
function loginDialogFixture(api, fixtureProps = {}) {
  const vue = require('vue');
  let unmount, watchOpen;
  const emitted = [];
  const props = { modelValue: true, ...fixtureProps };
  const source = readFileSync(new URL('../components/LoginDialog/LoginDialog.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const script = ts.transpileModule(source + '\nexport { beginGoogle, beginGithub, loginState, loginMessage };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(script, {
    exports, console,
    defineProps: () => props,
    defineEmits: () => (event, value) => emitted.push([event, value]),
    require: name => name === 'vue' ? { ...vue, onBeforeUnmount: fn => { unmount = fn; }, watch: (_source, fn) => { watchOpen = fn; } }
      : name === '@/login/api' ? { loginApi: api }
      : name === '@/store/account' ? { useAccountStore: () => ({ accept: () => {} }) } : {},
  });
  return {
    ...exports,
    emitted,
    unmount: () => unmount(),
    open: () => watchOpen(true, false),
    changeOpen: (open, wasOpen) => watchOpen(open, wasOpen)
  };
}

test('登录交换完成并保存凭据后关闭弹窗，等待和失败时保持打开', async () => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const dialog = loginDialogFixture({ beginGoogle: async () => ({ attemptId: 'attempt' }), wait: () => wait });
  const pending = dialog.beginGoogle();
  await flush();
  assert.equal(dialog.loginState.value, 'waiting');
  assert.deepEqual(dialog.emitted, []);
  finish({ provider: 'google', syncStatus: 'synced' });
  await pending;
  assert.equal(dialog.loginState.value, 'success');
  assert.deepEqual(dialog.emitted, [['update:modelValue', false]]);

  const failed = loginDialogFixture({ beginGoogle: async () => { throw new Error('LOGIN_SERVER_REQUEST_FAILED'); } });
  await failed.beginGoogle();
  assert.equal(failed.loginState.value, 'error');
  assert.deepEqual(failed.emitted, []);
});

test('GitHub 登录按钮使用 GitHub 原生授权流程', async () => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const dialog = loginDialogFixture({ beginGithub: async () => ({ attemptId: 'github-attempt' }), wait: () => wait });
  const pending = dialog.beginGithub();
  await flush();
  assert.equal(dialog.loginState.value, 'waiting');
  finish({ provider: 'github', syncStatus: 'synced' });
  await pending;
  assert.equal(dialog.loginState.value, 'success');
});

test('登录提供商仅禁用 Apple，GitHub 不带禁用属性', () => {
  const source = readFileSync(new URL('../components/LoginDialog/LoginDialog.vue', import.meta.url), 'utf8');
  assert.match(source, /id: 'github',[\s\S]*label: '使用 GitHub 继续'/);
  assert.match(source, /unavailable: true/);
  assert.match(source, /:disabled="isProviderDisabled\(provider\)"/);
  assert.doesNotMatch(source, /provider\.id === 'apple' \|\| loginState === 'waiting'/);
});

test('恢复已验证登录时关闭弹窗', async () => {
  const dialog = loginDialogFixture({ getReceipt: async () => ({ provider: 'google', syncStatus: 'synced' }) });
  dialog.open();
  await flush();
  assert.deepEqual(dialog.emitted, [['update:modelValue', false]]);
});

test('追加账号登录不会因已有会话自动关闭弹窗', async () => {
  const dialog = loginDialogFixture(
    { getReceipt: async () => ({ provider: 'google', syncStatus: 'synced' }) },
    { restoreExisting: false }
  );
  dialog.open();
  await flush();
  assert.deepEqual(dialog.emitted, []);
});

test('登录弹窗卸载时取消迟到的授权准备结果，不交换后台会话', async () => {
  let resolve;
  const begin = new Promise(done => { resolve = done; });
  const cancelled = [];
  let waits = 0;
  const dialog = loginDialogFixture({ beginGoogle: () => begin, cancel: async id => cancelled.push(id), wait: async () => { waits++; } });
  const pending = dialog.beginGoogle();
  dialog.unmount();
  resolve({ attemptId: 'late', expiresAt: 9999 });
  await pending;
  assert.deepEqual(cancelled, ['late']);
  assert.equal(waits, 0);
});

test('登录弹窗关闭按钮直接取消原生授权等待', () => {
  const source = readFileSync(new URL('../components/LoginDialog/LoginDialog.vue', import.meta.url), 'utf8');
  assert.match(source, /<WsDialog[\s\S]*@close="cancelActiveAttempt"/);
});

test('关闭登录弹窗后再次打开会重置等待状态', async () => {
  const cancelled = [];
  const dialog = loginDialogFixture({
    beginGoogle: async () => ({ attemptId: 'attempt' }),
    wait: () => new Promise(() => {}),
    cancel: async id => cancelled.push(id)
  }, { restoreExisting: false });
  void dialog.beginGoogle();
  await flush();
  assert.equal(dialog.loginState.value, 'waiting');
  dialog.changeOpen(false, true);
  dialog.changeOpen(true, false);
  assert.equal(dialog.loginState.value, 'idle');
  assert.equal(dialog.loginMessage.value, '');
  assert.deepEqual(cancelled, ['attempt']);
});

test('工具提示支持四向箭头并跟随 Vuetify 最终定位方向', () => {
  const source = readFileSync(new URL('../components/WsTooltip/WsTooltip.vue', import.meta.url), 'utf8');
  for (const location of ['top', 'bottom', 'left', 'right']) {
    assert.match(source, new RegExp(`ws-tooltip--${location}::before`));
    assert.match(source, new RegExp(`anchor-origin: ${location}`));
  }
  assert.match(source, /border-color:\s*transparent/);
});

test('账号菜单移除首选项入口并打开账号面板', () => {
  const source = readFileSync(new URL('../components/AccountButton/AccountButton.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /管理账户首选项/);
  assert.match(source, /import AccountPanel from '@\/components\/AccountPanel\/AccountPanel\.vue'/);
  assert.match(source, /function openAccountPanel\(accountHash: string\)/);
  assert.match(source, /function switchAccount\(accountHash: string, event: MouseEvent\)/);
  assert.match(source, /@click="switchAccount\(account\.accountHash, \$event\)"/);
  assert.match(source, /v-if="accountPanelOpen"/);
  assert.match(source, /title="登录其他账号"/);
  assert.match(source, /@back="accountPanelOpen = false"/);
});

test('账号面板显示账号信息并提供退出确认', () => {
  const source = readFileSync(new URL('../components/AccountPanel/AccountPanel.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /WsDialog/);
  assert.match(source, /class="account-panel"/);
  assert.match(source, /icon="icon icon-arrow-back"/);
  assert.match(source, /icon="icon icon-sign-out"/);
  assert.match(source, /aria-label="退出登录确认"/);
  assert.match(source, /accountStore\.logout\(current\.accountHash\)/);
  assert.match(source, /移除本机保存的该账号会话/);
});

test('Google 授权回调页提供合法 deep-link 的自动跳转和手动链接', () => {
  const source = readFileSync(new URL('../../public/oauth/google-callback.html', import.meta.url), 'utf8');
  assert.match(source, /启动 WStudio/);
  assert.match(source, /您将在稍后被重定向/);
  assert.match(source, /请在浏览器中打开此链接/);
  assert.match(source, /url\.protocol !== 'wstudio:'/);
  assert.match(source, /url\.hostname !== 'auth'/);
  assert.match(source, /window\.location\.replace\(redirect\)/);
});

test('登录弹窗恢复后端会话，迟到恢复结果不覆盖新的授权等待状态', async () => {
  let restore;
  const receipt = new Promise(resolve => { restore = resolve; });
  const dialog = loginDialogFixture({ getReceipt: () => receipt, beginGoogle: () => new Promise(() => {}) });
  dialog.open();
  void dialog.beginGoogle();
  restore({ provider: 'google', syncStatus: 'synced' });
  await flush();
  assert.equal(dialog.loginState.value, 'waiting');
  const restored = loginDialogFixture({ getReceipt: async () => ({ provider: 'google', syncStatus: 'synced' }) });
  restored.open();
  await flush();
  assert.equal(restored.loginState.value, 'success');
});

test('没有旧偏好时启动迁移不查询宿主，已有偏好不被旧值覆盖', async () => {
  const calls = [];
  const values = new Map([['existing', 'legacy'], ['new', 'legacy-new']]);
  const { migrateLegacyAppSettings } = load('./appSettings.ts', {
    './native': { isTauriRuntime: () => true, nativeApi: { appSettings: {
      get: async key => { calls.push(['get', key]); return key === 'existing' ? 'current' : null; },
      set: async (key, value) => calls.push(['set', key, value])
    } } }
  }, { window: { localStorage: {
    getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key)
  } } });
  await migrateLegacyAppSettings(['missing', 'existing', 'new']);
  assert.deepEqual(calls, [['get', 'existing'], ['get', 'new'], ['set', 'new', 'legacy-new']]);
  assert.equal(values.size, 0);
});

test('启动预加载与主题就绪后挂载，慢速属性和快捷键读取不阻塞首屏', async () => {
  const events = [];
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const migration = deferred();
  const view = deferred();
  const theme = deferred();
  const properties = deferred();
  const shortcuts = deferred();
  const app = { use: () => {}, component: () => {}, mount: () => events.push('mount') };
  load('../main.ts', {
    pinia: { createPinia: () => ({}) },
    vue: { createApp: () => app, defineCustomElement: () => ({}) },
    './App.vue': { default: {} },
    './assets/iconfont/style.css': {},
    './assets/styles/main.scss': {},
    './iconfont/index.scss': {},
    './plugins/vuetify': { vuetify: {} },
    './views/windowView': { loadWindowView: () => { events.push('view'); return view.promise; } },
    './api/appSettings': { migrateLegacyAppSettings: () => { events.push('migration'); return migration.promise; } },
    './types/appSettings': { APP_SETTING_KEYS: {} },
    './store/theme': { useThemeStore: () => ({ initializeThemeSystem: () => { events.push('theme'); return theme.promise; } }) },
    './store/notePropertyTypes': { useNotePropertyTypesStore: () => ({ initialize: () => { events.push('properties'); return properties.promise; } }) },
    './store/shortcuts': { useShortcutStore: () => ({ initialize: () => { events.push('shortcuts'); return shortcuts.promise; } }) },
    '../plugin/runtime/icons': { registerPluginIconSources: () => {} },
    './components/WsDropdownMenu/WsDropdownMenu.vue': { default: {} },
    'virtual:ws-svg-icons': { default: {} }
  }, { customElements: { get: () => true }, console });
  assert.deepEqual(events, ['view', 'migration']);
  migration.resolve();
  await flush();
  assert.deepEqual(events, ['view', 'migration', 'theme']);
  theme.resolve();
  view.resolve({ default: {} });
  await flush();
  assert.deepEqual(events, ['view', 'migration', 'theme', 'mount', 'properties', 'shortcuts']);
  properties.resolve();
  shortcuts.resolve();
  await flush();
});

test('拆分插件标签创建独立视图实例，移动和关闭副本保留原实例', () => {
  const definitions = load('../DockingThree/definitions.ts');
  const tree = load('../DockingThree/tree.ts', { '@/DockingThree/definitions': definitions });
  const store = load('../store/dockingThree.ts', {
    vue: require('vue'),
    pinia: { defineStore: (_name, setup) => setup },
    '@/DockingThree/definitions': definitions,
    '@/DockingThree/tree': tree,
    '@/utils/documentTypeLabel': { resolveDocumentTypeLabel: () => '' },
    '@/utils/windowMode': { getWindowMode: () => 'tab' },
    '@/api/native': { nativeApi: { workspace: { recordClosedTab: async () => undefined } } },
    '@editor/InlineChat/inlineChatLifecycle': { closeInlineChat: () => undefined }
  }).useDockingThreeStore();
  const view = { type: 'com.example.browser.view', title: 'Browser', multiple: true, region: 'editor',
    capabilities: ['webViewer'], iconUrl: 'browser.svg' };
  store.openPluginView('com.example.browser', view, undefined, 'https://example.com/');
  const originalGroup = tree.findFirstEditorGroup(store.root.value);
  const original = originalGroup.tabs.find(tab => tab.kind === 'plugin');
  assert.equal(typeof store.updateWebViewerTabMetadata, 'function', 'webpage metadata has a dedicated Store action');
  store.updateWebViewerTabMetadata('com.example.browser', {
    instanceId: original.viewInstanceId, viewType: view.type,
    title: '百度一下，你就知道', url: 'https://www.baidu.com/', faviconUrl: 'https://www.baidu.com/favicon.ico'
  });
  store.splitTab(originalGroup.id, original.id, 'bottom', false);
  const groups = node => node.type === 'group' ? [node] : node.children.flatMap(groups);
  const pluginTabs = () => groups(store.root.value).flatMap(group => group.tabs.filter(tab => tab.kind === 'plugin').map(tab => ({ group, tab })));
  let tabs = pluginTabs();
  assert.equal(tabs.length, 2);
  const duplicate = tabs.find(({ tab }) => tab.id !== original.id);
  assert.notEqual(duplicate.tab.viewInstanceId, original.viewInstanceId);
  assert.equal(duplicate.tab.viewInitialUrl, original.viewInitialUrl);
  assert.equal(duplicate.tab.pluginId, original.pluginId);
  assert.equal(duplicate.tab.title, '百度一下，你就知道');
  assert.equal(duplicate.tab.webViewerFaviconUrl, 'https://www.baidu.com/favicon.ico');
  store.updateWebViewerTabMetadata('com.other.browser', {
    instanceId: duplicate.tab.viewInstanceId, viewType: view.type, title: 'Wrong plugin', url: 'https://example.com/'
  });
  store.updateWebViewerTabMetadata('com.example.browser', {
    instanceId: duplicate.tab.viewInstanceId, viewType: 'other-view', title: 'Wrong view', url: 'https://example.com/'
  });
  assert.equal(pluginTabs()[1].tab.title, '百度一下，你就知道');
  store.updateWebViewerTabMetadata('com.example.browser', {
    instanceId: duplicate.tab.viewInstanceId, viewType: view.type,
    title: '抖音精选电脑版', url: 'https://www.douyin.com/', faviconUrl: 'https://www.douyin.com/favicon.ico'
  });
  store.splitTab(duplicate.group.id, duplicate.tab.id, 'right', true);
  tabs = pluginTabs();
  assert.equal(tabs.length, 2);
  const moved = tabs.find(({ tab }) => tab.id === duplicate.tab.id);
  assert.equal(moved.tab.viewInstanceId, duplicate.tab.viewInstanceId);
  assert.equal(moved.tab.title, '抖音精选电脑版');
  assert.equal(moved.tab.webViewerFaviconUrl, 'https://www.douyin.com/favicon.ico');
  assert.equal(tabs.find(({ tab }) => tab.id === original.id).tab.title, '百度一下，你就知道');
  store.updateWebViewerTabMetadata('com.example.browser', {
    instanceId: duplicate.tab.viewInstanceId, viewType: view.type,
    title: ' ', url: 'https://example.org/', faviconUrl: 'javascript:alert(1)'
  });
  assert.equal(pluginTabs().find(({ tab }) => tab.id === duplicate.tab.id).tab.title, 'example.org');
  assert.equal(pluginTabs().find(({ tab }) => tab.id === duplicate.tab.id).tab.webViewerFaviconUrl, undefined);
  store.closePluginView('com.example.browser', view.type, duplicate.tab.viewInstanceId);
  assert.equal(pluginTabs().length, 1);
  assert.equal(pluginTabs()[0].tab.viewInstanceId, original.viewInstanceId);
  store.openPluginView('com.example.browser', view);
  assert.notEqual(pluginTabs()[1].tab.viewInstanceId, original.viewInstanceId);
});

test('关闭活动标签页时按左侧相邻标签回退激活', () => {
  const definitions = load('../DockingThree/definitions.ts');
  const tree = load('../DockingThree/tree.ts', { '@/DockingThree/definitions': definitions });
  const tabs = ['1', '2', '3', '4', '5'].map(id => ({
    id,
    title: `标签页${id}`,
    kind: 'editor',
    label: `标签页${id}`,
    closable: true
  }));
  let root = {
    id: 'editor-group',
    type: 'group',
    role: 'editor',
    header: 'tabs',
    tabs,
    activeTabId: '5'
  };

  for (const expectedActiveId of ['4', '3', '2', '1']) {
    const closingTabId = root.activeTabId;
    root = tree.removeTabFromGroup(root, root.id, closingTabId);
    assert.equal(root.activeTabId, expectedActiveId);
  }
});

test('关闭活动标签页时回退到同一停靠分组上一次激活的标签', () => {
  const definitions = load('../DockingThree/definitions.ts');
  const tree = load('../DockingThree/tree.ts', { '@/DockingThree/definitions': definitions });
  const store = load('../store/dockingThree.ts', {
    vue: require('vue'),
    pinia: { defineStore: (_name, setup) => setup },
    '@/DockingThree/definitions': definitions,
    '@/DockingThree/tree': tree,
    '@/utils/documentTypeLabel': { resolveDocumentTypeLabel: () => '' },
    '@/utils/windowMode': { getWindowMode: () => 'tab' },
    '@/api/native': { nativeApi: { workspace: { recordClosedTab: async () => undefined } } },
    '@editor/InlineChat/inlineChatLifecycle': { closeInlineChat: () => undefined }
  }).useDockingThreeStore();
  const group = tree.findFirstEditorGroup(store.root.value);
  const firstTabId = group.activeTabId;

  store.createEditorTabInGroup(group.id);
  const secondTabId = tree.findGroupById(store.root.value, group.id).activeTabId;
  store.setActiveTab(group.id, firstTabId);
  store.setActiveTab(group.id, secondTabId);
  store.closeTab(group.id, secondTabId);

  assert.equal(tree.findGroupById(store.root.value, group.id).activeTabId, firstTabId);
});

test('Rust 窗口释放事件刷新摘要，保留其他窗口的插件实例和运行时', async () => {
  const handlers = new Map();
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async () => undefined },
    '@tauri-apps/plugin-dialog': { open: async () => undefined },
    './nativeEvents': { subscribeNativeEvent: (name, callback) => {
      handlers.set(name, callback);
      return () => handlers.delete(name);
    } }
  }).nativeApi;
  const operations = [];
  const contribution = { pluginId: 'com.example.windows', runtimeId: 'current-runtime', entryUrl: 'main.js', views: [] };
  const plugin = load('plugin.ts', {
    './native': { nativeApi: native, isTauriRuntime: () => true },
    './nativePlugin': { nativePluginApi: {} },
    './electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron fallback.') }
  }).pluginApi;
  const store = load('../store/plugin.ts', {
    vue: require('vue'),
    pinia: { defineStore: (_name, setup) => setup },
    '@/api/plugin': { pluginApi: {
      ...plugin,
      list: async () => {
        operations.push('refresh');
        return [{ id: contribution.pluginId, enabled: true }];
      },
      listContributions: async () => [contribution],
      onSettingChanged: () => () => undefined,
      onContributionsChanged: () => () => undefined,
      onViewOpenRequested: () => () => undefined,
      onViewCloseRequested: () => () => undefined,
      onWebViewerChanged: callback => {
        handlers.set('plugin:webViewerChanged', callback);
        return () => handlers.delete('plugin:webViewerChanged');
      }
    } },
    '@/store/dockingThree': { useDockingThreeStore: () => ({
      closePluginViews: () => operations.push('close-views'),
      openPluginView: () => operations.push('open-view'),
      updateWebViewerTabMetadata: (pluginId, tab) => operations.push({ pluginId, tab })
    }) },
    '../../plugin/runtime/rendererRuntime': {
      ensurePluginActivated: async () => operations.push('activate'),
      deactivatePlugin: async () => operations.push('deactivate'),
      deactivateAllPlugins: async () => undefined
    }
  }).usePluginStore();
  store.initialize();
  // Exercise the actual Rust cleanup event through the native bridge and live Store handlers.
  const rust = readFileSync(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const cleanup = rust.slice(rust.indexOf('fn dispose_renderer_resources('), rust.indexOf('pub fn run()'));
  const eventName = /app\.emit\(\s*"([^"]+)"/.exec(cleanup)?.[1];
  assert.ok(handlers.has(eventName), 'Window cleanup must emit a subscribed status event.');
  handlers.get(eventName)({ pluginId: contribution.pluginId });
  await flush();
  assert.deepEqual(operations, ['refresh']);
  store.contributions.value = [contribution];
  operations.length = 0;
  const page = { instanceId: 'browser-instance', viewType: 'browser', title: 'Current webpage',
    url: 'https://example.com/', faviconUrl: 'https://example.com/favicon.ico' };
  const webpageEvent = { pluginId: contribution.pluginId, runtimeId: contribution.runtimeId, tabs: [page] };
  const syncMetadata = handlers.get('plugin:webViewerChanged');
  syncMetadata({ ...webpageEvent, runtimeId: 'old-runtime' });
  syncMetadata({ ...webpageEvent, pluginId: 'other-plugin' });
  assert.equal(operations.length, 0, 'old generations and other plugins never overwrite titles or icons');
  syncMetadata(webpageEvent);
  assert.deepEqual(operations, [{ pluginId: contribution.pluginId, tab: page }]);
  // A real generation replacement must still close and reactivate stale instances.
  operations.length = 0;
  handlers.get('plugin:registryChanged')({ pluginId: contribution.pluginId });
  await flush();
  assert.deepEqual(operations, ['close-views', 'deactivate', 'refresh', 'activate']);
  store.dispose();
  assert.equal(handlers.has('plugin:webViewerChanged'), false, 'metadata subscriptions are released');
});

test('真实停靠模板切换和跨分组移动插件标签保留实例状态，关闭标签才释放实例', async () => {
  const vue = require('vue');
  const { parse, compileTemplate } = require('@vue/compiler-sfc');
  const compile = name => {
    const filename = new URL(`../DockingThree/${name}.vue`, import.meta.url);
    const { descriptor } = parse(readFileSync(filename, 'utf8'));
    const compiled = compileTemplate({ source: descriptor.template.content, filename: filename.pathname, id: 'docking-lifecycle' });
    assert.deepEqual(compiled.errors, []);
    const exports = {};
    vm.runInNewContext(ts.transpileModule(compiled.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS }
    }).outputText, { exports, require: () => vue });
    return { ...compiled, render: exports.render };
  };
  const compiled = compile('DockingThreeGroup');
  const workspace = compile('DockingThreeWorkspace');
  class TestElement {
    children = []; style = {}; parent = null; nodeType = 1;
  }
  const node = () => new TestElement();
  const panels = load('../DockingThree/pluginPanelTargets.ts', { vue }, { HTMLElement: TestElement });
  const registry = panels.createPluginPanelTargets();
  const previousContainer = node(), nextContainer = node();
  const unregisterOld = registry.register('replacement', previousContainer);
  const unregisterNew = registry.register('replacement', nextContainer);
  unregisterOld();
  assert.equal(registry.targets.get('replacement'), nextContainer, 'old group teardown cannot remove the new target');
  unregisterNew();
  const renderer = vue.createRenderer({
    createElement: node, createText: node, createComment: node,
    setText() {}, setElementText() {}, patchProp() {},
    parentNode: child => child.parent,
    nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
      child.parent = parent;
    },
    remove(child) {
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = null;
    }
  });
  const group = vue.reactive({ id: 'group', type: 'group', role: 'editor', activeTabId: 'first', tabs: [
    { id: 'first', kind: 'plugin', pluginId: 'com.example.viewer', viewInstanceId: 'first', viewType: 'browser', title: 'First' },
    { id: 'second', kind: 'plugin', pluginId: 'com.example.viewer', viewInstanceId: 'second', viewType: 'browser', title: 'Second' }
  ] });
  const states = new Map(), mounts = new Map(), releases = [];
  const moved = vue.ref(false);
  const hidden = vue.ref(false);
  const previewRoot = vue.ref();
  const root = vue.ref(group);
  const Group = {
    props: ['group'],
    setup(props) {
      const refs = panels.createPluginPanelTargetRefs(registry);
      vue.onBeforeUnmount(refs.disposePluginTargetRefs);
      return { ...refs, group: vue.computed(() => props.group), preview: false,
      isPreviewGhost: vue.computed(() => props.group.previewGhost), showHeader: false, topEdge: false,
      handleGroupPointerDown: () => undefined,
      renameDialogVisible: false, moveDialogVisible: false,
      groupElement: vue.ref(), isPluginTab: tab => tab.kind === 'plugin',
      isHostPanelTab: () => false, isEditorTab: () => false,
      isMediaTab: () => false, isWelcomeTab: () => false, isSettingsTab: () => false };
    },
    render: compiled.render
  };
  const app = renderer.createApp({
    setup: () => ({
      dockingThreeStore: { isDragging: false }, themeStore: { modernUiEnabled: false },
      setWorkspaceElement: () => undefined,
      renderedRoot: vue.computed(() => previewRoot.value ?? root.value),
      usingPreviewLayout: vue.computed(() => Boolean(previewRoot.value)), centerPreview: undefined,
      pluginTabs: vue.computed(() => panels.collectPluginPanelTabs(root.value)),
      pluginPanelTargets: registry, pluginParkingElement: vue.ref()
    }),
    render: workspace.render
  });
  // 保留真实模板和 Vue 生命周期，仅替换面板业务及无关工具栏。
  for (const name of (compiled.code + workspace.code).matchAll(/_resolveComponent\("([^"]+)"\)/g)) {
    if (!['v-sheet', 'DockingThreePanel', 'AsyncPluginViewPanel', 'DockingThreeNode'].includes(name[1])) {
      app.component(name[1], { render: () => vue.h('span') });
    }
  }
  const container = { setup: (_, { slots }) => () => vue.h('div', slots.default?.()) };
  app.component('v-sheet', container);
  app.component('DockingThreePanel', container);
  const Node = {
    props: ['node'],
    setup: props => () => hidden.value ? null : props.node.type === 'group'
      ? vue.h(Group, { group: props.node })
      : vue.h('div', props.node.children.map(child => vue.h(Node, { node: child, key: child.id })))
  };
  app.component('DockingThreeNode', {
    props: ['node'],
    setup: props => () => vue.h(moved.value ? 'section' : 'div', [vue.h(Node, { node: props.node })])
  });
  app.component('AsyncPluginViewPanel', {
    props: ['instanceId'],
    setup(props) {
      const state = { url: 'https://example.com/home', history: [], scrollTop: 0, input: '', element: node() };
      states.set(props.instanceId, state);
      mounts.set(props.instanceId, (mounts.get(props.instanceId) ?? 0) + 1);
      vue.onBeforeUnmount(() => { states.delete(props.instanceId); releases.push(props.instanceId); });
      return () => vue.h('main', { ref: element => { state.element = element; } });
    }
  });
  app.mount(node());
  await vue.nextTick();
  states.get('first').url = 'https://example.com/navigated';
  states.get('first').history.push('https://example.com/home');
  states.get('first').scrollTop = 850;
  states.get('first').input = 'unsent';
  const originalState = states.get('first');
  const originalElement = originalState.element;
  group.activeTabId = 'second';
  await vue.nextTick();
  group.activeTabId = 'first';
  await vue.nextTick();
  assert.equal(states.get('first').url, 'https://example.com/navigated');
  assert.equal(states.get('first').history.length, 1);
  assert.equal(mounts.get('first'), 1);
  assert.deepEqual(releases, []);
  moved.value = true;
  await vue.nextTick();
  assert.equal(states.get('first').url, 'https://example.com/navigated', 'reparenting a docking group must not reset its webpage');
  assert.equal(mounts.get('first'), 1);
  assert.deepEqual(releases, []);
  assert.equal(states.get('first'), originalState);
  assert.equal(originalState.element, originalElement);
  assert.equal(originalElement.parent, registry.targets.get('first'));
  const movedGroup = vue.reactive({ ...group, id: 'destination', tabs: [group.tabs[0]], activeTabId: 'first' });
  root.value = { id: 'split', type: 'split', children: [{ ...group, tabs: [group.tabs[1]], activeTabId: 'second' }, movedGroup] };
  await vue.nextTick();
  assert.equal(states.get('first'), originalState, 'moving between groups preserves the mounted plugin');
  assert.equal(originalElement.parent, registry.targets.get('first'));
  previewRoot.value = { id: 'preview-split', type: 'split', children: [
    { ...movedGroup, id: 'preview-ghost', previewGhost: true },
    root.value.children[0]
  ] };
  await vue.nextTick();
  previewRoot.value = undefined;
  await vue.nextTick();
  hidden.value = true;
  await vue.nextTick();
  assert.equal(registry.targets.size, 0);
  assert.equal(states.get('first'), originalState, 'collapsed containers park the existing plugin');
  hidden.value = false;
  await vue.nextTick();
  assert.equal(originalElement.parent, registry.targets.get('first'));
  assert.equal(originalState.scrollTop, 850);
  assert.equal(originalState.input, 'unsent');
  assert.equal(mounts.get('first'), 1);
  assert.equal(mounts.get('second'), 1);
  assert.deepEqual(releases, []);
  root.value = root.value.children[0];
  await vue.nextTick();
  assert.equal(states.has('first'), false);
  assert.equal(states.has('second'), true);
  assert.deepEqual(releases, ['first']);
  app.unmount();
  assert.deepEqual(releases, ['first', 'second']);
  assert.equal(registry.targets.size, 0);
});

test('工作台 API 统一调用 Rust，旧 Preload 全局不会接管请求', async () => {
  const calls = [];
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'app_get_version') return { version: '0.1.0' };
      if (command === 'ai_configurations_list') return [{ id: 'fixture' }];
      if (command === 'sql_get') return { value: 7 };
    } },
    './nativeEvents': { subscribeNativeEvent: () => () => undefined }
  }).nativeApi;
  const imports = {
    './native': { nativeApi: native, isTauriRuntime: () => false },
    './electronCompat': { getElectronApi: () => assert.fail('Retired Preload was read.') }
  };
  const system = load('system.ts', imports).systemApi;
  const windows = load('window.ts', imports).windowApi;
  const configurations = load('aiConfiguration.ts', imports).aiConfigurationApi;
  const sql = load('sql.ts', imports).sqlApi;
  assert.equal(await system.getVersion(), '0.1.0');
  await windows.openSettings('appearance');
  assert.equal((await configurations.listConfigurations())[0].id, 'fixture');
  assert.equal((await sql.get({ sql: 'SELECT 7 AS value', params: [] })).value, 7);
  assert.deepEqual(calls.map(call => call.command), [
    'app_get_version', 'workbench_open_settings', 'ai_configurations_list', 'sql_get'
  ]);
  assert.equal(calls[1].args.navigationId, 'appearance');
});

test('添加 AI 配置时广播和请求返回顺序均不会重复添加，保留其他配置', async () => {
  for (const eventFirst of [true, false]) {
    const initial = { id: 'default', name: '配置1', enabled: true };
    const created = { id: 'created', name: '配置2', enabled: true };
    let changed, finishCreate, calls = 0;
    const store = load('../store/aiModel.ts', {
      vue: require('vue'),
      pinia: { defineStore: (_id, setup) => setup },
      '@/api/aiConfiguration': { aiConfigurationApi: {
        onChanged: listener => { changed = listener; return () => undefined; },
        createConfiguration: () => { calls += 1; return new Promise(resolve => { finishCreate = resolve; }); }
      } },
      '@/api/aiConnection': { aiConnectionApi: {} },
      '@/api/aiModel': { aiModelApi: {} }
    }).useAiModelStore();
    changed([initial]);
    const pending = store.createConfiguration();
    if (eventFirst) changed([initial, created]);
    finishCreate(created);
    const result = await pending;
    assert.equal(result.id, created.id);
    assert.equal(calls, 1);
    assert.equal(store.configurations.value.length, 2, `eventFirst=${eventFirst}`);
    assert.deepEqual(Array.from(store.configurations.value, item => item.id), ['default', 'created']);
    if (!eventFirst) changed([initial, created]);
    changed([initial, created]);
    assert.equal(store.configurations.value.length, 2);
    assert.equal(store.configurationsLoading.value, false);
  }
});

test('Gemini 地址预览使用 v1beta/models，显式版本和代理前缀保持原样', () => {
  const { getAiEndpointPreview } = load('./aiConnection.ts', { './native': { nativeApi: {} } });
  for (const base of ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta', 'https://generativelanguage.googleapis.com/v1beta/models/']) {
    assert.equal(getAiEndpointPreview(base), 'https://generativelanguage.googleapis.com/v1beta/models');
  }
  assert.equal(getAiEndpointPreview('https://proxy.example/google/v1beta', 'gemini'), 'https://proxy.example/google/v1beta/models');
  assert.equal(getAiEndpointPreview('https://proxy.example/v1', 'gemini'), 'https://proxy.example/v1/models');
  assert.equal(getAiEndpointPreview('https://proxy.example/compatible/v1', 'openai'), 'https://proxy.example/compatible/v1/chat/completions');
  assert.equal(getAiEndpointPreview(''), undefined);
});

test('AI 默认传输经 Rust 事件完成流式会话，前端不回退到 HTTP', async () => {
  let listener;
  const globals = { AbortController, setTimeout, clearTimeout, URL };
  const types = load('../AIchat/interface/index.ts', {}, globals);
  const bridge = {
    isAvailable: () => false,
    onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
    start: async ({ sessionId }) => {
      listener({ sessionId, type: 'delta', text: 'Rust response' });
      listener({ sessionId, type: 'completed', finishReason: 'stop' });
    }
  };
  const transport = load('../AIchat/ipcTransport.ts', {
    '../api/aiChat': { aiChatApi: bridge }, './interface': types
  }, globals);
  const service = load('../AIchat/chatService.ts', {
    '../types/aiModel': load('../types/aiModel.ts', {}),
    '../api/aiChat': { aiChatApi: bridge },
    './fetchTransport': { FetchAiChatTransport: class { constructor() { assert.fail('Renderer HTTP fallback was constructed.'); } } },
    './ipcTransport': transport, './interface': types
  }, globals);
  const run = new service.AiChatService().start({
    conversationId: 'fixture', message: 'hello',
    model: { id: 'fixture-model', configurationId: 'fixture', endpointType: 'openai', apiEndpoint: 'https://fixture.example', apiKey: 'fixture-key' }
  });
  const result = await run.completion;
  assert.equal(result.status, 'completed');
  assert.equal(result.message.content, 'Rust response');
  assert.equal(listener, undefined);
});

test('AI 连续发送在失败或取消后仅携带成功轮次，重试不重复用户消息', async () => {
  const globals = { AbortController, DOMException, setTimeout, clearTimeout, URL };
  const types = load('../AIchat/interface/index.ts', {}, globals);
  const service = load('../AIchat/chatService.ts', {
    '../types/aiModel': load('../types/aiModel.ts', {}),
    './ipcTransport': { IpcAiChatTransport: class {} }, './interface': types
  }, globals);
  const requests = [];
  let mode = 'success';
  const chat = new service.AiChatService({ transport: {
    stream: async (request, emit) => {
      requests.push(Array.from(request.messages, message => ({ role: message.role, content: message.content })));
      if (mode === 'failure') throw new types.AiChatError('NETWORK', 'fixture connection closed');
      if (mode === 'cancel') {
        await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
        return;
      }
      emit({ type: 'delta', text: 'OK' });
      emit({ type: 'completed', finishReason: 'stop' });
    }
  } });
  const request = { conversationId: 'multi-turn', message: 'first',
    model: { id: 'fixture', endpointType: 'openai', apiEndpoint: 'https://fixture.example', apiKey: 'fixture-key' } };
  await chat.start(request).completion;
  const successful = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'OK' }];
  mode = 'failure';
  await assert.rejects(chat.start({ ...request, message: 'second' }).completion, error => error.code === 'NETWORK');
  assert.deepEqual(Array.from(chat.getContext('multi-turn'), message => ({ ...message })), successful);
  mode = 'cancel';
  const cancelled = chat.start({ ...request, message: 'cancelled' });
  cancelled.cancel();
  assert.equal((await cancelled.completion).status, 'cancelled');
  assert.deepEqual(Array.from(chat.getContext('multi-turn'), message => ({ ...message })), successful);
  mode = 'success';
  await chat.start({ ...request, message: 'second' }).completion;
  assert.deepEqual(requests.at(-1), [...successful, { role: 'user', content: 'second' }]);
  await chat.regenerate({ ...request, message: 'second' }).completion;
  assert.deepEqual(requests.at(-1), [...successful, { role: 'user', content: 'second' }]);
  mode = 'failure';
  await assert.rejects(chat.regenerate({ ...request, message: 'second' }).completion, error => error.code === 'NETWORK');
  mode = 'success';
  await chat.regenerate({ ...request, message: 'second' }).completion;
  assert.deepEqual(requests.at(-1), [...successful, { role: 'user', content: 'second' }]);
});

test('AI 请求等待原生监听就绪，快速回复不会在注册期间丢失', async () => {
  const f = eventFixture();
  const calls = [];
  let registered = false;
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push(command);
      if (command === 'ai_chat_start' && registered) {
        f.emit({ sessionId: args.request.sessionId, type: 'delta', text: 'ready response' });
        f.emit({ sessionId: args.request.sessionId, type: 'completed', finishReason: 'stop' });
      }
    } },
    './nativeEvents': f.api
  }).nativeApi;
  const bridge = load('aiChat.ts', { './native': { nativeApi: native } }).aiChatApi;
  const types = load('../AIchat/interface/index.ts', {});
  const transport = load('../AIchat/ipcTransport.ts', {
    '../api/aiChat': { aiChatApi: bridge }, './interface': types
  }, { AbortController });
  const events = [];
  const completion = new transport.IpcAiChatTransport().stream({
    model: { id: 'fixture', endpointType: 'openai', apiEndpoint: 'https://fixture.example', apiKey: 'fixture-key' },
    messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal
  }, event => { events.push(event); });
  await flush();
  assert.deepEqual(calls, [], 'request must not start before the native event listener is ready');
  registered = true;
  f.resolve();
  await completion;
  assert.deepEqual(events.map(event => ({ ...event })), [
    { type: 'delta', text: 'ready response' },
    { type: 'completed', finishReason: 'stop' }
  ]);
  assert.equal(f.count(), 1);
});

test('AI 原生监听注册失败立即结束请求，不启动服务商请求等待超时', async () => {
  const calls = [];
  const failure = new Error('fixture registration failed');
  const eventApi = load('nativeEvents.ts', {
    '@tauri-apps/api/event': { listen: async () => { throw failure; } }
  }, { console: { warn: () => undefined } });
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async command => { calls.push(command); } },
    './nativeEvents': eventApi
  }).nativeApi;
  const bridge = load('aiChat.ts', { './native': { nativeApi: native } }).aiChatApi;
  const types = load('../AIchat/interface/index.ts', {});
  const transport = load('../AIchat/ipcTransport.ts', {
    '../api/aiChat': { aiChatApi: bridge }, './interface': types
  }, { AbortController });
  await assert.rejects(new transport.IpcAiChatTransport().stream({
    model: { id: 'fixture', endpointType: 'openai', apiEndpoint: 'https://fixture.example', apiKey: 'fixture-key' },
    messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal
  }, () => undefined), error => error.code === 'NETWORK' && error.cause === failure);
  assert.deepEqual(calls, []);
});

/** 编译真实源文件，替换宿主 SDK 以控制异步建立和释放时序。 */
function load(name, imports, globals = {}) {
  const source = ts.transpileModule(readFileSync(new URL(name, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    require: name => Object.hasOwn(imports, name) ? imports[name] : require(name),
    console,
    URL,
    ...globals
  });
  return exports;
}

function eventFixture() {
  const page = new EventTarget();
  const warnings = [];
  let handler, resolve, count = 0;
  const names = [];
  const api = load('nativeEvents.ts', {
    '@tauri-apps/api/event': { listen: (_name, callback) => {
      names.push(_name);
      handler = callback;
      return new Promise(done => { resolve = done; });
    } }
  }, { window: page, console: { warn: (...args) => warnings.push(args) } });
  return { api, page, warnings, names, emit: payload => handler({ payload }),
    resolve: () => resolve(() => count++), count: () => count };
}

test('事件载荷正常转发，释放后排队回调不再进入业务', async () => {
  const f = eventFixture(); const values = [];
  const stop = f.api.subscribeNativeEvent('test:changed', value => values.push(value));
  await flush(); f.emit('before'); f.resolve(); await flush(); stop(); stop(); f.emit('after');
  assert.deepEqual(values, ['before']); assert.equal(f.count(), 1);
});

test('监听建立前立即释放时跳过宿主注册', async () => {
  const f = eventFixture();
  const stop = f.api.subscribeNativeEvent('test:changed', () => assert.fail());
  stop(); await flush(); assert.equal(f.count(), 0);
  assert.throws(() => f.resolve(), TypeError);
});

test('异步监听建立期间卸载时释放迟到资源', async () => {
  const f = eventFixture();
  const stop = f.api.subscribeNativeEvent('test:changed', () => assert.fail());
  await flush(); stop(); f.emit('queued'); f.resolve(); await flush(); stop();
  assert.equal(f.count(), 1);
});

test('pagehide 释放全部订阅，页面之间相互隔离', async () => {
  const first = eventFixture(); const second = eventFixture(); let count = 0;
  first.api.subscribeNativeEvent('test:changed', () => assert.fail());
  const stop = second.api.subscribeNativeEvent('test:changed', () => count++);
  await flush(); first.resolve(); second.resolve(); await flush();
  first.page.dispatchEvent(new Event('pagehide'));
  first.emit('late'); second.emit('active');
  assert.equal(first.count(), 1); assert.equal(second.count(), 0); assert.equal(count, 1); stop();
});

test('订阅失败映射稳定诊断码，释放仍可重复调用', async () => {
  const f = eventFixture();
  const stop = f.api.createNativeSubscription('test:failed', () => Promise.reject('denied'), () => assert.fail());
  await flush(); stop(); stop();
  assert.equal(f.warnings[0][1].code, 'NATIVE_EVENT_SUBSCRIBE_FAILED');
  assert.equal(f.warnings[0][1].cause, 'denied');
});

test('同步建立异常也会被诊断，释放异常不会重复调用 unlisten', async () => {
  const f = eventFixture();
  f.api.createNativeSubscription('test:sync', () => { throw new Error('sync'); }, () => assert.fail());
  let releases = 0;
  const stop = f.api.createNativeSubscription('test:release', async () => () => {
    releases++; throw new Error('release');
  }, () => assert.fail());
  await flush(); stop(); stop();
  assert.equal(releases, 1);
  assert.deepEqual(f.warnings.map(item => item[1].code),
    ['NATIVE_EVENT_SUBSCRIBE_FAILED', 'NATIVE_EVENT_RELEASE_FAILED']);
});

test('设置路径选择由 Rust 宿主校验并返回相对路径，取消和拒绝保持原契约', async () => {
  const replies = ['nested/note.md', null];
  const calls = [];
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args });
      if (replies.length) return replies.shift();
      throw new Error('WORKSPACE_PICK_ENTRY_INVALID');
    } },
    '@tauri-apps/plugin-dialog': { open: () => assert.fail('Settings picker must be handled by Rust.') },
    './nativeEvents': { subscribeNativeEvent: () => () => undefined }
  }).nativeApi;
  const options = { kind: 'file', extensions: ['.md'] };
  assert.equal(await native.workspace.pickEntry(options), 'nested/note.md');
  assert.equal(await native.workspace.pickEntry(options), undefined);
  await assert.rejects(native.workspace.pickEntry(options), /WORKSPACE_PICK_ENTRY_INVALID/);
  assert.equal(calls[0].command, 'workspace_pick_entry');
  assert.equal(calls[0].args.options, options);
});

test('独立文件窗口调用使用 Rust command 的路径参数名', async () => {
  const calls = [];
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args });
      return true;
    } },
    '@tauri-apps/plugin-dialog': { open: () => assert.fail('Window creation must not open a dialog.') },
    './nativeEvents': { subscribeNativeEvent: () => () => undefined }
  }).nativeApi;

  assert.equal(await native.workspace.openInNewWindow('nested/note.md'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'workspace_open_in_new_window');
  assert.equal(calls[0].args.requestedRelativePath, 'nested/note.md');
  assert.equal(Object.hasOwn(calls[0].args, 'relativePath'), false);
});

test('插件包路径由 Rust 选择器返回，浏览器 File 不提供媒体本地路径', async () => {
  const plugin = load('plugin.ts', {
    './native': { nativeApi: {}, isTauriRuntime: () => true },
    './nativePlugin': { nativePluginApi: { pickPluginPackagePath: async () => 'E:/packages/demo.wstudio-plugin' } },
    './electronCompat': { getElectronApi: () => assert.fail('Tauri must not inspect Electron files bridge.') }
  }).pluginApi;
  const media = load('media.ts', {
    '../../plugin/sdk/fileTypes': { DEFAULT_WORKSPACE_FILE_TYPES: [] },
    './electronCompat': { getElectronApi: () => assert.fail('Tauri must not inspect Electron files bridge.') },
    './native': { isTauriRuntime: () => true },
    '@tauri-apps/api/webview': { getCurrentWebview: () => assert.fail('Native drop listener is not needed for File objects.') },
    './nativeEvents': { createNativeSubscription: () => assert.fail('Native drop listener is not needed for File objects.') }
  });
  assert.equal(await plugin.selectPackagePath(), 'E:/packages/demo.wstudio-plugin');
  assert.equal(media.getDroppedFilePath({}), '');
});

test('本地媒体统一使用 Rust 宿主协议并保留路径编码，远程 URL 保持原值', () => {
  const calls = [];
  const createMedia = tauri => load('media.ts', {
    '../../plugin/sdk/fileTypes': { DEFAULT_WORKSPACE_FILE_TYPES: [] },
    '@tauri-apps/api/core': { convertFileSrc: (path, protocol) => {
      calls.push({ path, protocol });
      return 'http://wstudio-media.localhost/local';
    } },
    '@tauri-apps/api/webview': {},
    './native': { isTauriRuntime: () => tauri },
    './nativeEvents': {},
    './electronCompat': { getElectronApi: () => assert.fail('Media URLs must not read Electron bridge.') }
  });
  const source = 'E:\\仓库\\image #1.svg';
  const tauri = createMedia(true);
  assert.equal(tauri.resolveMediaSourceUrl(source), 'http://wstudio-media.localhost/local?path=E%3A%5C%E4%BB%93%E5%BA%93%5Cimage%20%231.svg');
  assert.deepEqual(calls, [{ path: 'local', protocol: 'wstudio-media' }]);
  assert.equal(tauri.resolveMediaSourceUrl('https://example.com/image.svg'), 'https://example.com/image.svg');
  assert.equal(calls.length, 1);
  const noPreload = createMedia(false);
  assert.equal(noPreload.resolveMediaSourceUrl(source), 'http://wstudio-media.localhost/local?path=E%3A%5C%E4%BB%93%E5%BA%93%5Cimage%20%231.svg');
});

test('macOS POSIX 绝对媒体路径通过 Rust 宿主协议加载', () => {
  const calls = [];
  const media = load('media.ts', {
    '../../plugin/sdk/fileTypes': { DEFAULT_WORKSPACE_FILE_TYPES: [] },
    '@tauri-apps/api/core': { convertFileSrc: (path, protocol) => {
      calls.push({ path, protocol });
      return 'wstudio-media://localhost/local';
    } },
    '@tauri-apps/api/webview': {},
    './native': { isTauriRuntime: () => true },
    './nativeEvents': {},
    './electronCompat': { getElectronApi: () => assert.fail('Media URLs must not read Electron bridge.') }
  });
  assert.equal(
    media.resolveMediaSourceUrl('/Users/test/笔记/图片 #1.png'),
    'wstudio-media://localhost/local?path=%2FUsers%2Ftest%2F%E7%AC%94%E8%AE%B0%2F%E5%9B%BE%E7%89%87%20%231.png'
  );
  assert.deepEqual(calls, [{ path: 'local', protocol: 'wstudio-media' }]);
  assert.equal(
    media.resolveMediaSourceUrl('image.png', '/Users/test/笔记/note.md'),
    'wstudio-media://localhost/local?path=%2FUsers%2Ftest%2F%E7%AC%94%E8%AE%B0%2Fimage.png'
  );
});

function rpcFixture(invoke) {
  return load('nativePlugin.ts', {
    '@tauri-apps/api/core': { invoke },
    '@tauri-apps/plugin-dialog': { open: async () => undefined },
    './nativeEvents': { subscribeNativeEvent: () => () => undefined }
  }).nativePluginApi;
}

test('插件安装与版本管理在 Tauri 下全部使用 Rust command，成功后注册表事件可释放', async () => {
  const calls = []; const event = eventFixture();
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args });
      return command === 'plugin_uninstall' ? undefined : { id: 'com.example.reader', state: 'disabled' };
    } },
    '@tauri-apps/plugin-dialog': { open: () => assert.fail('Management must use the selected request path.') },
    './nativeEvents': event.api
  }).nativeApi;
  const plugin = load('plugin.ts', {
    './native': { nativeApi: native, isTauriRuntime: () => true },
    './nativePlugin': { nativePluginApi: {} },
    './electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron fallback.') }
  }).pluginApi;
  const id = 'com.example.reader';
  const install = { sourcePath: 'E:/packages/reader.wstudio-plugin' };
  const update = { id, sourcePath: 'E:/packages/reader-2.wstudio-plugin' };
  const permissions = { id, permissions: ['storage.plugin'] }; const enabled = { id, enabled: false };
  assert.equal((await plugin.install(install)).state, 'disabled');
  await plugin.update(update); await plugin.rollback(id);
  await plugin.setPermissions(permissions); await plugin.setEnabled(enabled);
  assert.equal(await plugin.uninstall(id), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { command: 'plugin_install', args: { request: install } },
    { command: 'plugin_update', args: { request: update } },
    { command: 'plugin_rollback', args: { id } },
    { command: 'plugin_set_permissions', args: { request: permissions } },
    { command: 'plugin_set_enabled', args: { request: enabled } },
    { command: 'plugin_uninstall', args: { id } }
  ]);
  const values = []; const stop = plugin.onRegistryChanged(value => values.push(value));
  await flush(); event.resolve(); await flush(); event.emit({ pluginId: id });
  stop(); stop(); event.emit({ pluginId: 'late' });
  assert.equal(event.names[0], 'plugin:registryChanged');
  assert.deepEqual(values, [{ pluginId: id }]); assert.equal(event.count(), 1);
});

test('插件管理错误原样传回，启用失败不会落入 Electron 兼容路径', async () => {
  const error = new Error('PLUGIN_HOST_UNAVAILABLE'); const commands = [];
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async command => { commands.push(command); throw error; } },
    '@tauri-apps/plugin-dialog': { open: async () => undefined },
    './nativeEvents': { subscribeNativeEvent: () => () => undefined }
  }).nativeApi;
  const plugin = load('plugin.ts', {
    './native': { nativeApi: native, isTauriRuntime: () => true },
    './nativePlugin': { nativePluginApi: {} },
    './electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron fallback.') }
  }).pluginApi;
  const id = 'com.example.reader';
  for (const action of [
    () => plugin.install({ sourcePath: 'invalid' }),
    () => plugin.update({ id, sourcePath: 'invalid' }),
    () => plugin.rollback(id), () => plugin.setEnabled({ id, enabled: true }),
    () => plugin.setPermissions({ id, permissions: [] }), () => plugin.uninstall(id)
  ]) await assert.rejects(action, received => received === error);
  assert.equal(commands.length, 6);
});

test('Tauri 最低版本拒绝穿过真实管理 API 到 Store，保留错误码与原插件摘要', async () => {
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async () => { throw 'PLUGIN_APP_VERSION_UNSUPPORTED'; } },
    '@tauri-apps/plugin-dialog': { open: async () => undefined },
    './nativeEvents': { subscribeNativeEvent: () => () => undefined }
  }).nativeApi;
  const pluginApi = load('plugin.ts', {
    './native': { nativeApi: native, isTauriRuntime: () => true },
    './nativePlugin': { nativePluginApi: {} },
    './electronCompat': { getElectronApi: () => assert.fail('Version refusal must stay in Tauri.') }
  }).pluginApi;
  const store = load('../store/plugin.ts', {
    vue: { ref: value => ({ value }) },
    pinia: { defineStore: (_id, setup) => setup },
    '@/api/plugin': { pluginApi },
    '@/store/dockingThree': { useDockingThreeStore: () => assert.fail('Rejected enable must not open views.') },
    '../../plugin/runtime/rendererRuntime': {}
  }).usePluginStore();
  const installed = { id: 'com.example.reader', version: '1.0.0', enabled: false };
  store.plugins.value = [installed];
  for (const action of [
    () => store.install('future.wstudio-plugin'),
    () => store.update(installed.id, 'future.wstudio-plugin'),
    () => store.rollback(installed.id),
    () => store.setEnabled(installed.id, true)
  ]) {
    assert.equal(await action(), undefined);
    assert.equal(store.error.value, 'PLUGIN_APP_VERSION_UNSUPPORTED');
    assert.equal(store.loading.value, false);
    assert.equal(store.plugins.value[0], installed);
    assert.equal(store.plugins.value.length, 1);
  }
});

test('Tauri 贡献查询和变更订阅使用当前窗口桥接并释放监听', async () => {
  const page = new EventTarget();
  const event = eventFixture();
  const calls = [];
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async command => { calls.push(command); return []; } },
    '@tauri-apps/plugin-dialog': { open: async () => undefined },
    './nativeEvents': event.api
  }, { window: page }).nativeApi;
  const plugin = load('plugin.ts', {
    './native': { nativeApi: native, isTauriRuntime: () => true },
    './nativePlugin': { nativePluginApi: {} },
    './electronCompat': { getElectronApi: () => assert.fail('Tauri must use the native bridge.') }
  }).pluginApi;
  const values = [];
  const stop = plugin.onContributionsChanged(value => values.push(value));
  await plugin.listContributions();
  await flush(); event.resolve(); await flush();
  event.emit({ pluginId: 'com.example.plugin' });
  stop(); event.emit({ pluginId: 'late' });
  assert.equal(calls[0], 'plugin_list_contributions');
  assert.equal(event.names[0], 'plugin:contributionsChanged');
  assert.equal(values.length, 1);
  assert.equal(values[0].pluginId, 'com.example.plugin');
  assert.equal(event.count(), 1);
});

test('Tauri 插件视图打开和关闭事件使用原生事件桥接并可释放', async () => {
  const page = new EventTarget();
  const openEvent = eventFixture();
  const closeEvent = eventFixture();
  const native = load('native.ts', {
    '@tauri-apps/api/core': { invoke: async () => undefined },
    '@tauri-apps/plugin-dialog': { open: async () => undefined },
    './nativeEvents': openEvent.api
  }, { window: page }).nativeApi;
  const plugin = load('plugin.ts', {
    './native': { nativeApi: native, isTauriRuntime: () => true },
    './nativePlugin': {
      nativePluginApi: {
        onViewOpenRequested: listener => openEvent.api.subscribeNativeEvent('plugin:viewOpenRequested', listener),
        onViewCloseRequested: listener => closeEvent.api.subscribeNativeEvent('plugin:viewCloseRequested', listener)
      }
    },
    './electronCompat': { getElectronApi: () => assert.fail('Tauri must use native view events.') }
  }).pluginApi;
  const opened = [], closed = [];
  const stopOpen = plugin.onViewOpenRequested(value => opened.push(value));
  const stopClose = plugin.onViewCloseRequested(value => closed.push(value));
  await flush(); openEvent.emit({ pluginId: 'com.example.viewer', viewType: 'example.view', instanceId: 'one' });
  closeEvent.emit({ pluginId: 'com.example.viewer', viewType: 'example.view', instanceId: 'one' });
  stopOpen(); stopClose();
  assert.equal(opened.length + closed.length, 2);
});

test('Tauri WebViewer 状态订阅使用原生事件，菜单动作不回退到 Electron', async () => {
  const event = eventFixture();
  const calls = [];
  let result = true;
  let failure;
  const nativePlugin = load('nativePlugin.ts', {
    '@tauri-apps/api/core': { invoke: async (command, args) => {
      calls.push({ command, args });
      if (failure) throw failure;
      return result;
    } },
    './nativeEvents': event.api
  }).nativePluginApi;
  const values = [];
  const stop = nativePlugin.onWebViewerChanged(value => values.push(value));
  await flush();
  event.emit({ pluginId: 'com.example.web-viewer', tabs: [] });
  stop();
  assert.deepEqual(values, [{ pluginId: 'com.example.web-viewer', tabs: [] }]);

  const plugin = load('plugin.ts', {
    './native': { nativeApi: {}, isTauriRuntime: () => true },
    './nativePlugin': { nativePluginApi: nativePlugin },
    './electronCompat': { getElectronApi: () => assert.fail('Tauri must not use Electron WebViewer menu bridge.') }
  }).pluginApi;
  const request = {
    pluginId: 'com.example.web-viewer', instanceId: 'default', viewType: 'browser', action: 'zoom-in'
  };
  for (const action of ['zoom-in', 'zoom-out', 'zoom-reset', 'open-external', 'new-window', 'save-to-repository', 'favorite']) {
    request.action = action;
    assert.equal(await plugin.executeWebViewerContextMenu(request), true);
    assert.equal(calls.at(-1).command, 'plugin_web_viewer_context_menu');
    assert.equal(JSON.stringify(calls.at(-1).args), JSON.stringify({ request }));
  }
  result = false;
  assert.equal(await plugin.executeWebViewerContextMenu(request), false);
  for (const code of ['PLUGIN_PERMISSION_NOT_DECLARED', 'PLUGIN_RUNTIME_TERMINATED',
    'PLUGIN_REQUEST_TIMEOUT', 'PLUGIN_WEBVIEWER_TAB_NOT_FOUND', 'PLUGIN_API_UNAVAILABLE',
    'PLUGIN_STORAGE_INVALID', 'PLUGIN_WEBVIEWER_PAGE_CHANGED',
    'PLUGIN_PERMISSION_SCOPE_VIOLATION', 'PLUGIN_WRITE_CONFLICT', 'PLUGIN_WEBVIEWER_SAVE_BUSY']) {
    failure = code;
    await assert.rejects(plugin.executeWebViewerContextMenu(request), error => error.code === code && error.cause === code);
  }
  failure = new Error('platform failure');
  await assert.rejects(plugin.executeWebViewerContextMenu(request), error =>
    error.code === 'PLUGIN_WEBVIEWER_OPERATION_FAILED' && error.cause === failure);
});

test('Windows 工作台右键菜单走原生层并保留动作结果，浏览器预览走 DOM', async () => {
  let native = true;
  const requests = [];
  const menu = load('../utils/workbenchContextMenu.ts', {
    '../api/nativeContextMenu': {
      supportsNativeContextMenu: () => native,
      showNativeContextMenu: async request => { requests.push(request); return 'native-action'; }
    }
  });
  const dispose = menu.registerWorkbenchContextMenuHandler(async () => 'dom-action');
  const request = { x: 120, y: 80, items: [{ type: 'action', id: 'native-action', label: '刷新' }] };
  assert.equal(await menu.requestWorkbenchContextMenu(request), 'native-action');
  assert.equal(requests[0], request);
  assert.equal(await menu.requestWorkbenchContextMenu(request, { preferNative: false }), 'dom-action');
  native = false;
  assert.equal(await menu.requestWorkbenchContextMenu(request), 'dom-action');
  dispose();
  assert.equal(await menu.requestWorkbenchContextMenu(request), undefined);
});

test('原生菜单保留条目直到动作回传，支持子菜单、取消及失败释放', async () => {
  const resources = [];
  let mode = 'selected', pendingAction, session = 0;
  const create = (kind, options) => {
    const resource = { kind, options, closed: false,
      async text() { pendingAction?.(); pendingAction = undefined; return options.text; },
      async close() { this.closed = true; } };
    resources.push(resource);
    return resource;
  };
  const api = load('./nativeContextMenu.ts', {
    './native': { isTauriRuntime: () => true },
    '@tauri-apps/api/dpi': { LogicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } } },
    '@tauri-apps/api/menu': {
      MenuItem: { new: async options => create('action', options) },
      PredefinedMenuItem: { new: async options => create('separator', options) },
      Submenu: { new: async options => create('submenu', options) },
      Menu: { new: async options => {
        const resource = create('menu', options);
        resource.popup = async position => {
          assert.equal(position.x, 120);
          assert.equal(position.y, 80);
          assert.ok(resources.every(item => !item.closed), 'native action channels must remain alive');
          if (mode === 'failure') throw new Error('popup failed');
          if (mode === 'selected') pendingAction = options.items[2].options.items[0].options.action;
        };
        return resource;
      } }
    }
  }, { navigator: { userAgent: 'Windows NT' }, crypto: { randomUUID: () => `session-${++session}` } });
  const request = { x: 120, y: 80, items: [
    { type: 'action', id: 'disabled', label: 'A & B', enabled: false },
    { type: 'separator', id: 'separator' },
    { type: 'action', id: 'copy', label: '复制', children: [{ type: 'action', id: 'copy-path', label: '路径' }] }
  ] };
  assert.equal(api.supportsNativeContextMenu(), true);
  assert.equal(await api.showNativeContextMenu(request), 'copy-path');
  assert.equal(resources[0].options.enabled, false);
  assert.equal(resources[0].options.text, 'A && B');
  assert.equal(resources[0].options.id, 'session-1:disabled');
  assert.equal(resources[2].options.id, 'session-1:copy-path');
  assert.ok(resources.every(item => item.closed));
  resources.length = 0;
  mode = 'cancelled';
  assert.equal(await api.showNativeContextMenu(request), undefined);
  assert.equal(resources[0].options.id, 'session-2:disabled', 'sessions isolate native IDs across windows');
  assert.ok(resources.every(item => item.closed));
  resources.length = 0;
  mode = 'failure';
  await assert.rejects(api.showNativeContextMenu(request), /popup failed/);
  assert.ok(resources.every(item => item.closed));
});

test('普通插件 Tauri 视图路由覆盖 WebViewer 操作、边界同步和释放', async () => {
  const calls = [];
  const bounds = [];
  const failures = [], eventListeners = [];
  let releasedEvents = 0;
  let failNextMount = false;
  let saveMode = 'success';
  let overlayCount = 0;
  let overlayKind = 'tooltip';
  let updateBounds;
  let measuredBounds;
  let holdNextBounds = false;
  let releaseBounds;
  const overlayObservers = [];
  const splitHandles = [];
  const menuPanels = [];
  const themeRoot = {};
  let scrollbarColors = {
    '--ws-editor-scrollbarSlider-background': '#4f5359',
    '--ws-editor-scrollbarSlider-hoverBackground': 'rgb(148 163 184)',
    '--ws-editor-scrollbarSlider-activeBackground': 'rgb(226 232 240)'
  };
  let modernUiEnabled = false;
  let rootLeft = 10;
  let rootTop = 20;
  let rootWidth = 500;
  let rootHeight = 400;
  const pluginId = 'com.example.web-viewer';
  const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
    '../sdk/disposables': load('../../plugin/sdk/disposables.ts', {}),
    './icons': { createIconsApi: () => ({}) },
    './corePluginAssets': {
      loadCorePluginModule: async () => ({
        activate: async () => undefined,
        mountView: async context => {
          context.webViewer.onDidFail(failure => failures.push(failure));
          const tab = await context.webViewer.open({ url: 'https://example.com/' });
          if (failNextMount) throw new Error('mount failed after native open');
          await context.webViewer.list();
          await tab.navigate('https://example.com/next');
          await tab.back();
          await tab.forward();
          await tab.reload();
          for (const action of ['zoom-in', 'zoom-out', 'zoom-reset', 'open-external', 'new-window', 'save-to-repository', 'favorite']) {
            assert.equal(await tab.executeAction(action), true);
          }
          saveMode = 'cancelled';
          assert.equal(await tab.executeAction('save-to-repository'), false);
          saveMode = 'denied';
          await assert.rejects(tab.executeAction('save-to-repository'), error => error.code === 'PLUGIN_PERMISSION_SCOPE_VIOLATION');
          saveMode = 'success';
          await context.webViewer.activate(tab.id);
          await context.view.setWebViewerBounds({ x: 4, y: 5, width: 320, height: 240 });
          updateBounds = context.view.setWebViewerBounds;
          context.view.onDidResize(() => {
            if (measuredBounds) void context.view.setWebViewerBounds(measuredBounds);
          });
          await tab.close();
        }
      }),
      getCorePluginStylesUrl: () => ''
    },
    '../../src/api/nativeEditor': { isTauriEditorRuntime: () => true, nativeEditorApi: {} },
    '../../src/api/nativePlugin': {
      isTauriPluginRuntime: () => true,
      nativePluginApi: {
        invokeRenderer: async envelope => {
          calls.push(envelope);
          const method = envelope.request.method;
          if (method === 'webViewer.executeAction' && envelope.request.params.action === 'save-to-repository') {
            if (saveMode === 'denied') return { protocolVersion: 1, requestId: envelope.request.requestId,
              ok: false, error: { code: 'PLUGIN_PERMISSION_SCOPE_VIOLATION', message: 'Destination is outside the grant.' } };
            return { protocolVersion: 1, requestId: envelope.request.requestId, ok: true, result: saveMode !== 'cancelled' };
          }
          const result = method === 'webViewer.open'
            ? { id: 'tab-1', instanceId: 'instance-1', title: 'Example', url: 'https://example.com/', active: true, canGoBack: false, canGoForward: false, loading: false }
            : method === 'webViewer.list' ? [] : method === 'webViewer.executeAction' ? true : undefined;
          return { protocolVersion: 1, requestId: envelope.request.requestId, ok: true, result };
        },
        updateViewBounds: async request => {
          bounds.push(request);
          if (holdNextBounds) {
            holdNextBounds = false;
            await new Promise(resolve => { releaseBounds = resolve; });
          }
        },
        disposeView: async request => calls.push({ dispose: request }),
        onWebViewerChanged: listener => {
          eventListeners.push(listener);
          return () => { releasedEvents++; };
        }
      }
    },
    '../../src/api/electronCompat': {
      getElectronApi: () => assert.fail('Tauri view routes must not touch Electron fallback.')
    }
  }, {
    document: {
      createElement: () => ({ rel: '', href: '', dataset: {}, remove: () => undefined }),
      body: {},
      documentElement: themeRoot,
      querySelector: selector => {
        if (selector === '.docking-three-workspace--modern') return modernUiEnabled ? {} : null;
        if (overlayCount === 0) return null;
        if (overlayKind === 'tooltip' || overlayKind === 'menu') return null;
        if (overlayKind === 'dialog') return selector.includes('.v-overlay.v-overlay--active.v-dialog') ? {} : null;
        if (overlayKind === 'custom-dialog') return selector.includes('.ws-dialog-layer') ? {} : null;
        if (overlayKind === 'command-center') return selector.includes('.command-center-overlay') ? {} : null;
        return null;
      },
      querySelectorAll: selector => selector.includes('menu') ? menuPanels : splitHandles,
    },
    getComputedStyle: element => ({ width: '16px', height: '16px', display: element.hidden ? 'none' : 'block', visibility: 'visible',
      getPropertyValue: name => element === themeRoot ? scrollbarColors[name] ?? '' : '' }),
    CSS: { supports: (_property, value) => value.startsWith('#') || value.startsWith('rgb(') },
    MutationObserver: class FakeMutationObserver {
      constructor(callback) { this.callback = callback; overlayObservers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.disconnected = true; }
    },
    ShadowRoot: Object,
    ResizeObserver: class FakeResizeObserver {
      observe() {}
      disconnect() {}
    }
  });

  const root = {
    getRootNode: () => ({ insertBefore() {} }),
    getBoundingClientRect: () => ({ left: rootLeft, top: rootTop, width: rootWidth, height: rootHeight }),
    replaceChildren: () => undefined
  };
  const contribution = {
    pluginId,
    pluginName: 'Web viewer fixture',
    pluginVersion: '1.0.0',
    trustLevel: 'standard',
    runtimeId: 'runtime-web-viewer',
    entryUrl: '',
    stylesUrl: 'style.css',
    commands: [], views: [], settings: [], statusBar: []
  };

  const mounted = await runtime.mountPluginView({
    contribution,
    viewType: 'browser',
    instanceId: 'instance-1',
    root,
    initialUrl: 'https://example.com/'
  });
  assert.equal(JSON.stringify(bounds[0].scrollbarTheme), JSON.stringify({
    background: '#4f5359', hoverBackground: 'rgb(148 163 184)', activeBackground: 'rgb(226 232 240)',
    modernUiEnabled: false
  }), 'ordinary plugins receive the host scrollbar theme automatically');
  assert.equal(JSON.stringify(calls.find(call => call.request?.method === 'webViewer.open').request.params.scrollbarTheme),
    JSON.stringify(bounds[0].scrollbarTheme), 'initialization receives theme colors before the native page opens');
  const themeObserver = overlayObservers.find(observer => observer.target === themeRoot);
  assert.ok(themeObserver, 'native views must observe root theme changes');
  const themedBounds = JSON.stringify(bounds.at(-1).bounds);
  const beforeThemeChange = bounds.length;
  scrollbarColors = {
    '--ws-editor-scrollbarSlider-background': 'rgb(148 163 184)',
    '--ws-editor-scrollbarSlider-hoverBackground': 'rgb(100 116 139)',
    '--ws-editor-scrollbarSlider-activeBackground': 'rgb(51 65 85)'
  };
  themeObserver.callback();
  await flush();
  assert.equal(bounds.length, beforeThemeChange + 1, 'theme changes synchronize even if geometry is unchanged');
  assert.equal(JSON.stringify(bounds.at(-1).bounds), themedBounds, 'theme updates preserve content geometry');
  assert.equal(bounds.at(-1).scrollbarTheme.activeBackground, 'rgb(51 65 85)');
  themeObserver.callback();
  await flush();
  assert.equal(bounds.length, beforeThemeChange + 1, 'unchanged theme and geometry do not send duplicate updates');
  modernUiEnabled = true;
  themeObserver.callback();
  await flush();
  assert.equal(bounds.at(-1).scrollbarTheme.modernUiEnabled, true,
    'Modern UI appearance enables rounded native webpage thumbs');
  modernUiEnabled = false;
  themeObserver.callback();
  await flush();
  assert.equal(bounds.at(-1).scrollbarTheme.modernUiEnabled, false,
    'default appearance removes native webpage thumb rounding');
  // 网页容器四边仅留 2px，不能按 16px 的拖拽命中区挤压内容。
  splitHandles.push({
    classList: { contains: name => name.endsWith('--horizontal') },
    getBoundingClientRect: () => ({ left: 18, top: 20, right: 18, bottom: 400 })
  }, {
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ left: 10, top: 329, right: 500, bottom: 329 })
  }, {
    classList: { contains: name => name.endsWith('--horizontal') },
    getBoundingClientRect: () => ({ left: 600, top: 20, right: 600, bottom: 400 })
  });
  await updateBounds({ x: 8, y: 9, width: 400, height: 300 });
  assert.equal(JSON.stringify(bounds.at(-1).bounds), JSON.stringify({ x: 20, y: 31, width: 396, height: 296 }));
  rootLeft = 42;
  rootTop = 56;
  overlayObservers[0].callback();
  await flush();
  assert.equal(JSON.stringify(bounds.at(-1).bounds), JSON.stringify({ x: 52, y: 67, width: 396, height: 296 }),
    'native view coordinates follow host movement even when its size is unchanged');
  measuredBounds = { x: 8, y: 40, width: 400, height: 269 };
  overlayObservers[0].callback();
  await flush();
  assert.equal(JSON.stringify(bounds.at(-1).bounds), JSON.stringify({ x: 52, y: 98, width: 396, height: 265 }),
    'docking must remeasure the content offset even when the root size is unchanged');
  measuredBounds = undefined;
  await updateBounds({ x: 8, y: 9, width: 400, height: 300 });
  rootWidth = 0;
  rootHeight = 0;
  overlayObservers[0].callback();
  await flush();
  assert.equal(JSON.stringify(bounds.at(-1).bounds), JSON.stringify({ x: 0, y: 0, width: 0, height: 0 }),
    'hidden plugin panels hide the native webview instead of leaving stale content over another tab');
  scrollbarColors['--ws-editor-scrollbarSlider-background'] = '#4f5359';
  themeObserver.callback();
  await flush();
  assert.equal(bounds.at(-1).scrollbarTheme.background, '#4f5359', 'hidden tabs receive the latest theme');
  assert.equal(bounds.at(-1).bounds.width, 0, 'theme synchronization must not reveal a hidden webpage');
  rootWidth = 500;
  rootHeight = 400;
  rootLeft = 10;
  rootTop = 20;
  overlayObservers[0].callback();
  await flush();
  splitHandles.length = 0;
  overlayCount = 2;
  overlayObservers[0].callback();
  await flush();
  assert.equal(bounds.at(-1).bounds.width, 396, 'tooltips and menus keep the webpage visible');
  const panel = (left, top, width, height, hidden = false) => ({ hidden,
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) });
  menuPanels.push(panel(0, 0, 100, 100), panel(600, 50, 100, 100), panel(50, 60, 70, 80, true));
  overlayKind = 'menu';
  overlayObservers[0].callback();
  await flush();
  assert.equal(bounds.at(-1).bounds.width, 396, 'a menu must never hide or resize the webpage');
  assert.equal(JSON.stringify(bounds.at(-1).occlusions), JSON.stringify([{ x: 20, y: 31, width: 80, height: 69 }]),
    'only the visible menu intersection is excluded from the native surface');
  menuPanels.push(panel(90, 80, 100, 120));
  overlayObservers[0].callback();
  await flush();
  assert.equal(bounds.at(-1).occlusions.length, 2, 'opening a submenu updates clipping without changing webpage bounds');
  menuPanels.length = 0;
  overlayObservers[0].callback();
  await flush();
  assert.equal(JSON.stringify(bounds.at(-1).occlusions), '[]', 'closing the menu restores the entire native surface');
  overlayKind = 'dialog';
  overlayObservers[0].callback();
  await flush();
  assert.equal(bounds.at(-1).bounds.width, 0, 'modal dialogs retain their existing visibility behavior');
  overlayKind = 'custom-dialog';
  overlayObservers[0].callback();
  await flush();
  assert.equal(bounds.at(-1).bounds.width, 0, 'custom modal dialogs keep the webview hidden');
  overlayKind = 'command-center';
  overlayObservers[0].callback();
  await flush();
  assert.equal(bounds.at(-1).bounds.width, 0, 'command center keeps the webview hidden');
  await updateBounds({ x: 8, y: 9, width: 400, height: 300 });
  assert.equal(bounds.at(-1).bounds.width, 0, 'resize cannot reveal a covered webview');
  overlayCount = 1;
  overlayObservers[0].callback();
  await flush();
  assert.equal(bounds.at(-1).bounds.width, 0, 'closing one overlay preserves the other');
  overlayCount = 0;
  overlayObservers[0].callback();
  await flush();
  assert.equal(JSON.stringify(bounds.at(-1).bounds), JSON.stringify({ x: 20, y: 31, width: 396, height: 296 }));
  holdNextBounds = true;
  overlayCount = 1;
  overlayObservers[0].callback();
  await flush();
  const pendingBoundsCount = bounds.length;
  overlayCount = 0;
  overlayObservers[0].callback();
  const resized = updateBounds({ x: 12, y: 13, width: 420, height: 310 });
  await flush();
  assert.equal(bounds.length, pendingBoundsCount, 'restore must wait for the in-flight hide');
  releaseBounds();
  await resized;
  assert.equal(JSON.stringify(bounds.at(-1).bounds), JSON.stringify({ x: 24, y: 35, width: 416, height: 306 }));
  const failure = { tabId: 'tab-1', instanceId: 'instance-1', viewType: 'browser',
    url: 'https://example.com/next', reason: 'renderer-exited' };
  const event = { pluginId, runtimeId: contribution.runtimeId, tabs: [], failures: [failure] };
  for (const altered of [ { ...event, pluginId: 'com.other.viewer' },
    { ...event, runtimeId: 'old-generation' },
    { ...event, failures: [{ ...failure, instanceId: 'other-instance' }] },
    { ...event, failures: [{ ...failure, viewType: 'other-view' }] },
    { ...event, failures: undefined } ]) eventListeners[0](altered);
  assert.equal(failures.length, 0);
  eventListeners[0](event);
  assert.equal(failures[0], failure);
  mounted.dispose();
  mounted.dispose();
  assert.equal(overlayObservers[0].disconnected, true);
  assert.equal(themeObserver.disconnected, true);
  const disposedBoundsCount = bounds.length;
  overlayCount = 1;
  overlayObservers[0].callback();
  themeObserver.callback();
  await flush();
  assert.equal(bounds.length, disposedBoundsCount, 'disposed views ignore queued overlay changes');
  eventListeners[0](event);
  assert.equal(failures.length, 1);
  assert.equal(releasedEvents, 1);
  await runtime.deactivatePlugin(pluginId);

  assert.deepEqual(calls.map(call => call.request?.method ?? 'dispose'), [
    'runtimeReady', 'webViewer.open', 'webViewer.list', 'webViewer.navigate',
    'webViewer.back', 'webViewer.forward', 'webViewer.reload',
    ...Array(9).fill('webViewer.executeAction'), 'webViewer.activate',
    'webViewer.close', 'dispose'
  ]);
  assert.equal(JSON.stringify(bounds[0].bounds), JSON.stringify({ x: 16, y: 27, width: 316, height: 236 }));
  assert.equal(bounds[0].runtimeId, contribution.runtimeId);
  assert.equal(calls.at(-1).dispose.instanceId, 'instance-1');
  assert.equal(calls.at(-1).dispose.runtimeId, contribution.runtimeId);
  const actions = calls.filter(call => call.request?.method === 'webViewer.executeAction');
  assert.deepEqual(actions.map(call => call.request.params.action), ['zoom-in', 'zoom-out', 'zoom-reset', 'open-external', 'new-window',
    'save-to-repository', 'favorite', 'save-to-repository', 'save-to-repository']);
  for (const call of actions) {
    assert.equal(call.request.params.tabId, 'tab-1');
    assert.equal(call.request.runtimeId, contribution.runtimeId);
    assert.equal(call.view.instanceId, 'instance-1');
    assert.equal(call.view.viewType, 'browser');
    const timeout = call.request.deadline - Date.now();
    if (call.request.params.action === 'save-to-repository') assert.ok(timeout > 299_000 && timeout <= 300_000);
    else assert.ok(timeout > 14_000 && timeout <= 15_000);
  }

  failNextMount = true;
  await assert.rejects(runtime.mountPluginView({
    contribution, viewType: 'browser', instanceId: 'failed-instance', root
  }), /mount failed after native open/);
  assert.equal(calls.at(-1).dispose.instanceId, 'failed-instance');
  assert.equal(calls.at(-1).dispose.runtimeId, contribution.runtimeId);
  await runtime.deactivatePlugin(pluginId);
});

test('WebViewer 核心插件通过公开 SDK 手动恢复故障网页，保留地址且回收监听', async () => {
  const elements = [];
  const contentObservers = [];
  let visible = true, contentTop = 60, contentHeight = 360;
  const document = { createElement: tag => {
    const element = { tag, children: [], events: {}, attributes: {}, value: '', disabled: false,
      clientWidth: 640, clientHeight: 400, offsetHeight: 32, textContent: '',
      getBoundingClientRect() {
        if (!visible) return { left: 0, top: 0, width: 0, height: 0 };
        return { left: 10, top: this.className === 'web-viewer-content' ? contentTop : 20,
          width: 640, height: this.className === 'web-viewer-content' ? contentHeight : 400 };
      },
      replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { this.events[name] = callback; } };
    elements.push(element);
    return element;
  } };
  const module = load('../../plugin/core-plugins/web-viewer/main.js', {}, {
    document,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; contentObservers.push(this); }
      observe(element) { this.element = element; }
      disconnect() { this.disconnected = true; }
    }
  });
  const subscriptions = load('../../plugin/sdk/disposables.ts', {}).DisposableStore;
  const store = new subscriptions();
  const opens = [], navigations = [], bounds = [], errors = [];
  let onChange, onFail, onResize, tab, failOpen = false, removals = 0;
  const context = {
    subscriptions: store,
    settings: { onDidChangePage() {}, get: async () => undefined },
    logger: { error: (...args) => errors.push(args) },
    view: { root: document.createElement('root'), initialUrl: 'https://example.com/original',
      onDidResize: callback => { onResize = callback; return { dispose() {} }; },
      setWebViewerBounds: async value => bounds.push(value) },
    webViewer: {
      list: async () => tab ? [tab] : [],
      open: async ({ url }) => {
        opens.push(url);
        if (failOpen) throw new Error('native creation failed');
        tab = { id: `tab-${opens.length}`, active: true, url, loading: false };
        return { id: tab.id };
      },
      get: id => ({ navigate: async url => { navigations.push({ id, url }); }, reload: async () => {} }),
      onDidChange: callback => { onChange = callback; return { dispose: () => { removals++; } }; },
      onDidFail: callback => { onFail = callback; return { dispose: () => { removals++; } }; }
    }
  };
  await module.mountView(context);
  assert.deepEqual(opens, ['https://example.com/original']);
  const reload = elements.find(element => element.attributes['aria-label'] === '刷新');
  const address = elements.find(element => element.tag === 'input');
  const content = elements.find(element => element.className === 'web-viewer-content');
  const progress = elements.find(element => element.attributes.role === 'progressbar');
  assert.ok(progress, 'a webpage loading indicator is mounted below the toolbar');
  assert.equal(progress.hidden, true);
  onChange([{ ...tab, loading: true }]);
  assert.equal(progress.hidden, false);
  onChange([{ ...tab, loading: false }]);
  assert.equal(progress.hidden, true);
  assert.equal(JSON.stringify(bounds.at(-1)), JSON.stringify({ x: 0, y: 40, width: 640, height: 360 }),
    'native bounds use the actual content rectangle, not the toolbar cached height');
  visible = false;
  onResize();
  await flush();
  const hiddenBoundsCount = bounds.length;
  visible = true;
  onResize();
  await flush();
  assert.equal(JSON.stringify(bounds.at(-1)), JSON.stringify({ x: 0, y: 40, width: 640, height: 360 }));
  contentTop = 68;
  contentHeight = 352;
  contentObservers[0].callback();
  await flush();
  assert.equal(JSON.stringify(bounds.at(-1)), JSON.stringify({ x: 0, y: 48, width: 640, height: 352 }),
    'stylesheet layout changes after reparenting synchronize without switching tabs');
  assert.equal(opens.length, 1, 'geometry updates preserve the native webpage');
  assert.ok(bounds.length > hiddenBoundsCount);
  const crash = reason => {
    const old = tab; tab = undefined;
    onChange([]);
    onFail({ tabId: old.id, instanceId: 'instance', viewType: 'browser', url: old.url, reason });
    return old;
  };
  const old = crash('renderer-exited');
  assert.equal(progress.hidden, true, 'a failed webpage does not leave the loading indicator running');
  assert.equal(opens.length, 1, 'failure does not automatically restart');
  assert.equal(address.value, old.url);
  assert.equal(reload.disabled, false);
  assert.match(content.textContent, /点击刷新/);
  failOpen = true;
  await reload.events.click();
  assert.equal(errors.length, 1);
  assert.equal(reload.disabled, false, 'failed recreation still allows retry');
  failOpen = false;
  await reload.events.click();
  assert.equal(opens.at(-1), old.url);
  assert.equal(content.textContent, '');
  assert.ok(bounds.length >= 2);
  await elements.find(element => element.attributes['aria-label'] === '首页').events.click();
  assert.equal(navigations[0].id, tab.id, 'old tab handle is not reused');
  crash('browser-exited');
  address.value = 'https://example.org/recovery';
  await address.events.keydown({ key: 'Enter' });
  await flush();
  assert.equal(opens.at(-1), 'https://example.org/recovery');
  const count = opens.length;
  store.dispose();
  const disposedBoundsCount = bounds.length;
  contentObservers[0].callback();
  onResize();
  await flush();
  assert.equal(bounds.length, disposedBoundsCount, 'disposed geometry observers do not send updates');
  assert.equal(contentObservers[0].disconnected, true);
  await reload.events.click();
  onFail({ tabId: tab.id, url: old.url, reason: 'renderer-exited' });
  assert.equal(opens.length, count);
  assert.equal(removals, 2);
});

test('文件列表统计会读取未展开的子目录并缓存递归文件总数', async () => {
  const source = readFileSync(new URL('../../plugin/core-plugins/file-explorer/main.js', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(`${source}\nexports.__test = { startDirectoryFileCountWorker };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, console, setTimeout, clearTimeout });
  const reads = [];
  const state = {
    context: { filesystem: { listEntries: async directory => {
      reads.push(directory);
      return directory === '.'
        ? [{ type: 'directory', name: 'nested', path: 'nested' }, { type: 'file', name: 'root.md', path: 'root.md' }]
        : [{ type: 'file', name: 'nested.md', path: 'nested/nested.md' }];
    } } },
    entriesByDirectory: new Map([['.', [
      { type: 'directory', name: 'nested', path: 'nested' },
      { type: 'file', name: 'root.md', path: 'root.md' }
    ]]]),
    showFileCount: true,
    repository: { id: 'fixture' },
    directoryFileCounts: new Map(),
    directoryFileCountStale: new Set(['.']),
    directoryFileCountErrors: new Set(),
    directoryFileCountRetryAttempts: new Map(),
    directoryFileCountElements: new Map([['nested', new Set()]]),
    directoryFileCountGeneration: 0,
    directoryFileCountVersions: new Map(),
    directoryFileCountQueue: []
  };
  let resolveCount;
  const counted = new Promise(resolve => { resolveCount = resolve; });
  state.directoryFileCountQueue.push({
    directory: '.', generation: 0, version: 0, resolve: resolveCount, reject: error => { throw error; }
  });

  exports.__test.startDirectoryFileCountWorker(state);

  assert.equal(await counted, 2);
  assert.deepEqual(reads, ['nested']);
  assert.equal(state.directoryFileCounts.get('.'), 2);
  assert.equal(state.directoryFileCounts.get('nested'), 1);
});

test('状态栏立即释放等待注册完成，重复释放和修改原始对象不会改变注销 ID', async () => {
  const calls = [], warnings = [];
  let completeRegistration;
  const contribution = { pluginId: 'com.example.status-plugin', pluginName: 'Status plugin',
    pluginVersion: '1.0.0', trustLevel: 'standard', entryUrl: '', stylesUrl: '',
    commands: [], views: [], settings: [], statusBar: [] };
  const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
    '../sdk/disposables': load('../../plugin/sdk/disposables.ts', {}),
    './icons': { createIconsApi: () => ({}) },
    './corePluginAssets': {
      loadCorePluginModule: async () => ({ activate: context => {
        const item = { id: 'com.example.status-plugin.status', text: 'Ready' };
        const registration = context.statusBar.registerItem(item);
        item.id = 'changed';
        registration.dispose(); registration.dispose();
      } }),
      getCorePluginStylesUrl: () => ''
    },
    '../../src/api/nativeEditor': { isTauriEditorRuntime: () => true, nativeEditorApi: {} },
    '../../src/api/nativePlugin': { isTauriPluginRuntime: () => true, nativePluginApi: {
      invokeRenderer: envelope => {
        calls.push(envelope.request);
        if (envelope.request.method === 'statusBar.registerItem') {
          return new Promise(resolve => { completeRegistration = () => resolve({ ok: true }); });
        }
        return Promise.resolve({ ok: true });
      }
    } },
    '../../src/api/electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron access.') }
  }, { console: { warn: (...args) => warnings.push(args) } });
  await runtime.ensurePluginActivated(contribution);
  assert.equal(calls.filter(call => call.method === 'statusBar.registerItem').length, 1);
  assert.equal(calls.find(call => call.method === 'statusBar.registerItem').params.item.id, 'com.example.status-plugin.status');
  completeRegistration(); await flush();
  assert.equal(calls.filter(call => call.method === 'statusBar.unregisterItem').length, 1);
  assert.equal(calls.find(call => call.method === 'statusBar.unregisterItem').params.id, 'com.example.status-plugin.status');
  await runtime.deactivatePlugin(contribution.pluginId); await flush();
  assert.equal(calls.filter(call => call.method === 'runtimeReady').length, 1);
  assert.equal(warnings.length, 0);
});

test('插件激活成功与入口加载失败都向 Rust Host 回报对应 runtimeId', async () => {
  const contribution = pluginId => ({ pluginId, pluginName: 'Host lifecycle',
    pluginVersion: '1.0.0', trustLevel: 'standard', runtimeId: `runtime-${pluginId}`,
    entryUrl: '', stylesUrl: '', commands: [], views: [], settings: [], statusBar: [] });
  const loadRuntime = (pluginId, loader) => {
    const calls = [];
    const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
      '../sdk/disposables': load('../../plugin/sdk/disposables.ts', {}),
      './icons': { createIconsApi: () => ({}) },
      './corePluginAssets': { loadCorePluginModule: loader, getCorePluginStylesUrl: () => '' },
      '../../src/api/nativeEditor': { isTauriEditorRuntime: () => true, nativeEditorApi: {} },
      '../../src/api/nativePlugin': { isTauriPluginRuntime: () => true, nativePluginApi: {
        invokeRenderer: async envelope => {
          calls.push(envelope.request);
          return { ok: true };
        }
      } },
      '../../src/api/electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron access.') }
    });
    return { calls, runtime, contribution: contribution(pluginId) };
  };

  const success = loadRuntime('com.example.ready', async () => ({ activate: async () => undefined }));
  await success.runtime.ensurePluginActivated(success.contribution);
  assert.equal(success.calls.at(-1).method, 'runtimeReady');
  assert.equal(success.calls.at(-1).runtimeId, 'runtime-com.example.ready');
  await success.runtime.deactivatePlugin(success.contribution.pluginId);

  const failure = loadRuntime('com.example.failed', async () => { throw new Error('entry load failed'); });
  await assert.rejects(failure.runtime.ensurePluginActivated(failure.contribution));
  assert.equal(failure.calls.at(-1).method, 'runtimeFailed');
  assert.equal(failure.calls.at(-1).runtimeId, 'runtime-com.example.failed');
});

test('动态设置读取使用宿主有效定义，注册就绪与重复释放保持顺序且固定页面 ID', async () => {
  const calls = [];
  let completeRegistration;
  const contribution = { pluginId: 'com.example.settings-plugin', pluginName: 'Settings plugin',
    pluginVersion: '1.0.0', trustLevel: 'standard', entryUrl: '', stylesUrl: '',
    commands: [], views: [], settings: [{ id: 'com.example.settings-plugin.page', title: 'Settings' }], statusBar: [] };
  const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
    '../sdk/disposables': load('../../plugin/sdk/disposables.ts', {}),
    './icons': { createIconsApi: () => ({}) },
    './corePluginAssets': {
      loadCorePluginModule: async () => ({ activate: async context => {
        const page = { id: 'com.example.settings-plugin.page', getSettingDefinitions: () => [
          { id: 'com.example.settings-plugin.dynamic', type: 'text', label: 'Dynamic', defaultValue: 'new' }
        ] };
        const registration = context.settings.registerPage(page);
        page.id = 'changed';
        await registration.ready;
        assert.equal(await context.settings.get('com.example.settings-plugin.dynamic'), 'saved');
        registration.dispose(); registration.dispose();
      } }),
      getCorePluginStylesUrl: () => ''
    },
    '../../src/api/nativeEditor': { isTauriEditorRuntime: () => true, nativeEditorApi: {} },
    '../../src/api/nativePlugin': { isTauriPluginRuntime: () => true, nativePluginApi: {
      invokeRenderer: envelope => {
        calls.push(envelope.request);
        if (envelope.request.method === 'settings.registerPage') {
          return new Promise(resolve => { completeRegistration = () => resolve({ ok: true }); });
        }
        return Promise.resolve({ ok: true, result: envelope.request.method === 'settings.get' ? 'saved' : undefined });
      },
      getSettingValue: () => assert.fail('SDK reads must use current host definitions.')
    } },
    '../../src/api/electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron access.') }
  });
  const activation = runtime.ensurePluginActivated(contribution);
  await flush();
  assert.equal(calls.filter(call => call.method === 'settings.registerPage').length, 1);
  assert.equal(calls[0].params.page.id, 'com.example.settings-plugin.page');
  assert.equal(calls[0].params.page.definitions[0].id, 'com.example.settings-plugin.dynamic');
  completeRegistration(); await activation; await flush();
  assert.equal(calls.filter(call => call.method === 'settings.unregisterPage').length, 1);
  assert.equal(calls.find(call => call.method === 'settings.unregisterPage').params.id, 'com.example.settings-plugin.page');
  assert.equal(calls.find(call => call.method === 'settings.get').params.fieldId, 'com.example.settings-plugin.dynamic');
  await runtime.deactivatePlugin(contribution.pluginId); await flush();
  assert.equal(calls.filter(call => call.method === 'runtimeReady').length, 1);
});

test('设置注册期间停用插件会等待迟到注册，再注销且只释放一次', async () => {
  const calls = [];
  let completeRegistration;
  const contribution = { pluginId: 'com.example.settings-plugin', pluginName: 'Settings plugin',
    pluginVersion: '1.0.0', trustLevel: 'standard', entryUrl: '', stylesUrl: '',
    commands: [], views: [], settings: [], statusBar: [] };
  const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
    '../sdk/disposables': load('../../plugin/sdk/disposables.ts', {}),
    './icons': { createIconsApi: () => ({}) },
    './corePluginAssets': {
      loadCorePluginModule: async () => ({ activate: context => {
        context.settings.registerPage({ id: 'com.example.settings-plugin.page', title: 'Settings' });
      } }),
      getCorePluginStylesUrl: () => ''
    },
    '../../src/api/nativeEditor': { isTauriEditorRuntime: () => true, nativeEditorApi: {} },
    '../../src/api/nativePlugin': { isTauriPluginRuntime: () => true, nativePluginApi: {
      invokeRenderer: envelope => {
        calls.push(envelope.request);
        if (envelope.request.method === 'settings.registerPage') {
          return new Promise(resolve => { completeRegistration = () => resolve({ ok: true }); });
        }
        return Promise.resolve({ ok: true });
      }
    } },
    '../../src/api/electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron access.') }
  });
  await runtime.ensurePluginActivated(contribution);
  await runtime.deactivatePlugin(contribution.pluginId);
  assert.equal(calls.filter(call => call.method === 'settings.registerPage').length, 1);
  completeRegistration(); await flush();
  assert.equal(calls.filter(call => call.method === 'settings.unregisterPage').length, 1);
  assert.equal(calls.find(call => call.method === 'settings.unregisterPage').params.id, 'com.example.settings-plugin.page');
  await runtime.deactivatePlugin(contribution.pluginId); await flush();
  assert.equal(calls.filter(call => call.method === 'settings.unregisterPage').length, 1);
});

test('设置注册失败通过 ready 保留稳定错误，释放时跳过注销', async () => {
  const calls = [];
  const contribution = { pluginId: 'com.example.settings-plugin', pluginName: 'Settings plugin',
    pluginVersion: '1.0.0', trustLevel: 'standard', entryUrl: '', stylesUrl: '',
    commands: [], views: [], settings: [], statusBar: [] };
  const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
    '../sdk/disposables': load('../../plugin/sdk/disposables.ts', {}),
    './icons': { createIconsApi: () => ({}) },
    './corePluginAssets': {
      loadCorePluginModule: async () => ({ activate: async context => {
        const registration = context.settings.registerPage({ id: 'other.page', title: 'Undeclared' });
        await assert.rejects(registration.ready, error => error.code === 'PLUGIN_CONTRIBUTION_NOT_DECLARED');
        registration.dispose(); registration.dispose();
      } }),
      getCorePluginStylesUrl: () => ''
    },
    '../../src/api/nativeEditor': { isTauriEditorRuntime: () => true, nativeEditorApi: {} },
    '../../src/api/nativePlugin': { isTauriPluginRuntime: () => true, nativePluginApi: {
      invokeRenderer: async envelope => {
        calls.push(envelope.request);
        return envelope.request.method === 'runtimeReady' || envelope.request.method === 'runtimeFailed'
          ? { ok: true }
          : { ok: false, error: { code: 'PLUGIN_CONTRIBUTION_NOT_DECLARED', message: 'Undeclared' } };
      }
    } },
    '../../src/api/electronCompat': { getElectronApi: () => assert.fail('Unexpected Electron access.') }
  });
  await runtime.ensurePluginActivated(contribution);
  await runtime.deactivatePlugin(contribution.pluginId); await flush();
  assert.equal(calls.filter(call => call.method === 'settings.registerPage').length, 1);
  assert.equal(calls.filter(call => call.method === 'runtimeReady').length, 1);
});

const envelope = { pluginId: 'com.example.plugin', request: { protocolVersion: 1,
  requestId: 'request-1', runtimeId: '', method: 'workspace.getRepository', params: {}, deadline: 20000 } };

test('RPC 保留现有信封且只调用 Tauri command', async () => {
  const reply = { protocolVersion: 1, requestId: 'request-1', ok: true, result: { id: 'repo' } };
  const api = rpcFixture(async (command, args) => {
    assert.equal(command, 'plugin_invoke_renderer'); assert.equal(args.envelope, envelope); return reply;
  });
  assert.equal(await api.invokeRenderer(envelope), reply);
});

test('RPC 拒绝不匹配的响应 ID、协议版本和破损错误结构', async () => {
  for (const reply of [null, { protocolVersion: 2, requestId: 'request-1', ok: true },
    { protocolVersion: 1, requestId: 'other', ok: true },
    { protocolVersion: 1, requestId: 'request-1', ok: 'true' },
    { protocolVersion: 1, requestId: 'request-1', ok: false }]) {
    await assert.rejects(rpcFixture(async () => reply).invokeRenderer(envelope),
      error => error.code === 'PLUGIN_RPC_RESPONSE_INVALID');
  }
});

test('RPC 宿主拒绝保留错误码，传输失败保留 cause', async () => {
  const reply = { protocolVersion: 1, requestId: 'request-1', ok: false,
    error: { code: 'PLUGIN_PERMISSION_DENIED', message: 'denied' } };
  assert.equal(await rpcFixture(async () => reply).invokeRenderer(envelope), reply);
  await assert.rejects(rpcFixture(async () => { throw 'connection lost'; }).invokeRenderer(envelope),
    error => error.code === 'PLUGIN_RPC_TRANSPORT_FAILED' && error.cause === 'connection lost');
});

test('普通插件 Tauri SDK 路由回归不触碰 Electron fallback', async () => {
  const calls = [];
  const pluginId = 'com.example.third-party';
  const contribution = {
    pluginId,
    pluginName: 'Third-party fixture',
    pluginVersion: '1.0.0',
    trustLevel: 'standard',
    runtimeId: 'runtime-third-party',
    entryUrl: '',
    stylesUrl: '',
    commands: [], views: [], settings: [], statusBar: []
  };
  const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
    '../sdk/disposables': load('../../plugin/sdk/disposables.ts', {}),
    './icons': { createIconsApi: () => ({}) },
    './corePluginAssets': {
      loadCorePluginModule: async () => ({
        activate: async context => {
          assert.equal((await context.workspace.getRepository()).id, 'repo-1');
          assert.equal((await context.windows.list())[0].id, 'window-1');
          assert.equal((await context.editor.getActiveDocument()).path, 'README.md');
          await context.windows.open({ kind: 'workbench' });
          await context.windows.update('window-1', { title: 'Updated' });
          await context.windows.focus('window-1');
          await context.windows.close('window-1');
          assert.equal(await context.settings.get('field-1'), 'saved');
          assert.equal(await context.storage.get('key-1'), 'value-1');
          await context.storage.set('key-1', 'value-2');
          await context.storage.delete('key-1');
          await context.filesystem.stat('README.md');
          await context.editor.openFile('README.md');
          await context.editor.revealRange('README.md', { start: 0, end: 1 });
          await context.editor.closeTab('README.md');
          await context.editor.closeTabs(['README.md']);
          await context.editor.closeAllTabs();
          await context.editor.applyTextChange('README.md', 'old', 'new');
          await context.notifications.show('ready');
          assert.equal(await context.dialogs.confirm({ message: 'Continue?' }), true);
          const network = await context.network.request('https://example.com/api', {
            method: 'POST',
            headers: { 'x-fixture': 'yes' },
            body: '{"ready":true}'
          });
          assert.equal(network.status, 200);
          context.logger.info('fixture-ready');
        }
      }),
      getCorePluginStylesUrl: () => ''
    },
    '../../src/api/nativeEditor': {
      isTauriEditorRuntime: () => true,
      nativeEditorApi: {
        getActiveDocument: async () => ({ path: 'README.md', content: 'text' }),
        onDidChangeActiveDocument: () => () => undefined
      }
    },
    '../../src/api/nativePlugin': {
      isTauriPluginRuntime: () => true,
      nativePluginApi: {
        invokeRenderer: async envelope => {
          calls.push(envelope.request);
          const result = {
            'workspace.getRepository': { id: 'repo-1' },
            'window.list': [{ id: 'window-1' }],
            'settings.get': 'saved',
            'storage.get': { found: true, value: 'value-1' },
            'editor.getActiveDocument': { path: 'README.md', content: 'text' },
            'filesystem.stat': { kind: 'file', path: 'README.md' },
            'dialogs.confirm': true,
            'network.request': { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }
          }[envelope.request.method];
          return { protocolVersion: 1, requestId: envelope.request.requestId, ok: true, result };
        }
      }
    },
    '../../src/api/electronCompat': {
      getElectronApi: () => assert.fail('Tauri plugin SDK must not touch Electron fallback.')
    }
  });
  await runtime.ensurePluginActivated(contribution);
  const methods = calls.map(request => request.method);
  assert.deepEqual(methods, [
    'workspace.getRepository', 'window.list', 'editor.getActiveDocument', 'window.open', 'window.update',
    'window.focus', 'window.close', 'settings.get', 'storage.get', 'storage.set', 'storage.delete',
    'filesystem.stat', 'editor.openFile', 'editor.revealRange', 'editor.closeTab', 'editor.closeTabs',
    'editor.closeAllTabs', 'editor.applyTextChange',
    'notifications.show', 'dialogs.confirm', 'network.request', 'log', 'runtimeReady'
  ]);
  assert.equal(JSON.stringify(calls.find(request => request.method === 'network.request').params), JSON.stringify({
    url: 'https://example.com/api', method: 'POST', headers: { 'x-fixture': 'yes' }, body: '{"ready":true}'
  }));
  await runtime.deactivatePlugin(pluginId);
});

test('Tauri 私有存储 SDK 区分缺失值和 null，文件操作保留完整参数与运行身份', async () => {
  const calls = [];
  const contribution = { pluginId:'com.example.filesystem-contract', pluginName:'Filesystem contract',
    pluginVersion:'1.0.0', trustLevel:'standard', runtimeId:'runtime-filesystem', entryUrl:'', stylesUrl:'',
    commands:[], views:[], settings:[], statusBar:[] };
  const runtime = load('../../plugin/runtime/rendererRuntime.ts', {
    '../sdk/disposables': load('../../plugin/sdk/disposables.ts',{}),
    './icons': { createIconsApi:()=>({}) },
    './corePluginAssets': { getCorePluginStylesUrl:()=>'', loadCorePluginModule:async()=>({
      activate:async context=>{
        assert.equal(await context.storage.get('missing'),undefined);
        assert.equal(await context.storage.get('null'),null);
        await context.storage.set('null',null);
        await context.storage.delete('missing');
        await context.filesystem.listFiles({directory:'notes',recursive:true,extensions:['.md'],limit:2});
        await context.filesystem.listEntries('notes');
        await context.filesystem.readText('notes/note.md');
        await context.filesystem.stat('notes/note.md');
        await context.filesystem.writeText('notes/note.md','new',{expectedContent:'old'});
        await context.filesystem.createFile('notes/new.md','text');
        await context.filesystem.createDirectory('notes/deep',{recursive:true});
        await context.filesystem.copy('notes/new.md','notes/copy.md');
        await context.filesystem.move('notes/copy.md','notes/moved.md');
        await context.filesystem.rename('notes/moved.md','renamed.md');
        await context.filesystem.encrypt('notes/new.md','passphrase');
        await context.filesystem.decrypt('notes/new.md','passphrase');
        await context.filesystem.delete('notes/deep',{recursive:true});
      }
    }) },
    '../../src/api/nativeEditor': {isTauriEditorRuntime:()=>true,nativeEditorApi:{}},
    '../../src/api/nativePlugin': {isTauriPluginRuntime:()=>true,nativePluginApi:{invokeRenderer:async envelope=>{
      calls.push(envelope);
      const result = envelope.request.method==='storage.get'
        ? envelope.request.params.key==='missing' ? {found:false} : {found:true,value:null}
        : undefined;
      return {protocolVersion:1,requestId:envelope.request.requestId,ok:true,result};
    }}},
    '../../src/api/electronCompat': {getElectronApi:()=>assert.fail('Unexpected Electron access.')}
  });
  await runtime.ensurePluginActivated(contribution);
  const filesystem = calls.filter(call=>call.request.method.startsWith('filesystem.'));
  assert.equal(filesystem.length,13);
  for(const call of calls) {
    assert.equal(call.pluginId,contribution.pluginId);
    assert.equal(call.request.runtimeId,contribution.runtimeId);
  }
  assert.equal(JSON.stringify(filesystem.find(call=>call.request.method==='filesystem.writeText').request.params),
    JSON.stringify({path:'notes/note.md',content:'new',options:{expectedContent:'old'}}));
  assert.equal(JSON.stringify(filesystem.find(call=>call.request.method==='filesystem.listFiles').request.params),
    JSON.stringify({options:{directory:'notes',recursive:true,extensions:['.md'],limit:2}}));
  assert.equal(calls.find(call=>call.request.method==='storage.set').request.params.value,null);
  await runtime.deactivatePlugin(contribution.pluginId);
});
