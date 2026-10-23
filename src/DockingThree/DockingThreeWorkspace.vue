<script setup lang="ts">
/**
 * 文件说明：挂载停靠布局、持久插件实例，并统一渲染拖拽热区与拖拽头像。 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import type { ComponentPublicInstance } from 'vue';

const dragVerticalIcon = 'icon icon-drag-vertical';
import DockingThreeNode from '@/DockingThree/DockingThreeNode.vue';
import { collectPluginPanelTabs, createPluginPanelTargets, pluginPanelTargetsKey } from '@/DockingThree/pluginPanelTargets';
import { useDockingThreeStore } from '@/store/dockingThree';
import { useThemeStore } from '@/store/theme';

const dockingThreeStore = useDockingThreeStore();
const themeStore = useThemeStore();
const AsyncPluginViewPanel = defineAsyncComponent(() => import('@/components/plugin/PluginViewPanel.vue'));
const pluginPanelTargets = createPluginPanelTargets();
provide(pluginPanelTargetsKey, pluginPanelTargets);
const pluginTabs = computed(() => collectPluginPanelTabs(dockingThreeStore.root));
const pluginParkingElement = ref<HTMLElement>();
const renderedRoot = computed(() => dockingThreeStore.previewRoot ?? dockingThreeStore.root);
const usingPreviewLayout = computed(() => Boolean(dockingThreeStore.previewRoot));
const centerPreview = computed(() =>
  dockingThreeStore.externalCenterPreview ?? dockingThreeStore.sidebarCenterPreview
);
const workspaceElement = ref<Element>();
let resizeObserver: ResizeObserver | undefined;

type WorkspaceRefTarget = Element | ComponentPublicInstance | null;

/**
 * 把 Vuetify 组件实例或原生元素统一解析成真实的工作区根节点。
 */
function setWorkspaceElement(target: WorkspaceRefTarget): void {
  if (target instanceof Element) {
    workspaceElement.value = target;
    return;
  }

  const componentElement = target && '$el' in target
    ? target.$el
    : undefined;

  workspaceElement.value = componentElement instanceof Element
    ? componentElement
    : undefined;
}

/**
 * 把停靠工作区当前可用宽度同步给 Store，统一换算默认侧边栏宽度。
 */
function syncWorkspaceWidth(): void {
  const nextWidth = workspaceElement.value?.getBoundingClientRect().width;

  if (!nextWidth) {
    return;
  }

  dockingThreeStore.syncWorkspaceWidth(nextWidth);
}

/**
 * 将全局指针移动转发到停靠布局 Store，用于更新拖拽预览。 */
function handleDocumentPointerMove(event: PointerEvent): void {
  dockingThreeStore.handlePointerMove(event.clientX, event.clientY);
}

/**
 * 在指针释放或取消时结束当前停靠拖拽。 */
function handleDocumentPointerUp(): void {
  dockingThreeStore.handlePointerUp();
}

/**
 * 挂载阶段注册全局指针事件，保证拖拽跨区域仍可追踪。 */
onMounted(() => {
  syncWorkspaceWidth();
  resizeObserver = new ResizeObserver(() => {
    syncWorkspaceWidth();
  });

  if (workspaceElement.value) {
    resizeObserver.observe(workspaceElement.value);
  }

  document.addEventListener('pointermove', handleDocumentPointerMove, true);
  document.addEventListener('pointerup', handleDocumentPointerUp, true);
  document.addEventListener('pointercancel', handleDocumentPointerUp, true);
});

/**
 * 卸载阶段清理全局事件，并取消遗留拖拽状态。 */
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  document.removeEventListener('pointermove', handleDocumentPointerMove, true);
  document.removeEventListener('pointerup', handleDocumentPointerUp, true);
  document.removeEventListener('pointercancel', handleDocumentPointerUp, true);
  dockingThreeStore.cancelDrag();
});
</script>

