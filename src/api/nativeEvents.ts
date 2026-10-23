/** 文件说明：统一 Tauri 异步事件订阅、页面卸载释放及稳定诊断错误。 */
import { listen } from '@tauri-apps/api/event';

/** 保留同步释放接口，同时允许流式请求等待原生监听完成注册。 */
export type NativeEventSubscription = (() => void) & { readonly ready: Promise<void> };

/** 为异步宿主监听绑定业务作用域和当前页面生命周期。 */
export function createNativeSubscription<T>(
  name: string,
  register: (listener: (payload: T) => void) => Promise<() => void>,
  listener: (payload: T) => void
): NativeEventSubscription {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  const page = typeof window === 'undefined' ? undefined : window;

  /** 清除一次宿主监听；先清空引用以保证异常后也不会重复释放。 */
  const release = (dispose: () => void): void => {
    try {
      dispose();
    } catch (cause: unknown) {
      console.warn('[tauri-events]', { code: 'NATIVE_EVENT_RELEASE_FAILED', event: name, cause });
    }
  };
  const stop = (): void => {
    if (disposed) return;
    disposed = true;
    page?.removeEventListener('pagehide', stop);
    const dispose = unlisten;
    unlisten = undefined;
    if (dispose) release(dispose);
  };
  page?.addEventListener('pagehide', stop, { once: true });
  const ready = Promise.resolve().then(() => {
    if (disposed) return undefined;
    return register(payload => {
      if (!disposed) listener(payload);
    });
  }).then(dispose => {
    if (!dispose) return;
    if (disposed) release(dispose);
    else unlisten = dispose;
  }).catch((cause: unknown) => {
    if (!disposed) {
      console.warn('[tauri-events]', { code: 'NATIVE_EVENT_SUBSCRIBE_FAILED', event: name, cause });
    }
    stop();
    throw cause;
  });
  // 普通事件订阅保持原有诊断行为；等待 ready 的调用方仍能获得注册失败。
  void ready.catch(() => undefined);
  return Object.assign(stop, { ready });
}

/** 订阅 Tauri 领域事件，返回幂等的释放函数。 */
export function subscribeNativeEvent<T>(
  name: string,
  listener: (payload: T) => void
): NativeEventSubscription {
  return createNativeSubscription<T>(name,
    handler => listen<T>(name, event => handler(event.payload)), listener);
}
