<script setup lang="ts">
/**
 * 文件说明：渲染左右侧活动栏图标组与内置操作插槽，并负责标签提示、选中与拖拽入口。 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  type ComponentPublicInstance,
  type CSSProperties
} from 'vue';

import type {
  DockingThreeActivityRailBounds,
  DockingThreeIndicatorBounds,
  DockingThreeRailAction,
  DockingThreeSidebarPosition
} from '@/DockingThree/types';
import { useDockingThreeStore } from '@/store/dockingThree';
import { useThemeStore } from '@/store/theme';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import { WORKBENCH_TOOLTIP_OPEN_DELAY } from '@/utils/workbenchTooltip';

interface WorkbenchIconRailTab {
  id: string;
  title: string;
  iconUrl?: string;
  iconClass?: string;
  action?: DockingThreeRailAction;
}

interface WorkbenchIconRailSection {
  id: string;
  tabs: readonly WorkbenchIconRailTab[];
}

interface WorkbenchIconRailProps {
  position: DockingThreeSidebarPosition;
  sections: readonly WorkbenchIconRailSection[];
  activeTabId: string;
  sidebarOpen: boolean;
  disabled?: boolean;
  highlightActiveWhenCollapsed?: boolean;
  separatorSide?: 'left' | 'right' | null;
  showSeparator?: boolean;
}

const props = withDefaults(defineProps<WorkbenchIconRailProps>(), {
  disabled: false,
  highlightActiveWhenCollapsed: true,
  separatorSide: null,
  showSeparator: false
});

const emit = defineEmits<{
  select: [tabId: string];
  action: [action: DockingThreeRailAction];
  'tab-pointerdown': [tabId: string, event: PointerEvent];
}>();

const dockingThreeStore = useDockingThreeStore();
const themeStore = useThemeStore();
const railElement = ref<HTMLElement>();
let resizeObserver: ResizeObserver | undefined;
let syncFrame = 0;
let lastBounds: DockingThreeActivityRailBounds | undefined;

type RailRefTarget = Element | ComponentPublicInstance | null;

function setRailElement(target: RailRefTarget): void {
  if (target instanceof Element) {
    railElement.value = target as HTMLElement;
    return;
  }

  const componentElement = target && '$el' in target ? target.$el : undefined;
  railElement.value = componentElement instanceof HTMLElement ? componentElement : undefined;
}

function resolveElementBounds(element: HTMLElement): DockingThreeIndicatorBounds {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function areBoundsEqual(
  previous: DockingThreeActivityRailBounds | undefined,
  next: DockingThreeActivityRailBounds
): boolean {
  if (!previous) {
    return false;
  }

  const scalarKeys: Array<keyof DockingThreeActivityRailBounds> = [
    'left', 'top', 'right', 'bottom', 'width', 'height'
  ];
  if (scalarKeys.some((key) => previous[key] !== next[key])) {
    return false;
  }

  return previous.itemBounds.length === next.itemBounds.length
    && previous.itemBounds.every((item, index) => {
      const nextItem = next.itemBounds[index];
      return nextItem !== undefined
        && item.left === nextItem.left
        && item.top === nextItem.top
        && item.width === nextItem.width
        && item.height === nextItem.height;
    });
}

function syncRailBounds(): void {
  const element = railElement.value;
  if (!element) {
    return;
  }

  // 预览占位项会暂时改变图标位置，但拖拽命中仍应基于真实图标边界。
  if (dockingThreeStore.activityRailPreview?.position === props.position) {
    return;
  }

  const rect = element.getBoundingClientRect();
  const nextBounds: DockingThreeActivityRailBounds = {
    position: props.position,
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
    itemBounds: Array.from(
      element.querySelectorAll<HTMLElement>('.workbench-icon-rail__tab')
    ).map(resolveElementBounds)
  };

  if (areBoundsEqual(lastBounds, nextBounds)) {
    return;
  }

  lastBounds = nextBounds;
  dockingThreeStore.setActivityRailBounds(props.position, nextBounds);
}

function scheduleRailBoundsSync(): void {
  if (syncFrame !== 0) {
    window.cancelAnimationFrame(syncFrame);
  }

  syncFrame = window.requestAnimationFrame(() => {
    syncFrame = 0;
    syncRailBounds();
  });
}

const activityRailPreview = computed(() => {
  const preview = dockingThreeStore.activityRailPreview;
  return preview?.position === props.position ? preview : undefined;
});

interface WorkbenchIconRailPreviewSlot {
  sectionIndex: number;
  tabIndex: number;
}

const activityRailPreviewSlot = computed<WorkbenchIconRailPreviewSlot | undefined>(() => {
  const preview = activityRailPreview.value;
  if (!preview) {
    return undefined;
  }

  let remainingIndex = Math.max(0, preview.insertionIndex);
  for (const [sectionIndex, section] of props.sections.entries()) {
    if (remainingIndex <= section.tabs.length) {
      return {
        sectionIndex,
        tabIndex: remainingIndex
      };
    }
    remainingIndex -= section.tabs.length;
  }

  if (props.sections.length === 0) {
    return {
      sectionIndex: 0,
      tabIndex: 0
    };
  }

  const lastSectionIndex = props.sections.length - 1;
  return {
    sectionIndex: lastSectionIndex,
    tabIndex: props.sections[lastSectionIndex]?.tabs.length ?? 0
  };
});

function shouldRenderPreview(sectionIndex: number, tabIndex: number): boolean {
  const slot = activityRailPreviewSlot.value;
  return slot?.sectionIndex === sectionIndex && slot.tabIndex === tabIndex;
}

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleRailBoundsSync);
  if (railElement.value) {
    resizeObserver.observe(railElement.value);
  }
  window.addEventListener('resize', scheduleRailBoundsSync);
  nextTick(scheduleRailBoundsSync);
});

onUpdated(() => {
  scheduleRailBoundsSync();
});

onBeforeUnmount(() => {
  if (syncFrame !== 0) {
    window.cancelAnimationFrame(syncFrame);
  }
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  window.removeEventListener('resize', scheduleRailBoundsSync);
  dockingThreeStore.clearActivityRailBounds(props.position);
});

const tooltipLocation = computed(() => props.separatorSide === 'left' ? 'left' : 'right');

/**
 * 基于图标资源地址生成 mask 样式，统一让图标跟随当前前景色着色。 */
