/**
 * 文件说明：定义应用级通知视图和 Pinia 队列共享的数据结构。
 */

import type { PluginNotificationType } from '../../../plugin/sdk';

export interface ApplicationNotification {
  id: string;
  message: string;
  type: PluginNotificationType;
  duration: number;
  title?: string;
  source?: string;
}

export interface ApplicationNotificationOptions {
  type?: PluginNotificationType;
  duration?: number;
  title?: string;
  source?: string;
}
