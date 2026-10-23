/**
 * 文件说明：封装渲染进程可用的类型安全窗口控制接口。
 */
import { nativeApi } from './native';
import type { PluginDialogRequest } from '../../plugin/sdk';

export const windowApi = {
  /** 通过标准工作台窗口打开宿主设置。 */
  openSettings(navigationId?: string): Promise<void> {
    return nativeApi.workbench.openSettings(navigationId);
  },
  /** 在当前工作台旁打开无边框搜索子窗口。 */
  openSearchWindow(): Promise<void> {
    return nativeApi.workbench.openSearch();
  },
  /** 请求宿主工作台打开搜索结果文件。 */
  openSearchResult(relativePath: string): Promise<boolean> {
    return nativeApi.workbench.openSearchResult(relativePath);
  },
  /** 请求在主工作台标签页中打开设置。 */
  openSettingsTab(navigationId?: string): Promise<void> {
    return nativeApi.workbench.openSettingsTab(navigationId);
  },
  /** 通过宿主工作台能力打开仓库管理子窗口。 */
  openRepositoryManager(
    request?: Extract<PluginDialogRequest, { kind: 'repository-manager' }>
  ): Promise<void> {
    return nativeApi.workbench.openRepositoryManager(request);
  },
  takeRepositoryManagerRequest(): Promise<Extract<PluginDialogRequest, { kind: 'repository-manager' }> | undefined> {
    return nativeApi.workbench.takeRepositoryManagerRequest();
  },
  /** 订阅 Tauri 仓库管理窗口的定向请求。 */
  onRepositoryManagerRequest(
    listener: (request: Extract<PluginDialogRequest, { kind: 'repository-manager' }>) => void
  ): () => void {
    return nativeApi.workbench.onRepositoryManagerRequest(listener);
  },
  /** 监听设置窗口转为主工作台标签页的请求。 */
  onOpenSettingsTabRequested(listener: (event: { navigationId?: string }) => void): () => void {
    return nativeApi.workbench.onOpenSettingsTabRequested(listener);
  },
  /** 监听独立设置窗口的创建、显示和销毁状态。 */
  onSettingsWindowState(listener: (event: { open: boolean }) => void): () => void {
    return nativeApi.workbench.onSettingsWindowState(listener);
  },
  /** 最小化当前窗口。 */
  minimize(): Promise<void> {
    return nativeApi.window.minimize();
  },


  /** 报告用户交互，供宿主延后空闲内存回收。 */
  reportActivity(): Promise<void> {
    return nativeApi.window.reportActivity();
  },

  /** 切换当前窗口的最大化状态。 */
  toggleMaximize(): Promise<boolean> {
    return nativeApi.window.toggleMaximize();
  },

  /** 关闭当前窗口。 */
  close(): Promise<void> {
    return nativeApi.window.close();
  },

  /** 查询当前窗口是否已最大化。 */
  isMaximized(): Promise<boolean> {
    return nativeApi.window.isMaximized();
  },

  /** 读取当前窗口左上角的屏幕坐标。 */
  getPosition(): Promise<[x: number, y: number]> {
    return nativeApi.window.getPosition();
  },

  /** 将当前窗口移动到指定屏幕坐标。 */
  moveTo(x: number, y: number): Promise<void> {
    return nativeApi.window.moveTo(x, y);
  }
};
