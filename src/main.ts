/** 文件说明：初始化 Tauri 窗口中的 Vue 工作台、插件组件和应用设置。 */
import { createPinia } from 'pinia';
import { createApp, defineCustomElement } from 'vue';

import App from './App.vue';
import './assets/iconfont/style.css';
import './assets/styles/main.scss';
import './iconfont/index.scss';
import { vuetify } from './plugins/vuetify';
import { useThemeStore } from './store/theme';
import { useNotePropertyTypesStore } from './store/notePropertyTypes';
import { useShortcutStore } from './store/shortcuts';
import { registerPluginIconSources } from '../plugin/runtime/icons';
import WsDropdownMenu from './components/WsDropdownMenu/WsDropdownMenu.vue';
import hostIconSources from 'virtual:ws-svg-icons';
import { loadWindowView } from './views/windowView';
import { migrateLegacyAppSettings } from './api/appSettings';
import { APP_SETTING_KEYS } from './types/appSettings';

/** 注册可由普通插件按稳定名称使用的宿主真实 SVG 图标。 */
function registerHostPluginIcons(): void {
  registerPluginIconSources(hostIconSources);
}

/** 注册供隔离插件使用的宿主下拉菜单自定义元素。 */
function registerHostComponents(): void {
  const tagName = 'ws-dropdown-menu';
  if (!customElements.get(tagName)) {
    customElements.define(tagName, defineCustomElement(WsDropdownMenu));
  }
}

async function bootstrap(): Promise<void> {
  registerHostPluginIcons();
  registerHostComponents();
  const app = createApp(App);
  const pinia = createPinia();

  app.use(pinia);
  app.use(vuetify);
  app.component('WsDropdownMenu', WsDropdownMenu);

  // 页面模块与偏好迁移同时加载，设置读取依赖迁移但彼此不依赖。
  const viewReady = loadWindowView().catch(error => {
    console.error('Failed to preload the window view.', error);
  });
  try {
    await migrateLegacyAppSettings([
      APP_SETTING_KEYS.activeThemeId,
      APP_SETTING_KEYS.modernUiEnabled,
      APP_SETTING_KEYS.notePropertyTypes,
      APP_SETTING_KEYS.inlineChatSelectedModel,
      APP_SETTING_KEYS.shortcutBindings
    ]);
  } catch (error) {
    console.error('Failed to migrate application settings.', error);
  }
  const themeStore = useThemeStore(pinia);
  const notePropertyTypesStore = useNotePropertyTypesStore(pinia);
  const shortcutStore = useShortcutStore(pinia);
  const results = await Promise.allSettled([
    themeStore.initializeThemeSystem(),
    viewReady
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.error('Failed to initialize application settings.', result.reason);
  }

  app.mount('#app');

  // 这些设置有内存默认值，不阻塞首屏；挂载后再恢复持久化值。
  void Promise.allSettled([
    notePropertyTypesStore.initialize(),
    shortcutStore.initialize()
  ]).then(initializationResults => {
    for (const result of initializationResults) {
      if (result.status === 'rejected') {
        console.error('Failed to initialize deferred application settings.', result.reason);
      }
    }
  });
}

void bootstrap();
