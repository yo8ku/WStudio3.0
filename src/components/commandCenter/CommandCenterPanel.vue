<script setup lang="ts">
/**
 * 文件说明：渲染命令中心浮层面板，并在工作区内提供可拖拽移动的命令列表。 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance
} from 'vue';

import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import type { CommandCenterItem } from '@/components/commandCenter/types';

const props = defineProps<{
  items: readonly CommandCenterItem[];
}>();
const emit = defineEmits<{
  (event: 'request-close'): void;
  (event: 'select', item: CommandCenterItem): void;
}>();

type PanelTemplateRef = ComponentPublicInstance | HTMLElement | null;

const overlayElement = ref<HTMLElement | null>(null);
const panelElement = ref<PanelTemplateRef>(null);
const listElement = ref<PanelTemplateRef>(null);
const searchFieldElement = ref<PanelTemplateRef>(null);
const searchQuery = ref('');
const activeItemId = ref<string>('');
const panelX = ref(0);
const panelY = ref(0);
const panelWidth = ref(0);
const panelHeight = ref(0);
const hasManualPosition = ref(false);
let resizeObserver: ResizeObserver | undefined;
let activePointerId: number | undefined;
let dragOffsetX = 0;
let dragOffsetY = 0;

const filteredItems = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();

  if (!query) {
    return props.items;
  }

  return props.items.filter((item) => {
    const keywords = [item.title, item.description, item.group, item.shortcut ?? ''];
    return keywords.some((keyword) => keyword.toLowerCase().includes(query));
  });
});

const panelStyle = computed(() => ({
  transform: `translate(${panelX.value}px, ${panelY.value}px)`
}));

const listScrollerElement = computed(() => resolveListElement());

/**
 * 在过滤结果变化时同步命令中心高亮项。 */
watch(filteredItems, (items) => {
  if (items.length === 0) {
    activeItemId.value = '';
    return;
  }

  if (!items.some((item) => item.id === activeItemId.value)) {
    activeItemId.value = '';
  }
}, {
  immediate: true
});

/**
 * 解析模板引用，确保 `v-sheet` 组件引用能够拿到真实 DOM。 */
function resolvePanelElement(): HTMLElement | null {
  if (panelElement.value instanceof HTMLElement) {
    return panelElement.value;
  }

  const panelRoot = panelElement.value?.$el;
  return panelRoot instanceof HTMLElement ? panelRoot : null;
}

/**
 * 解析命令列表模板引用，确保能够拿到真实滚动容器。 */
function resolveListElement(): HTMLElement | null {
  if (listElement.value instanceof HTMLElement) {
    return listElement.value;
  }

  const listRoot = listElement.value?.$el;
  return listRoot instanceof HTMLElement ? listRoot : null;
}

/**
 * 解析搜索框模板引用，确保能够拿到真实输入元素。 */
function resolveSearchInputElement(): HTMLInputElement | null {
  const searchRoot = searchFieldElement.value instanceof HTMLElement
    ? searchFieldElement.value
    : searchFieldElement.value?.$el;

  if (!(searchRoot instanceof HTMLElement)) {
    return null;
  }

  const searchInput = searchRoot.querySelector('input');
  return searchInput instanceof HTMLInputElement ? searchInput : null;
}

/**
 * 更新面板尺寸缓存，供居中与拖拽边界计算使用。 */
function syncPanelMetrics(): void {
  const element = resolvePanelElement();

  if (!element) {
    return;
  }

  const rect = element.getBoundingClientRect();
  panelWidth.value = rect.width;
  panelHeight.value = rect.height;
}

/**
 * 获取工作区覆盖层的可用边界尺寸。 */
function getOverlayBounds(): DOMRect | null {
  return overlayElement.value?.getBoundingClientRect() ?? null;
}

/**
 * 将 CSS 长度值转换为像素值，供默认顶部偏移计算使用。 */
function convertCssLengthToPixels(length: string): number {
  const value = Number.parseFloat(length);

  if (Number.isNaN(value)) {
    return 0;
  }

  if (length.endsWith('rem')) {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return value * rootFontSize;
  }

  return value;
}

/**
 * 读取命令中心默认顶部偏移，保持样式尺寸来源统一。 */
