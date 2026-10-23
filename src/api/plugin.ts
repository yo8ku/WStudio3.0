/**
 * 文件说明：封装渲染进程对插件安装、启停和卸载能力的类型安全调用。
 */

import type {
  PluginInstallRequest,
  PluginUpdateRequest,
  PluginSetPermissionsRequest,
  PluginSetEnabledRequest,
  PluginSetSettingRequest,
  PluginSettingsValues,
  PluginViewRequest,
  WebViewerContextMenuRequest
} from '@/types/ipc';
import type {
  PluginContributionSummary,
  PluginDialogRequest,
  PluginDialogResponse,
  PluginSummary
} from '../../plugin/sdk';

import { nativeApi } from './native';
import { nativePluginApi } from './nativePlugin';

export const pluginApi = {
  /** 订阅原生网页标题、图标和加载状态，供工作台同步标签元数据。 */
  onWebViewerChanged(
    listener: Parameters<typeof nativePluginApi.onWebViewerChanged>[0]
  ): () => void {
    return nativePluginApi.onWebViewerChanged(listener);
  },
  /** 运行就绪状态仅刷新摘要，避免再次停用/激活造成事件循环。 */
  onRuntimeChanged(listener: (event: { pluginId: string }) => void): () => void {
    return nativeApi.plugins.onRuntimeChanged(listener);
  },
  /** 通过 Rust 宿主的原生选择器获取插件包路径。 */
  selectPackagePath(): Promise<string | undefined> {
    return nativePluginApi.pickPluginPackagePath();
  },

  /** 读取已安装插件摘要。 */
  list(): Promise<PluginSummary[]> {
    return nativeApi.plugins.list();
  },

  /** 读取当前已运行插件的工作台贡献。 */
  listContributions(): Promise<PluginContributionSummary[]> {
    return nativeApi.plugins.listContributions();
  },

  /** 读取指定插件设置页的规范化字段值。 */
  getSettings(pluginId: string, settingId: string): Promise<PluginSettingsValues> {
    return nativeApi.plugins.getSettings(pluginId, settingId);
  },

  /** 请求主进程校验并持久化插件设置字段。 */
  setSetting(request: PluginSetSettingRequest): Promise<PluginSettingsValues> {
    return nativeApi.plugins.setSetting(request);
  },

  /** 安装用户选择的插件目录或 `.wstudio-plugin` 文件。 */
  install(request: PluginInstallRequest): Promise<PluginSummary> {
    return nativeApi.plugins.install(request);
  },

  /** 更新已安装插件并保留当前版本用于回滚。 */
  update(request: PluginUpdateRequest): Promise<PluginSummary> {
    return nativeApi.plugins.update(request);
  },

  /** 回滚到插件更新前保留的版本。 */
  rollback(id: string): Promise<PluginSummary> {
    return nativeApi.plugins.rollback(id);
  },

  /** 设置插件启用状态。 */
  setEnabled(request: PluginSetEnabledRequest): Promise<PluginSummary> {
    return nativeApi.plugins.setEnabled(request);
  },

  /** 更新插件已授权权限。 */
  setPermissions(request: PluginSetPermissionsRequest): Promise<PluginSummary> {
    return nativeApi.plugins.setPermissions(request);
  },

  /** 卸载插件及其运行数据。 */
  uninstall(id: string): Promise<void> {
    return nativeApi.plugins.uninstall(id);
  },

  /** 请求主进程校验插件命令声明和运行状态。 */
  executeCommand(pluginId: string, commandId: string): Promise<void> {
    return nativeApi.plugins.executeCommand(pluginId, commandId);
  },

  /** 返回当前工作台对插件声明式对话框的处理结果。 */
  respondDialog(response: PluginDialogResponse): Promise<boolean> {
    return nativePluginApi.respondDialog(response);
  },

  /** 立即释放指定插件视图实例持有的宿主资源。 */
  disposeView(request: PluginViewRequest): Promise<void> {
    return nativeApi.plugins.disposeView(request);
  },


  /** 请求宿主执行网页标签页专用菜单动作。 */
  executeWebViewerContextMenu(request: WebViewerContextMenuRequest): Promise<boolean> {
    return nativePluginApi.executeWebViewerContextMenu(request);
  },


  /** 监听插件主动打开视图事件。 */
  onViewOpenRequested(
    listener: Parameters<typeof nativePluginApi.onViewOpenRequested>[0]
  ): () => void {
    return nativePluginApi.onViewOpenRequested(listener);
  },

  /** 监听插件主动关闭视图事件。 */
  onViewCloseRequested(
    listener: Parameters<typeof nativePluginApi.onViewCloseRequested>[0]
  ): () => void {
    return nativePluginApi.onViewCloseRequested(listener);
  },

  /** 监听插件请求显示应用级通知。 */
  onNotificationRequested(
    listener: Parameters<typeof nativeApi.plugins.onNotificationRequested>[0]
  ): () => void {
    return nativeApi.plugins.onNotificationRequested(listener);
  },

  /** 监听插件请求显示声明式工作台对话框。 */
  onDialogRequested(
    listener: (request: PluginDialogRequest) => void
  ): () => void {
    return nativePluginApi.onDialogRequested(listener);
  },

  /** 监听任意插件设置字段变化。 */
  onSettingChanged(
    listener: Parameters<typeof nativeApi.plugins.onSettingChanged>[0]
  ): () => void {
    return nativeApi.plugins.onSettingChanged(listener);
  },

  /** 监听插件运行时设置页等声明贡献变化。 */
  onContributionsChanged(
    listener: Parameters<typeof nativeApi.plugins.onContributionsChanged>[0]
  ): () => void {
    return nativeApi.plugins.onContributionsChanged(listener);
  },

  /** 监听插件注册表中的安装、版本、启用状态与权限变化。 */
  onRegistryChanged(
    listener: Parameters<typeof nativeApi.plugins.onRegistryChanged>[0]
  ): () => void {
    return nativeApi.plugins.onRegistryChanged(listener);
  }
};
