/**
 * 文件说明：集中管理应用级消息通知队列及插件通知事件订阅。
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { pluginApi } from '@/api/plugin';
import type {
  ApplicationNotification,
  ApplicationNotificationOptions
} from '@/components/notification/types';

const DEFAULT_DURATION = 4_000;
const MIN_DURATION = 1_000;
const MAX_DURATION = 30_000;

/** 提供全局通知队列及标准通知操作。 */
export const useNotificationStore = defineStore('notifications', () => {
  const notifications = ref<ApplicationNotification[]>([]);
  const current = computed(() => notifications.value[0]);
  let sequence = 0;
  let disposePluginListener: (() => void) | undefined;

  /** 添加一条经过规范化的应用通知。 */
  function show(message: string, options: ApplicationNotificationOptions = {}): string {
    sequence += 1;
    const id = `notification-${Date.now()}-${sequence}`;
    const duration = Math.min(
      Math.max(Math.trunc(options.duration ?? DEFAULT_DURATION), MIN_DURATION),
      MAX_DURATION
    );

    notifications.value.push({
      id,
      message: message.trim(),
      type: options.type ?? 'normal',
      duration,
      ...(options.title?.trim() ? { title: options.title.trim() } : {}),
      ...(options.source?.trim() ? { source: options.source.trim() } : {})
    });
    return id;
  }

  /** 添加普通通知。 */
  function normal(message: string, options: Omit<ApplicationNotificationOptions, 'type'> = {}): string {
    return show(message, { ...options, type: 'normal' });
  }

  /** 添加警告通知。 */
  function warning(message: string, options: Omit<ApplicationNotificationOptions, 'type'> = {}): string {
    return show(message, { ...options, type: 'warning' });
  }

  /** 添加错误通知。 */
  function error(message: string, options: Omit<ApplicationNotificationOptions, 'type'> = {}): string {
    return show(message, { ...options, type: 'error' });
  }

  /** 从队列中移除指定通知。 */
  function dismiss(id: string): void {
    notifications.value = notifications.value.filter(notification => notification.id !== id);
  }

  /** 清空全部应用通知。 */
  function clear(): void {
    notifications.value = [];
  }

  /** 订阅插件通知事件，工作台生命周期内只创建一个监听器。 */
  function initialize(): void {
    if (disposePluginListener) {
      return;
    }

    disposePluginListener = pluginApi.onNotificationRequested(request => {
      show(request.message, {
        type: request.type,
        duration: request.duration,
        title: request.title,
        source: request.pluginName
      });
    });
  }

  /** 释放插件通知事件监听并清空队列。 */
  function dispose(): void {
    disposePluginListener?.();
    disposePluginListener = undefined;
    clear();
  }

  return {
    notifications,
    current,
    show,
    normal,
    warning,
    error,
    dismiss,
    clear,
    initialize,
    dispose
  };
});