function getDefaultPanelTopOffset(): number {
  if (!overlayElement.value) {
    return 0;
  }

  const topOffset = getComputedStyle(overlayElement.value)
    .getPropertyValue('--command-center-top-offset')
    .trim();

  return convertCssLengthToPixels(topOffset);
}

/**
 * 根据覆盖层大小计算命令中心默认位置，仅保持水平居中。 */
function positionPanelAtDefaultOffset(): void {
  const overlayBounds = getOverlayBounds();

  if (!overlayBounds) {
    return;
  }

  syncPanelMetrics();
  const maxY = Math.max(0, overlayBounds.height - panelHeight.value);
  panelX.value = Math.max(0, (overlayBounds.width - panelWidth.value) / 2);
  panelY.value = Math.min(getDefaultPanelTopOffset(), maxY);
}

/**
 * 将命令中心位置限制在当前工作区范围内。 */
function clampPanelPosition(): void {
  const overlayBounds = getOverlayBounds();

  if (!overlayBounds) {
    return;
  }

  syncPanelMetrics();
  const maxX = Math.max(0, overlayBounds.width - panelWidth.value);
  const maxY = Math.max(0, overlayBounds.height - panelHeight.value);
  panelX.value = Math.min(Math.max(0, panelX.value), maxX);
  panelY.value = Math.min(Math.max(0, panelY.value), maxY);
}

/**
 * 在覆盖层或面板尺寸变化时重新同步默认位置或边界。 */
function syncPanelLayout(): void {
  if (hasManualPosition.value) {
    clampPanelPosition();
    return;
  }

  positionPanelAtDefaultOffset();
}

/**
 * 选中指定命令项，仅更新当前展示高亮。 */
function selectItem(itemId: string): void {
  activeItemId.value = itemId;
  const item = props.items.find((candidate) => candidate.id === itemId);

  if (item) {
    emit('select', item);
  }
}

/**
 * 清理拖拽过程注册的全局指针事件。 */
function cleanupPointerSession(): void {
  activePointerId = undefined;
  window.removeEventListener('pointermove', handleWindowPointerMove);
  window.removeEventListener('pointerup', handleWindowPointerUp);
  window.removeEventListener('pointercancel', handleWindowPointerUp);
}

/**
 * 在拖拽过程中根据指针位置更新面板偏移，并限制在工作区内。 */
function handleWindowPointerMove(event: PointerEvent): void {
  if (activePointerId !== event.pointerId) {
    return;
  }

  const overlayBounds = getOverlayBounds();

  if (!overlayBounds) {
    return;
  }

  panelX.value = event.clientX - overlayBounds.left - dragOffsetX;
  panelY.value = event.clientY - overlayBounds.top - dragOffsetY;
  clampPanelPosition();
}

/**
 * 在拖拽结束时移除全局监听。 */
function handleWindowPointerUp(event: PointerEvent): void {
  if (activePointerId !== event.pointerId) {
    return;
  }

  cleanupPointerSession();
}

/**
 * 监听全局点击命中，当点击落在命令中心面板外部时请求关闭浮层。 */
function handleWindowPointerDown(event: PointerEvent): void {
  const panelRoot = resolvePanelElement();

  if (!panelRoot) {
    return;
  }

  if (event.target instanceof Node && panelRoot.contains(event.target)) {
    return;
  }

  emit('request-close');
}

/**
 * 聚焦命令中心搜索框，确保通过快捷键呼出后可直接输入。 */
function focusSearchInput(): void {
  resolveSearchInputElement()?.focus();
}

/**
 * 判断当前指针目标是否位于命令中心的交互区域中。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.closest('[data-command-center-interactive="true"]') !== null;
}

/**
 * 从面板空白区域启动命令中心拖拽，并记录光标相对偏移。 */
function handlePanelPointerDown(event: PointerEvent): void {
  if (isInteractiveTarget(event.target)) {
    return;
  }

  const element = resolvePanelElement();

  if (!element || !overlayElement.value) {
    return;
  }

  const panelBounds = element.getBoundingClientRect();
  dragOffsetX = event.clientX - panelBounds.left;
  dragOffsetY = event.clientY - panelBounds.top;
  activePointerId = event.pointerId;
  hasManualPosition.value = true;

  window.addEventListener('pointermove', handleWindowPointerMove);
  window.addEventListener('pointerup', handleWindowPointerUp);
  window.addEventListener('pointercancel', handleWindowPointerUp);
}

