/**
 * 文件说明：维护插件管理界面需要的可序列化摘要、加载状态和操作 Action。
 */

import { ref } from 'vue';
import { defineStore } from 'pinia';

import { pluginApi } from '@/api/plugin';
import { useDockingThreeStore } from '@/store/dockingThree';
import type {
  PluginContributionSummary,
  PluginPermissionId,
  PluginSettingValue,
  PluginSummary
} from '../../plugin/sdk';
import type {
  PluginContributionsChangedEvent,
  PluginRegistryChangedEvent,
  PluginSettingChangedEvent,
  PluginSettingsValues,
  IpcEventMap
} from '@/types/ipc';
import {
  deactivateAllPlugins,
  deactivatePlugin,
  ensurePluginActivated,
  executePluginCommand
} from '../../plugin/runtime/rendererRuntime';

/** 控制刷新插件贡献时是否同步启动当前渲染进程的插件运行时。 */
export interface RefreshPluginContributionsOptions {
  activateRuntime?: boolean;
}

/** 控制 Plugin Store 是否管理当前窗口中的插件渲染运行时。 */
export interface InitializePluginStoreOptions {
  activateRuntime?: boolean;
}

/** 管理已安装插件和插件运行状态。 */
export const usePluginStore = defineStore('plugins', () => {
  const plugins = ref<PluginSummary[]>([]);
  const contributions = ref<PluginContributionSummary[]>([]);
  const settings = ref<Record<string, PluginSettingsValues>>({});
  const loading = ref(false);
  const error = ref<string | undefined>();
  let initialized = false;
  let activateRuntimeOnSync = true;
  let contributionSyncQueue = Promise.resolve();
  let registrySyncQueue = Promise.resolve();
  let eventDisposers: Array<() => void> = [];

  /** 将异常转换成管理界面可展示的错误文本。 */
  function readErrorMessage(reason: unknown): string {
    if (typeof reason === 'string' && /^PLUGIN_[A-Z_]+$/.test(reason)) {
      return reason;
    }
    return reason instanceof Error ? reason.message : 'PLUGIN_OPERATION_FAILED';
  }

  /** 创建插件设置页在 Store 中的稳定索引键。 */
  function settingsKey(pluginId: string, settingId: string): string {
    return `${pluginId}:${settingId}`;
  }

  /** 从主进程刷新插件摘要。 */
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = undefined;

    try {
      plugins.value = await pluginApi.list();
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
    } finally {
      loading.value = false;
    }
  }

  /** 从主进程刷新当前已运行插件的工作台贡献。 */
  async function refreshContributions(
    options: RefreshPluginContributionsOptions = {}
  ): Promise<void> {
    try {
      contributions.value = await pluginApi.listContributions();
      if (options.activateRuntime ?? activateRuntimeOnSync) {
        await Promise.all(
          contributions.value
            .filter(contribution => contribution.entryUrl.trim().length > 0)
            .map(ensurePluginActivated)
        );
      }
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
    }
  }

  /** 将插件主动打开视图请求映射到 DockingThree 的实例 Action。 */
  async function handleViewOpenRequested(request: {
    pluginId: string;
    viewType: string;
    instanceId?: string;
    url?: string;
  }): Promise<void> {
    let contribution = contributions.value.find(item => item.pluginId === request.pluginId);

    if (!contribution) {
      await refreshContributions();
      contribution = contributions.value.find(item => item.pluginId === request.pluginId);
    }

    const view = contribution?.views.find(item => item.type === request.viewType);

    if (view) {
      useDockingThreeStore().openPluginView(request.pluginId, view, request.instanceId, request.url);
    }
  }

  /** 打开指定插件声明为启动显示的全部视图。 */
  function openStartupViews(pluginId: string): void {
    const contribution = contributions.value.find(item => item.pluginId === pluginId);

    contribution?.views
      .filter(view => view.openOnStartup)
      .forEach(view => useDockingThreeStore().openPluginView(pluginId, view));
  }

  /** 将插件主动关闭视图请求映射到 DockingThree，并触发 provider 销毁。 */
  function handleViewCloseRequested(request: {
    pluginId: string;
    viewType: string;
    instanceId?: string;
  }): void {
    useDockingThreeStore().closePluginView(request.pluginId, request.viewType, request.instanceId);
  }

  /** 将任意插件字段变化合并到当前窗口的设置页缓存。 */
  function handleSettingChanged(event: PluginSettingChangedEvent): void {
    const key = settingsKey(event.pluginId, event.settingId);
    const currentValues = settings.value[key] ?? {};

    settings.value = {
      ...settings.value,
      [key]: { ...currentValues, [event.fieldId]: event.value }
    };
  }

  /** 串行刷新运行时设置页等声明贡献，避免重复激活插件。 */
  function handleContributionsChanged(_event: PluginContributionsChangedEvent): void {
    contributionSyncQueue = contributionSyncQueue
      .then(() => refreshContributions({ activateRuntime: activateRuntimeOnSync }))
      .catch((reason: unknown) => {
        error.value = readErrorMessage(reason);
      });
  }

  /** 从主进程权威状态重新装载插件，并按窗口职责重建渲染运行时。 */
  async function synchronizeRegistry(event: PluginRegistryChangedEvent): Promise<void> {
    if (activateRuntimeOnSync) {
      useDockingThreeStore().closePluginViews(event.pluginId);
      await deactivatePlugin(event.pluginId);
    }

    await refresh();
    await refreshContributions();

    if (
      activateRuntimeOnSync
      && plugins.value.some(plugin => plugin.id === event.pluginId && plugin.enabled)
    ) {
      openStartupViews(event.pluginId);
    }
  }

  /** 串行处理插件注册表事件，避免连续修改造成跨窗口刷新竞态。 */
  function handleRegistryChanged(event: PluginRegistryChangedEvent): void {
    registrySyncQueue = registrySyncQueue
      .then(() => synchronizeRegistry(event))
      .catch((reason: unknown) => {
        error.value = readErrorMessage(reason);
      });
  }

  /** 仅把当前运行代际的原生网页元数据同步到对应工作台标签。 */
  function handleWebViewerChanged(event: IpcEventMap['plugin:webViewerChanged']): void {
    const contribution = contributions.value.find(item => item.pluginId === event.pluginId);
    if (!contribution || !event.runtimeId || contribution.runtimeId !== event.runtimeId) return;
    for (const tab of event.tabs) {
      useDockingThreeStore().updateWebViewerTabMetadata(event.pluginId, tab);
    }
  }

  /** 注册全部插件状态与设置事件，当前窗口生命周期内只执行一次。 */
  function initialize(options: InitializePluginStoreOptions = {}): void {
    if (initialized) {
      return;
    }

    activateRuntimeOnSync = options.activateRuntime ?? true;
    initialized = true;
    eventDisposers = [
      pluginApi.onSettingChanged(handleSettingChanged),
      pluginApi.onContributionsChanged(handleContributionsChanged),
      pluginApi.onRegistryChanged(handleRegistryChanged)
      ,pluginApi.onRuntimeChanged(() => { void refresh(); })
    ];

    if (activateRuntimeOnSync) {
      eventDisposers.push(
        pluginApi.onViewOpenRequested(request => {
          void handleViewOpenRequested(request);
        }),
        pluginApi.onViewCloseRequested(handleViewCloseRequested),
        pluginApi.onWebViewerChanged(handleWebViewerChanged)
      );
    }
  }

  /** 从主进程读取插件设置页，并缓存当前页的字段值。 */
  async function loadSettings(
    pluginId: string,
    settingId: string
  ): Promise<PluginSettingsValues | undefined> {
    try {
      const values = await pluginApi.getSettings(pluginId, settingId);
      settings.value = { ...settings.value, [settingsKey(pluginId, settingId)]: values };
      return values;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return undefined;
    }
  }

  /** 读取插件设置页中的单个字段，并复用 Store 内的设置快照。 */
  async function getSettingValue(
    pluginId: string,
    settingId: string,
    fieldId: string
  ): Promise<PluginSettingValue | undefined> {
    const key = settingsKey(pluginId, settingId);
    const values = settings.value[key] ?? await loadSettings(pluginId, settingId);
    return values?.[fieldId];
  }

  /** 更新插件设置字段并同步主进程返回的页面快照。 */
  async function setSetting(
    pluginId: string,
    settingId: string,
    fieldId: string,
    value: PluginSettingValue
  ): Promise<PluginSettingsValues | undefined> {
    try {
      const values = await pluginApi.setSetting({ pluginId, settingId, fieldId, value });
      settings.value = { ...settings.value, [settingsKey(pluginId, settingId)]: values };
      return values;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return undefined;
    }
  }

  /** 安装插件并将新插件追加到当前摘要。 */
  async function install(sourcePath: string): Promise<PluginSummary | undefined> {
    loading.value = true;
    error.value = undefined;

    try {
      const plugin = await pluginApi.install({ sourcePath });
      plugins.value = [...plugins.value, plugin];
      return plugin;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  /** 更新插件版本并同步主进程返回的权威摘要。 */
  async function update(id: string, sourcePath: string): Promise<PluginSummary | undefined> {
    loading.value = true;
    error.value = undefined;

    try {
      const updatedPlugin = await pluginApi.update({ id, sourcePath });
      plugins.value = plugins.value.map(plugin => plugin.id === id ? updatedPlugin : plugin);
      await refreshContributions();
      return updatedPlugin;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  /** 回滚插件版本并同步主进程返回的权威摘要。 */
  async function rollback(id: string): Promise<PluginSummary | undefined> {
    loading.value = true;
    error.value = undefined;

    try {
      const rolledBackPlugin = await pluginApi.rollback(id);
      plugins.value = plugins.value.map(plugin => plugin.id === id ? rolledBackPlugin : plugin);
      await refreshContributions();
      return rolledBackPlugin;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  /** 更新插件启用状态并同步主进程返回的权威摘要。 */
  async function setEnabled(id: string, enabled: boolean): Promise<PluginSummary | undefined> {
    loading.value = true;
    error.value = undefined;

    try {
      if (!enabled && activateRuntimeOnSync) {
        useDockingThreeStore().closePluginViews(id);
        await deactivatePlugin(id);
      }
      const updatedPlugin = await pluginApi.setEnabled({ id, enabled });
      plugins.value = plugins.value.map(plugin => plugin.id === id ? updatedPlugin : plugin);
      await refreshContributions();
      if (enabled && activateRuntimeOnSync) {
        openStartupViews(id);
      }
      return updatedPlugin;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  /** 更新插件已授权权限并同步主进程返回的权威摘要。 */
  async function setPermissions(
    id: string,
    permissions: PluginSummary['grantedPermissions']
  ): Promise<PluginSummary | undefined> {
    loading.value = true;
    error.value = undefined;
    const plugin = plugins.value.find(candidate => candidate.id === id);
    const shouldRestoreViews = plugin?.enabled === true;

    if (shouldRestoreViews && activateRuntimeOnSync) {
      useDockingThreeStore().closePluginViews(id);
      await deactivatePlugin(id);
    }

    try {
      const updatedPlugin = await pluginApi.setPermissions({ id, permissions });
      plugins.value = plugins.value.map(plugin => plugin.id === id ? updatedPlugin : plugin);
      await refreshContributions();

      if (updatedPlugin.enabled && activateRuntimeOnSync) {
        openStartupViews(id);
      }

      return updatedPlugin;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);

      if (shouldRestoreViews && activateRuntimeOnSync) {
        await refreshContributions();
        openStartupViews(id);
      }

      return undefined;
    } finally {
      loading.value = false;
    }
  }

  /** 更新单项插件权限，并复用统一的权限持久化和运行时重启流程。 */
  async function setPermissionEnabled(
    id: string,
    permissionId: PluginPermissionId,
    enabled: boolean
  ): Promise<PluginSummary | undefined> {
    const plugin = plugins.value.find(candidate => candidate.id === id);

    if (!plugin) {
      return undefined;
    }

    const permissions = enabled
      ? [...new Set([...plugin.grantedPermissions, permissionId])]
      : plugin.grantedPermissions.filter(candidate => candidate !== permissionId);

    return setPermissions(id, permissions);
  }

  /** 卸载插件并移除当前摘要。 */
  async function uninstall(id: string): Promise<boolean> {
    loading.value = true;
    error.value = undefined;

    try {
      if (activateRuntimeOnSync) {
        useDockingThreeStore().closePluginViews(id);
        await deactivatePlugin(id);
      }
      await pluginApi.uninstall(id);
      plugins.value = plugins.value.filter(plugin => plugin.id !== id);
      contributions.value = contributions.value.filter(plugin => plugin.pluginId !== id);
      settings.value = Object.fromEntries(
        Object.entries(settings.value).filter(([key]) => !key.startsWith(`${id}:`))
      );
      return true;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return false;
    } finally {
      loading.value = false;
    }
  }

  /** 执行指定插件命令并将失败转换成 Store 错误。 */
  async function executeCommand(pluginId: string, commandId: string): Promise<boolean> {
    error.value = undefined;

    try {
      await pluginApi.executeCommand(pluginId, commandId);
      await executePluginCommand(pluginId, commandId);
      return true;
    } catch (reason: unknown) {
      error.value = readErrorMessage(reason);
      return false;
    }
  }

  /** 校验并路由 Markdown 外部链接到已启用的公开 WebViewer 多实例视图。 */
  async function openExternalLink(value: string): Promise<boolean> {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      return false;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }

    if (contributions.value.length === 0) {
      await refreshContributions();
    }

    const target = contributions.value
      .flatMap(contribution => contribution.views.map(view => ({ contribution, view })))
      .find(({ view }) => view.multiple === true && view.capabilities?.includes('webViewer'));

    if (!target) {
      return false;
    }

    useDockingThreeStore().openPluginView(
      target.contribution.pluginId,
      target.view,
      undefined,
      url.href
    );
    return true;
  }

  /** 释放主进程插件视图事件监听，避免工作台重复挂载时累积回调。 */
  function dispose(): void {
    initialized = false;
    eventDisposers.forEach(disposeEvent => disposeEvent());
    eventDisposers = [];
    if (activateRuntimeOnSync) {
      void deactivateAllPlugins();
    }
  }

  return {
    plugins,
    contributions,
    settings,
    loading,
    error,
    refresh,
    refreshContributions,
    loadSettings,
    getSettingValue,
    setSetting,
    install,
    update,
    rollback,
    setEnabled,
    setPermissions,
    setPermissionEnabled,
    uninstall,
    executeCommand,
    openExternalLink,
    handleViewOpenRequested,
    initialize,
    dispose
  };
});
