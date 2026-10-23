/**
 * 文件说明：解析当前渲染窗口的工作台显示模式。
 */

export type WStudioWindowMode = 'workbench' | 'tab' | 'blank';
export type WStudioWindowPage = 'settings' | 'repository-manager' | 'search' | 'empty';
export interface InitialPluginView { pluginId: string; viewType: string; instanceId?: string; url?: string; }

function getWindowSearchParams(): URLSearchParams | undefined {
  return typeof window === 'undefined'
    ? undefined
    : new URLSearchParams(window.location.search);
}

/** 返回主进程写入 URL 的可信窗口显示模式。 */
export function getWindowMode(): WStudioWindowMode {
  const mode = getWindowSearchParams()?.get('windowMode');
  return mode === 'tab' || mode === 'blank' ? mode : 'workbench';
}

/** 返回 blank 窗口需要填充的页面类型；未知值保持空白，避免宿主渲染未声明内容。 */
export function getWindowPage(): WStudioWindowPage {
  const page = getWindowSearchParams()?.get('windowPage');
  return page === 'settings' || page === 'repository-manager' || page === 'search' ? page : 'empty';
}

/** 返回基础窗口标题；标题仅作为受信页面文本使用，不参与 DOM 拼接。 */
export function getInitialWindowTitle(): string | undefined {
  const value = getWindowSearchParams()?.get('windowTitle')?.trim();
  return value || undefined;
}

/** 返回主进程为独立插件窗口指定的初始声明视图。 */
export function getInitialPluginView(): InitialPluginView | undefined {
  const params = getWindowSearchParams();
  if (!params) return undefined;
  const pluginId = params.get('pluginId')?.trim();
  const viewType = params.get('pluginViewType')?.trim();
  const instanceId = params.get('pluginInstanceId')?.trim();
  const url = params.get('pluginUrl')?.trim();
  return pluginId && viewType
    ? {
        pluginId,
        viewType,
        ...(instanceId ? { instanceId } : {}),
        ...(url ? { url } : {})
      }
    : undefined;
}

/** 返回主进程为标准工作台窗口指定的初始设置导航项。 */
export function getInitialSettingsNavigationId(): string | undefined {
  const value = getWindowSearchParams()?.get('settingsNavigationId')?.trim();
  return value || undefined;
}

/** 返回标准工作台是否应在首帧创建设置标签。 */
export function shouldOpenInitialSettingsTab(): boolean {
  return getWindowSearchParams()?.get('initialSettingsTab') === '1';
}

/** 返回独立工作台窗口启动时需要打开的工作区相对路径。 */
export function getInitialFilePath(): string | undefined {
  const value = getWindowSearchParams()?.get('initialFilePath')?.trim();
  return value || undefined;
}