/**
 * 初始化命令中心默认选中项与布局监听。 */
onMounted(async () => {
  await nextTick();
  syncPanelLayout();
  window.addEventListener('pointerdown', handleWindowPointerDown, true);

  const element = resolvePanelElement();

  if (!overlayElement.value || !element) {
    return;
  }

  resizeObserver = new ResizeObserver(() => {
    syncPanelLayout();
  });
  resizeObserver.observe(overlayElement.value);
  resizeObserver.observe(element);
  focusSearchInput();
});

/**
 * 组件卸载时释放布局观察器和拖拽监听。 */
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  cleanupPointerSession();
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
});
</script>

<template>
  <div ref="overlayElement" class="command-center-overlay">
    <v-sheet
      ref="panelElement"
      class="command-center-panel rounded-0"
      :style="panelStyle"
      elevation="8"
      @pointerdown="handlePanelPointerDown"
    >
      <div class="command-center-panel__search-shell" data-command-center-interactive="true">
        <!-- S = 命令中心搜索框 -->
        <WsSearchInput
          ref="searchFieldElement"
          v-model="searchQuery"
          class="command-center-panel__search"
          placeholder="输入命令"
        />
        <!-- E = 命令中心搜索框 -->
      </div>

      <v-sheet
        class="command-center-panel__list-shell"
        color="transparent"
        data-command-center-interactive="true"
        elevation="0"
      >
        <v-list
          ref="listElement"
          class="command-center-panel__list"
          density="compact"
          nav
        >
          <v-list-item
            v-for="item in filteredItems"
            :key="item.id"
            class="command-center-panel__item"
            :class="{ 'command-center-panel__item--active': item.id === activeItemId }"
            :title="item.title"
            @click="selectItem(item.id)"
          >
            <template #append>
              <span v-if="item.shortcut" class="command-center-panel__shortcut">
                {{ item.shortcut }}
              </span>
            </template>
          </v-list-item>
        </v-list>

        <WorkbenchVerticalScrollbar :scroller-element="listScrollerElement" />
      </v-sheet>
    </v-sheet>
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.command-center-overlay {
  --command-center-top-offset: #{$command-center-top-offset};
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: $command-center-overlay-z-index;
}

.command-center-panel {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  width: min($command-center-panel-width, calc(100% - #{$spacing-xl}));
  height: min($command-center-panel-max-height, calc(100% - #{$spacing-xl}));
  min-height: 0;
  padding-bottom: 0 !important;
  overflow: hidden;
  pointer-events: auto;
  border-top: none !important;
  border: 1px solid var(--ws-border,var(--ws-commandCenter-border,transparent));
  background: var(--ws-commandCenter-background);
  color: var(--ws-foreground);
  border-radius: $radius-xs !important;
}

.command-center-panel__search-shell {
  flex: none;
}

.command-center-panel__search:deep(.v-input__control) {
  border-radius: $radius-xs;
  padding: $spacing-xs;
}

.command-center-panel__search:deep(.v-field__input) {
  min-height: $command-center-search-height;
  padding-top: 0;
  padding-bottom: 0;
  font-size: $font-size-sm;
}

.command-center-panel__list-shell {
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin-top: $spacing-2xs;
  overflow: hidden;
  position: relative;
  padding-inline: $menu-compact-spacing;
}

.command-center-panel__list {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  border-radius: $radius-xs;
  padding: 0;
  background: transparent;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.command-center-panel__list::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.command-center-panel__item {
  min-height: $command-center-item-height !important;
  color: inherit;
  padding-right: 22px !important;
}

.command-center-panel__item:deep(.v-list-item__content) {
  min-width: 0;
}

.command-center-panel__item:deep(.v-list-item-title) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-center-panel__item:deep(.v-list-item__append) {
  flex: none;
  margin-inline-start: $spacing-sm;
  padding-inline-start: 0;
}

.command-center-panel__item:last-child {
  margin-bottom: $command-center-last-item-margin-bottom;
}

.command-center-panel__item:hover {
  background: var(--ws-tab-hoverBackground);
}

.command-center-panel__item--active {
  border-color: var(--ws-tab-activeBorder);
  background: var(--ws-tab-activeBackground);
}

.command-center-panel__shortcut {
  color: var(--ws-descriptionForeground);
  font-size: $font-size-sm;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
</style>

