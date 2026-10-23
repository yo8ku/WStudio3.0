/**
 * 文件说明：通过 Tauri 调用 Rust AI 流式聊天服务。
 */
import type {
  AiChatBridgeEvent,
  AiChatBridgeStartRequest
} from '@/AIchat/interface';

import { nativeApi } from './native';
import type { NativeEventSubscription } from './nativeEvents';

export const aiChatApi = {
  /** 启动一个由主进程负责网络请求的流式会话。 */
  start(request: AiChatBridgeStartRequest): Promise<void> {
    return nativeApi.aiChat.start(request);
  },

  /** 暂停主进程侧的流事件转发。 */
  pause(sessionId: string): Promise<void> {
    return nativeApi.aiChat.pause(sessionId);
  },

  /** 恢复主进程侧的流事件转发。 */
  resume(sessionId: string): Promise<void> {
    return nativeApi.aiChat.resume(sessionId);
  },

  /** 取消主进程侧的网络请求。 */
  cancel(sessionId: string): Promise<void> {
    return nativeApi.aiChat.cancel(sessionId);
  },

  /** 订阅主进程推送的流事件。 */
  onEvent(listener: (event: AiChatBridgeEvent) => void): NativeEventSubscription {
    return nativeApi.aiChat.onEvent(listener);
  }
};