function getIconStyle(iconUrl?: string): CSSProperties | undefined {
  if (!iconUrl) {
    return undefined;
  }

  const maskImage = `url("${iconUrl}")`;

  return {
    WebkitMaskImage: maskImage,
    maskImage
  };
}

/**
 * 判断指定标签是否为当前激活标签。 */
function isActive(tabId: string): boolean {
  return props.activeTabId === tabId;
}

/**
 * 计算标签是否应保持高亮，兼容侧边栏收起态的视觉策略。 */
function shouldHighlightActive(tabId: string): boolean {
  if (!isActive(tabId)) {
    return false;
  }

  return props.sidebarOpen || props.highlightActiveWhenCollapsed;
}

/**
 * 处理活动栏标签的指针按下，动作按钮不参与侧边栏标签拖拽。
 */
function handleTabPointerdown(tab: WorkbenchIconRailTab, event: PointerEvent): void {
  if (props.disabled) {
    return;
  }

  if (tab.action) {
    return;
  }

  emit('tab-pointerdown', tab.id, event);
}

/**
 * 处理活动栏标签点击，将设置等动作交给页面级容器处理。
 */
function handleTabClick(tab: WorkbenchIconRailTab): void {
  if (props.disabled) {
    return;
  }

  if (tab.action) {
    emit('action', tab.action);
    return;
  }

  emit('select', tab.id);
}

/**
 * 根据当前展开态生成按钮提示文案。 */
function getTabLabel(tab: WorkbenchIconRailTab): string {
  if (tab.action) {
    return tab.title;
  }

  return `切换到${tab.title}`;
}
</script>

