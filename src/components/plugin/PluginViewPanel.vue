<!-- 文件说明：为插件视图提供真实宿主 DOM 容器和统一生命周期。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import { pluginApi } from '@/api/plugin';
import pluginViewShadowStyles from '@/assets/styles/plugin-view-shadow.scss?inline';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import { usePluginStore } from '@/store/plugin';
import {
  mountPluginView,
  type PluginMountedView
} from '../../../plugin/runtime/rendererRuntime';

const props = defineProps<{
  pluginId: string;
  viewType: string;
  title: string;
  instanceId: string;
  viewInitialUrl?: string;
}>();

const pluginStore = usePluginStore();
const shadowHostElement = ref<HTMLElement | null>(null);
const contentElement = ref<HTMLElement | null>(null);
const scrollbarTopInset = ref(0);
const error = ref<string>();
let mountedView: PluginMountedView | undefined;
let mountedRuntimeId: string | undefined;
let unmounted = false;

const contribution = computed(() => pluginStore.contributions.find(
  candidate => candidate.pluginId === props.pluginId
));

/** 创建插件专属 Shadow DOM，并返回保持公开 SDK 类型不变的真实挂载节点。 */
function createIsolatedViewRoot(): HTMLElement | undefined {
  const host = shadowHostElement.value;
  if (!host) return undefined;

  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  const baseStyleElement = document.createElement('style');
  const root = document.createElement('main');
  baseStyleElement.dataset.wstudioPluginBaseStyle = '';
  baseStyleElement.textContent = pluginViewShadowStyles;
  root.className = 'plugin-view-panel__content';
  root.dataset.pluginId = props.pluginId;
  root.dataset.pluginViewType = props.viewType;
  root.setAttribute('aria-label', props.title);
  shadowRoot.replaceChildren(baseStyleElement, root);
  contentElement.value = root;
  return root;
}

/** 读取插件声明的滚动条顶部预留，避免粘性头部覆盖宿主滑块。 */
function syncScrollbarTopInset(root: HTMLElement): void {
  const topInset = getComputedStyle(root)
    .getPropertyValue('--wstudio-plugin-scrollbar-top-inset')
    .trim();
  const match = /^(\d+(?:\.\d+)?)px$/i.exec(topInset);
  scrollbarTopInset.value = match ? Number.parseFloat(match[1]) : 0;
}

/** 在 DockingThree 提供的隔离 HTMLElement 中调用插件视图入口。 */
async function mountView(): Promise<void> {
  await nextTick();
  const root = createIsolatedViewRoot();
  const pluginContribution = contribution.value;
  if (!root || !pluginContribution) {
    error.value = 'PLUGIN_CONTRIBUTION_NOT_FOUND';
    return;
  }

  try {
    mountedRuntimeId = pluginContribution.runtimeId;
    const nextMountedView = await mountPluginView({
      contribution: pluginContribution,
      viewType: props.viewType,
      instanceId: props.instanceId,
      root,
      initialUrl: props.viewInitialUrl
    });

    if (unmounted) {
      nextMountedView.dispose();
      return;
    }

    mountedView = nextMountedView;
    await nextTick();

    if (!unmounted && contentElement.value === root) {
      syncScrollbarTopInset(root);
    }
  } catch (reason: unknown) {
    if (!unmounted) {
      error.value = reason instanceof Error ? reason.message : 'PLUGIN_VIEW_MOUNT_FAILED';
      console.error('[plugin] Failed to mount view.', {
        pluginId: props.pluginId,
        viewType: props.viewType,
        reason
      });
    }
  }
}

/** 释放插件 onClose 生命周期和全部视图级订阅。 */
function unmountView(): void {
  unmounted = true;
  void pluginApi.disposeView({
    pluginId: props.pluginId,
    viewType: props.viewType,
    instanceId: props.instanceId,
    initialUrl: props.viewInitialUrl,
    runtimeId: mountedRuntimeId
  }).catch(() => undefined);
  mountedView?.dispose();
  mountedView = undefined;
  scrollbarTopInset.value = 0;
  contentElement.value = null;
  shadowHostElement.value?.shadowRoot?.replaceChildren();
}

onMounted(() => {
  void mountView();
});

onBeforeUnmount(unmountView);

const panelProps = {
  color: 'transparent',
  elevation: 0,
  rounded: 0
} as const;
</script>

<template>
  <v-sheet
    class="plugin-view-panel rounded-0 d-flex flex-column"
    v-bind="panelProps"
  >
    <section
      ref="shadowHostElement"
      class="plugin-view-panel__shadow-host"
    />

    <p
      v-if="error"
      class="plugin-view-panel__error"
    >
      {{ error }}
    </p>

    <!-- S = 宿主纵向滚动条 -->
    <WorkbenchVerticalScrollbar
      :scroller-element="contentElement"
      :top-inset="scrollbarTopInset"
    />
    <!-- E = 宿主纵向滚动条 -->
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.plugin-view-panel {
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  @include flex-column;
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  color: var(--ws-editor-foreground);
  user-select: none;
}

.plugin-view-panel__shadow-host {
  position: relative;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
  margin: 0;
  overflow: hidden;
}

.plugin-view-panel__error {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: $spacing-sm;
  color: var(--ws-errorForeground);
  font-size: $font-size-xs;
}
</style>