<template>
  <v-sheet
    :ref="setWorkspaceElement"
    class="docking-three-workspace rounded-0"
    :class="{
      'docking-three-workspace--dragging': dockingThreeStore.isDragging,
      'docking-three-workspace--modern': themeStore.modernUiEnabled
    }"
    color="transparent"
    elevation="0"
  >
    <DockingThreeNode
      :node="renderedRoot"
      :preview-layout="usingPreviewLayout"
    />

    <!-- 收起分组时暂存 DOM，实例只随真实标签关闭而卸载。 -->
    <section ref="pluginParkingElement" hidden>
      <template v-for="tab in pluginTabs" :key="tab.id">
        <Teleport
          :to="pluginPanelTargets.targets.get(tab.id) ?? pluginParkingElement"
          :disabled="!pluginPanelTargets.targets.has(tab.id)"
        >
          <!-- S = 持久插件视图 -->
          <AsyncPluginViewPanel
            :plugin-id="tab.pluginId ?? ''"
            :view-type="tab.viewType ?? ''"
            :title="tab.title"
            :instance-id="tab.viewInstanceId ?? tab.id"
            :view-initial-url="tab.viewInitialUrl"
          />
          <!-- E = 持久插件视图 -->
        </Teleport>
      </template>
    </section>

    <Transition name="dock-center-preview">
      <div
        v-if="centerPreview"
        class="docking-three-center-preview"
        :aria-label="`预览 ${centerPreview.title}`"
        :style="{
          left: `${centerPreview.left}px`,
          top: `${centerPreview.top}px`,
          width: `${centerPreview.width}px`,
          height: `${centerPreview.height}px`
        }"
      />
    </Transition>

    <Transition name="dock-indicator">
      <div
        v-if="dockingThreeStore.dropIndicator"
        class="docking-three-drop-indicator"
        :style="{
          left: `${dockingThreeStore.dropIndicator.left}px`,
          top: `${dockingThreeStore.dropIndicator.top}px`,
          width: `${dockingThreeStore.dropIndicator.width}px`,
          height: `${dockingThreeStore.dropIndicator.height}px`,
        }"
      />
    </Transition>

    <Transition name="dock-avatar">
      <div
        v-if="dockingThreeStore.dragAvatar"
        class="docking-three-drag-avatar"
        :style="{
          left: `${dockingThreeStore.dragAvatar.left}px`,
          top: `${dockingThreeStore.dragAvatar.top}px`
        }"
      >
        <span class="docking-three-drag-avatar__icon" :class="dragVerticalIcon" />
        <span class="docking-three-drag-avatar__title">
          {{ dockingThreeStore.dragAvatar.title }}
        </span>
      </div>
    </Transition>
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;
@use '@/UIStyles/Default/workspace' as default-workspace;
@use '@/UIStyles/ModernUI/workspace' as modern-ui-workspace;

@include default-workspace.apply;
@include modern-ui-workspace.apply;

.docking-three-workspace {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.docking-three-workspace--dragging,
.docking-three-workspace--dragging * {
  cursor: default !important;
}

.docking-three-drop-indicator {
  position: fixed;
  pointer-events: none;
  z-index: 9999;
  background: var(--ws-dockPreview-lineActive);
  box-shadow: 0 0 0 1px var(--ws-dockPreview-border);
  transition:
    left 0.1s ease,
    top 0.1s ease,
    height 0.1s ease;
}

.docking-three-center-preview {
  position: fixed;
  pointer-events: none;
  z-index: 9998;
  border: $docking-preview-outline-width solid var(--ws-dockPreview-border);
  border-radius: var(--docking-workspace-panel-radius);
  background: var(--ws-dockPreview-panel);
  box-shadow: 0 0 0 1px var(--ws-dockPreview-border), 0 0 1rem var(--ws-dockPreview-shadow);
  opacity: 0.9;
}

.dock-center-preview-enter-active,
.dock-center-preview-leave-active {
  transition: opacity 0.1s ease;
}

.dock-center-preview-enter-from,
.dock-center-preview-leave-to {
  opacity: 0;
}

.dock-indicator-enter-active {
  transition: opacity 0.1s ease;
}

.dock-indicator-leave-active {
  transition: opacity 0.08s ease;
}

.dock-indicator-enter-from,
.dock-indicator-leave-to {
  opacity: 0;
}

.docking-three-drag-avatar {
  position: fixed;
  display: flex;
  align-items: center;
  gap: $spacing-2xs;
  min-height: $icon-rail-tab-height;
  max-width: 14rem;
  padding-inline: $spacing-xs;
  padding-block: $spacing-2xs;
  pointer-events: none;
  z-index: 10000;
  border: 1px solid var(--ws-dragAvatar-border);
  border-radius: $radius-xs;
  background: var(--ws-dragAvatar-background);
  box-shadow: 0 $spacing-2xs $spacing-sm var(--ws-dockPreview-shadow);
  color: var(--ws-dragAvatar-foreground);
  transform: translate($spacing-xs, $spacing-xs);
}

.docking-three-drag-avatar__icon {
  @include flex-center;
  flex: none;
  width: $font-size-md;
  height: $font-size-md;
  color: var(--ws-dragAvatar-mutedForeground);
}

.docking-three-drag-avatar__icon {
  display: block;
  width: 100%;
  height: 100%;
}

.docking-three-drag-avatar__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: $font-size-sm;
  line-height: 1;
}

.dock-avatar-enter-active,
.dock-avatar-leave-active {
  transition: opacity 0.1s ease;
}

.dock-avatar-enter-from,
.dock-avatar-leave-to {
  opacity: 0;
}
</style>
