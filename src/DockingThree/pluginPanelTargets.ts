/** 文件说明：协调工作区持久插件面板与可重建停靠容器，保持实例生命周期独立于布局树。 */
import { shallowReactive } from 'vue';
import type { ComponentPublicInstance, InjectionKey } from 'vue';
import type { DockingThreeNode, DockingThreeTab } from './types';

export interface PluginPanelTargets {
  targets: ReadonlyMap<string, HTMLElement>;
  register(tabId: string, element: HTMLElement): () => void;
}

export const pluginPanelTargetsKey: InjectionKey<PluginPanelTargets> = Symbol('docking-plugin-panel-targets');

/** 容器注销只影响自己的登记，避免旧分组卸载时清除新分组的目标。 */
export function createPluginPanelTargets(): PluginPanelTargets {
  const targets = shallowReactive(new Map<string, HTMLElement>());
  return {
    targets,
    register(tabId, element) {
      targets.set(tabId, element);
      return () => {
        if (targets.get(tabId) === element) targets.delete(tabId);
      };
    }
  };
}

type PluginTargetRef = (target: Element | ComponentPublicInstance | null) => void;

/** 分组 ref 使用同一回调，卸载旧容器时保留新容器登记。 */
export function createPluginPanelTargetRefs(registry: PluginPanelTargets | undefined) {
  const callbacks = new Map<string, PluginTargetRef>();
  return {
    getPluginTargetRef(tabId: string): PluginTargetRef {
      const existing = callbacks.get(tabId);
      if (existing) return existing;
      let current: HTMLElement | undefined;
      let unregister: (() => void) | undefined;
      const callback: PluginTargetRef = target => {
        const element = target instanceof HTMLElement ? target : undefined;
        if (current === element) return;
        unregister?.();
        current = element;
        unregister = element ? registry?.register(tabId, element) : undefined;
        if (!element) callbacks.delete(tabId);
      };
      callbacks.set(tabId, callback);
      return callback;
    },
    disposePluginTargetRefs(): void {
      for (const callback of callbacks.values()) callback(null);
      callbacks.clear();
    }
  };
}

/** 从实际布局收集仍打开的插件标签；预览树不负责创建或释放实例。 */
export function collectPluginPanelTabs(node: DockingThreeNode): DockingThreeTab[] {
  return node.type === 'group'
    ? node.tabs.filter(tab => tab.kind === 'plugin')
    : node.children.flatMap(collectPluginPanelTabs);
}
