/**
 * 文件说明：提供插件注册项统一释放所需的 Disposable 与 DisposableStore。
 */

import type { Disposable } from './types';

/** 管理插件生命周期内创建的可释放资源。 */
export class DisposableStore implements Disposable {
  private readonly disposables = new Set<Disposable>();

  private disposed = false;

  /** 添加资源；Store 已释放时立即释放传入资源。 */
  add<T extends Disposable>(disposable: T): T {
    if (this.disposed) {
      disposable.dispose();
      return disposable;
    }

    this.disposables.add(disposable);
    return disposable;
  }

  /** 释放全部资源并清空集合；即使单项失败也会继续释放其它资源。 */
  clear(): void {
    let firstError: unknown;

    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch (error: unknown) {
        firstError ??= error;
      }
    }

    this.disposables.clear();

    if (firstError) {
      throw firstError;
    }
  }

  /** 标记 Store 为已释放并释放所有注册项。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clear();
  }
}
