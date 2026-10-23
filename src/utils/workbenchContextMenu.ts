/**
 * 文件说明：协调工作台原生或 DOM 上下文菜单的请求与结果，保持调用方的 Promise 契约。
 */

import type { WorkbenchContextMenuRequest } from '@/types/ipc';
import { showNativeContextMenu, supportsNativeContextMenu } from '../api/nativeContextMenu';

export type WorkbenchContextMenuHandler = (
  request: WorkbenchContextMenuRequest
) => Promise<string | undefined>;

export interface WorkbenchContextMenuOptions {
  /** 强制使用工作台 DOM 菜单，适用于需要统一视觉样式的宿主菜单。 */
  preferNative?: boolean;
}

let handler: WorkbenchContextMenuHandler | undefined;

/** 注册当前工作台实例的菜单渲染器，并返回注销函数。 */
export function registerWorkbenchContextMenuHandler(
  nextHandler: WorkbenchContextMenuHandler
): () => void {
  handler = nextHandler;
  return () => {
    if (handler === nextHandler) handler = undefined;
  };
}

/** 请求显示工作台菜单；没有可用工作台时按取消处理。 */
export function requestWorkbenchContextMenu(
  request: WorkbenchContextMenuRequest,
  options: WorkbenchContextMenuOptions = {}
): Promise<string | undefined> {
  if (handler && options.preferNative !== false && supportsNativeContextMenu()) {
    return showNativeContextMenu(request);
  }
  return handler?.(request) ?? Promise.resolve(undefined);
}
