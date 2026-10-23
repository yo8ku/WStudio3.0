/**
 * 文件说明：提供组件和宿主业务调用应用通知 Store 的轻量组合式接口。
 */

import { useNotificationStore } from '@/store/notification';
import type { ApplicationNotificationOptions } from './types';

/** 返回统一的普通、警告和错误通知操作。 */
export function useNotification() {
  const store = useNotificationStore();

  return {
    show: (message: string, options?: ApplicationNotificationOptions) => store.show(message, options),
    normal: (message: string, options?: Omit<ApplicationNotificationOptions, 'type'>) => (
      store.normal(message, options)
    ),
    warning: (message: string, options?: Omit<ApplicationNotificationOptions, 'type'>) => (
      store.warning(message, options)
    ),
    error: (message: string, options?: Omit<ApplicationNotificationOptions, 'type'>) => (
      store.error(message, options)
    ),
    dismiss: store.dismiss,
    clear: store.clear
  };
}