<template>
  <v-sheet
    :ref="setRailElement"
    class="workbench-icon-rail"
    :data-activity-rail-position="props.position"
    :class="{
      'activityBar--left': props.position === 'left',
      'activityBar--right': props.position === 'right',
      'workbench-icon-rail--modern': themeStore.modernUiEnabled,
      'workbench-icon-rail--separator-right': separatorSide === 'right' && showSeparator
    }"
  >
    <template v-for="(section, index) in sections" :key="section.id">
      <div class="workbench-icon-rail__group">
        <template v-for="(tab, tabIndex) in section.tabs" :key="tab.id">
          <div
            v-if="shouldRenderPreview(index, tabIndex)"
            class="workbench-icon-rail__drop-preview"
            aria-hidden="true"
          />
          <WsTooltip
            :location="tooltipLocation"
            :open-delay="WORKBENCH_TOOLTIP_OPEN_DELAY"
            :text="getTabLabel(tab)"
          >
            <template #activator="{ props: tooltipProps }">
              <v-btn
                v-bind="tooltipProps"
                class="workbench-icon-rail__tab"
                :class="{ 'workbench-icon-rail__tab--active': shouldHighlightActive(tab.id) }"
                :disabled="props.disabled"
                density="comfortable"
                :aria-label="getTabLabel(tab)"
                :aria-pressed="tab.action ? false : isActive(tab.id) && sidebarOpen"
                variant="text"
                @pointerdown="handleTabPointerdown(tab, $event)"
                @click="handleTabClick(tab)"
              >
                <span
                  class="workbench-icon-rail__icon"
                  :class="[
                    tab.iconClass,
                    { 'workbench-icon-rail__icon--url': Boolean(tab.iconUrl) }
                  ]"
                  :style="getIconStyle(tab.iconUrl)"
                />
              </v-btn>
            </template>
          </WsTooltip>
        </template>
        <div
          v-if="shouldRenderPreview(index, section.tabs.length)"
          class="workbench-icon-rail__drop-preview"
          aria-hidden="true"
        />
      </div>

      <v-spacer v-if="index < sections.length - 1" />
    </template>

    <div
      v-if="sections.length === 0 && activityRailPreview"
      class="workbench-icon-rail__group"
      aria-hidden="true"
    >
      <div class="workbench-icon-rail__drop-preview" />
    </div>
    <template v-if="$slots.actions">
      <v-spacer />
      <slot name="actions" />
    </template>
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;
@use '@/UIStyles/Default/activityBar' as default-activity-bar;

@include default-activity-bar.apply;

.workbench-icon-rail {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: $icon-rail-width;
  min-width: $icon-rail-width;
  padding: $spacing-2xs;
  color: var(--ws-activityBar-foreground);
  background: var(--ws-activityBar-background) !important;
}

.workbench-icon-rail__drop-preview {
  box-sizing: border-box;
  display: block;
  width: calc(100% - #{$spacing-xs});
  min-width: calc(100% - #{$spacing-xs});
  height: $icon-rail-tab-height;
  min-height: $icon-rail-tab-height;
  margin-inline: auto;
  pointer-events: none;
  border: $docking-preview-outline-width solid var(--ws-dockPreview-border);
  border-radius: $radius-xs;
  background: var(--ws-dockPreview-panel);
  box-shadow: 0 0 0 1px var(--ws-dockPreview-border), 0 0 1rem var(--ws-dockPreview-shadow);
  opacity: 0.9;
}

.workbench-icon-rail__group {
  display: grid;
  gap: $spacing-xs;
}

.workbench-icon-rail__tab {
  @include flex-center;
  @include no-drag;
  width: calc(100% - #{$spacing-xs});
  min-width: calc(100% - #{$spacing-xs});
  min-height: $icon-rail-tab-height;
  height: $icon-rail-tab-height;
  margin-inline: auto;
  padding: 0;
  border-radius: $radius-xs;
  color: var(--ws-button-foreground);
}

.workbench-icon-rail__tab--active {
  color: var(--ws-button-activeForeground);
  background-color: var(--ws-button-activeBackground) ;
}

.workbench-icon-rail__tab:hover {
  color: var(--ws-button-hoverForeground);
  background-color: var(--ws-button-hoverBackground);
}

.workbench-icon-rail__icon {
  @include flex-center;
  width: $font-size-lg;
  height: $font-size-lg;
  font-size: $font-size-lg;
  line-height: 1;
  color: inherit;
  background: transparent;
}

.workbench-icon-rail__icon--url {
  background: currentColor;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
}
</style>

