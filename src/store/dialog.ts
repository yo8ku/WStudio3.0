/**
 * 文件说明：管理插件声明式对话框请求队列，并封装响应 IPC 与生命周期释放。
 */

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { pluginApi } from '@/api/plugin';
import type { PluginDialogRequest, PluginDialogResponse } from '../../plugin/sdk';

let unsubscribeDialogRequests: (() => void) | undefined;

/** 为工作台提供插件对话框队列和响应动作。 */
export const useDialogStore = defineStore('dialog', () => {
  const requests = ref<PluginDialogRequest[]>([]);
  const current = computed(() => requests.value[0]);
  const submitting = ref(false);
  const error = ref<string>();

  /** 将新请求加入队列并忽略重复广播。 */
  function enqueue(request: PluginDialogRequest): void {
    if (requests.value.some(item => item.requestId === request.requestId)) return;
    requests.value.push(request);
  }

  /** 启动主进程事件订阅。重复调用不会创建重复监听器。 */
  function start(): void {
    if (unsubscribeDialogRequests) return;
    unsubscribeDialogRequests = pluginApi.onDialogRequested(enqueue);
  }

  /** 释放事件订阅和当前窗口中的所有请求。 */
  function stop(): void {
    unsubscribeDialogRequests?.();
    unsubscribeDialogRequests = undefined;
    requests.value = [];
    submitting.value = false;
    error.value = undefined;
  }

  /** 发送响应并移除队首请求；首个有效窗口响应由主进程裁决。 */
  async function respond(response: PluginDialogResponse): Promise<void> {
    if (!current.value || current.value.requestId !== response.requestId || submitting.value) return;
    submitting.value = true;
    error.value = undefined;
    try {
      await pluginApi.respondDialog(response);
      requests.value.shift();
    } catch {
      error.value = '对话框响应失败，请重试。';
    } finally {
      submitting.value = false;
    }
  }

  /** 取消当前请求并通知主进程。 */
  async function cancelCurrent(): Promise<void> {
    const request = current.value;
    if (!request) return;
    await respond({ requestId: request.requestId, status: 'cancelled' });
  }

  return {
    requests,
    current,
    submitting,
    error,
    start,
    stop,
    respond,
    cancelCurrent
  };
});
