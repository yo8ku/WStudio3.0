<script setup lang="ts">
/**
 * 文件说明：提供工作台搜索面板，包含范围筛选、文件类型筛选、结果增量渲染与可拖拽定位。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { CSSProperties } from 'vue';

const clearIcon = 'icon icon-clear';
const eyeIcon = 'icon icon-eye';
const openCurrentIcon = 'icon icon-open-current';
const searchIcon = 'icon icon-search';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import WsSelect from '@/components/WsSelect/WsSelect.vue';

export type WsSearchScope = 'all' | 'file' | 'tag' | 'line' | 'block' | 'section' | 'property';

export interface WsSearchResult {
  id: string | number;
  title: string;
  path: string;
  openPath?: string;
  resultPath?: string;
  type?: Exclude<WsSearchScope, 'all'>;
  detail?: string;
  preview?: string;
}

interface SearchFileTypeOption {
  title: string;
  value: string;
}

interface SearchPosition {
  x: number;
  y: number;
}

const props = withDefaults(defineProps<{
  items?: readonly WsSearchResult[];
  supportedFileTypes?: readonly string[];
  initialPosition?: SearchPosition;
  width?: string | number;
  windowDrag?: boolean;
}>(), {
  items: () => [],
  supportedFileTypes: () => ['Markdown', '纯文本', 'JSON', 'HTML', 'CSS', 'TypeScript'],
  initialPosition: () => ({ x: 0, y: 0 }),
  width: 'min(44rem, calc(100vw - 2rem))',
  windowDrag: false
});

const emit = defineEmits<{
  'update:position': [position: SearchPosition];
  select: [item: WsSearchResult];
  preview: [item: WsSearchResult];
  'open-in-find-tool': [query: string];
  'open-split': [item: WsSearchResult | undefined];
  close: [];
}>();

const query = defineModel<string>({ default: '' });
const activeScope = ref<WsSearchScope>('all');
const fileType = ref('all');
const selectedResult = ref<WsSearchResult>();
const visibleCount = ref(100);
const position = ref<SearchPosition>({ ...props.initialPosition });
const hasManualPosition = ref(false);
const panelElement = ref<HTMLElement | null>(null);
const overlayElement = ref<HTMLElement | null>(null);
const resultsElement = ref<HTMLElement | null>(null);
let activePointerId: number | undefined;
let dragOffsetX = 0;
let dragOffsetY = 0;

const scopeOptions: ReadonlyArray<{ label: string; value: WsSearchScope }> = [
  { label: '所有', value: 'all' },
  { label: '文件', value: 'file' },
  { label: '标签', value: 'tag' },
  { label: '行', value: 'line' },
  { label: '块', value: 'block' },
  { label: '章节', value: 'section' },
  { label: '笔记属性', value: 'property' }
];

const fileTypeOptions = computed<SearchFileTypeOption[]>(() => [
  { title: '所有文件类型', value: 'all' },
  ...props.supportedFileTypes.map((title) => ({ title, value: title }))
]);

const filteredResults = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase();

  return props.items.filter((item) => {
    const matchesScope = activeScope.value === 'all' || item.type === activeScope.value;
    const matchesFileType = fileType.value === 'all'
      || item.path.toLocaleLowerCase().endsWith(`.${fileType.value.toLocaleLowerCase()}`);
    const searchableText = [item.title, item.path, item.detail ?? '', item.preview ?? '']
      .join(' ')
      .toLocaleLowerCase();
    return matchesScope && matchesFileType && (!normalizedQuery || searchableText.includes(normalizedQuery));
  });
});

const visibleResults = computed(() => filteredResults.value.slice(0, visibleCount.value));
const hasMoreResults = computed(() => visibleResults.value.length < filteredResults.value.length);
const activeResultIndex = computed(() => (
  selectedResult.value
    ? visibleResults.value.findIndex((item) => item.id === selectedResult.value?.id)
    : -1
));
const panelStyle = computed<CSSProperties>(() => props.windowDrag
  ? { width: '100%', transform: 'none' }
  : {
      width: props.width,
      transform: `translate(${position.value.x}px, ${position.value.y}px)`
    });

watch([query, activeScope, fileType], () => {
  visibleCount.value = 100;
  selectedResult.value = filteredResults.value[0];
});

watch(() => props.items, () => {
  visibleCount.value = 100;
  if (!selectedResult.value && props.items.length > 0) {
    selectedResult.value = props.items[0];
  }
  if (selectedResult.value && !props.items.some((item) => item.id === selectedResult.value?.id)) {
    selectedResult.value = undefined;
  }
}, { deep: true, immediate: true });

watch(() => props.initialPosition, (nextPosition) => {
  if (activePointerId === undefined) position.value = { ...nextPosition };
}, { deep: true });

function clearQuery(): void {
  query.value = '';
}

function selectResult(item: WsSearchResult): void {
  selectedResult.value = item;
  emit('select', item);
}

function loadMore(): void {
  visibleCount.value += 100;
}

function handlePreview(item: WsSearchResult): void {
  emit('preview', item);
}

function handleOpenInFindTool(): void {
  emit('open-in-find-tool', query.value);
}

function handleOpenSplit(): void {
  emit('open-split', selectedResult.value);
}

function scrollActiveResultIntoView(): void {
  const index = activeResultIndex.value;
  const resultElement = resultsElement.value?.querySelectorAll<HTMLElement>('.ws-search__result')[index];
  resultElement?.scrollIntoView({ block: 'nearest' });
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }

  if (event.target instanceof Element && event.target.closest('.ws-select-dropdown')) {
    return;
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') {
    return;
  }

  if (visibleResults.value.length === 0) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    if (selectedResult.value) emit('select', selectedResult.value);
    return;
  }

  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const currentIndex = activeResultIndex.value;
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : visibleResults.value.length - 1)
    : (currentIndex + direction + visibleResults.value.length) % visibleResults.value.length;
  selectedResult.value = visibleResults.value[nextIndex];
  requestAnimationFrame(scrollActiveResultIntoView);
}

function resolvePanelBounds(): DOMRect | undefined {
  return panelElement.value?.getBoundingClientRect();
}

function resolveOverlayBounds(): DOMRect | undefined {
  return overlayElement.value?.getBoundingClientRect();
}

function clampPosition(nextPosition: SearchPosition): SearchPosition {
  const overlayBounds = resolveOverlayBounds();
  const panelBounds = resolvePanelBounds();
  if (!overlayBounds || !panelBounds) return nextPosition;

  const maxX = Math.max(0, overlayBounds.width - panelBounds.width);
  const maxY = Math.max(0, overlayBounds.height - panelBounds.height);
  return {
    x: Math.min(Math.max(0, nextPosition.x), maxX),
    y: Math.min(Math.max(0, nextPosition.y), maxY)
  };
}

function cleanupDrag(): void {
  activePointerId = undefined;
  window.removeEventListener('pointermove', handlePointerMove);
  window.removeEventListener('pointerup', handlePointerUp);
  window.removeEventListener('pointercancel', handlePointerUp);
}

function handlePointerMove(event: PointerEvent): void {
  if (activePointerId !== event.pointerId) return;
  const overlayBounds = resolveOverlayBounds();
  if (!overlayBounds) return;

  position.value = clampPosition({
    x: event.clientX - overlayBounds.left - dragOffsetX,
    y: event.clientY - overlayBounds.top - dragOffsetY
  });
  emit('update:position', position.value);
}

function handlePointerUp(event: PointerEvent): void {
  if (activePointerId === event.pointerId) cleanupDrag();
}

function handleDragStart(event: PointerEvent): void {
  if (event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest('[data-ws-search-interactive="true"]')) return;
  const panelBounds = resolvePanelBounds();
  if (!panelBounds) return;

  dragOffsetX = event.clientX - panelBounds.left;
  dragOffsetY = event.clientY - panelBounds.top;
  activePointerId = event.pointerId;
  hasManualPosition.value = true;
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
}

async function positionAtCenter(): Promise<void> {
  await nextTick();
  if (hasManualPosition.value) {
    position.value = clampPosition(position.value);
    return;
  }
  const overlayBounds = resolveOverlayBounds();
  const panelBounds = resolvePanelBounds();
  if (!overlayBounds || !panelBounds || props.initialPosition.x || props.initialPosition.y) return;

  position.value = {
    x: Math.max(0, (overlayBounds.width - panelBounds.width) / 2),
    y: Math.max(0, (overlayBounds.height - panelBounds.height) / 2)
  };
}

onMounted(() => {
  void positionAtCenter();
  window.addEventListener('resize', positionAtCenter);
  window.addEventListener('keydown', handleKeydown, true);
});

onBeforeUnmount(() => {
  cleanupDrag();
  window.removeEventListener('resize', positionAtCenter);
  window.removeEventListener('keydown', handleKeydown, true);
});
</script>

<template>
  <div ref="overlayElement" class="ws-search-overlay">
    <section
      ref="panelElement"
      class="ws-search"
      :class="{ 'ws-search--window-drag': props.windowDrag }"
      :style="panelStyle"
      aria-label="搜索"
    >
      <header class="ws-search__header" @pointerdown="handleDragStart">
        <nav
          class="ws-search__scopes"
          aria-label="搜索范围"
          data-ws-search-interactive="true"
          role="tablist"
        >
          <button
            v-for="scope in scopeOptions"
            :key="scope.value"
            class="ws-search__scope"
            :class="{ 'ws-search__scope--active': activeScope === scope.value }"
            :aria-selected="activeScope === scope.value"
            role="tab"
            type="button"
            @click="activeScope = scope.value"
          >
            {{ scope.label }}
          </button>
        </nav>

        <div class="ws-search__header-actions" data-ws-search-interactive="true">
          <WsSelect
            v-model="fileType"
            :items="fileTypeOptions"
            class="ws-search__file-type"
            item-title="title"
            item-value="value"
            aria-label="文件类型"
          />
          <WsIconButton
            :icon="eyeIcon"
            label="预览"
            tooltip="预览"
            class="ws-search__action"
            @click="selectedResult && handlePreview(selectedResult)"
          />
          <WsIconButton
            :icon="openCurrentIcon"
            label="在查找工具中打开"
            tooltip="在查找工具中打开"
            class="ws-search__action"
            @click="handleOpenInFindTool"
          />
        </div>
      </header>

      <div class="ws-search__query" data-ws-search-interactive="true">
        <!-- S = 搜索输入框 -->
        <WsSearchInput v-model="query" placeholder="搜索" :clearable="false">
          <template #prepend-inner>
            <span class="ws-search__query-icon" aria-hidden="true" :class="searchIcon" />
          </template>
          <template #append-inner>
            <WsIconButton
              :icon="clearIcon"
              label="清除搜索"
              tooltip="清除搜索"
              class="ws-search__clear"
              :disabled="query.length === 0"
              @click="clearQuery"
            />
          </template>
        </WsSearchInput>
        <!-- E = 搜索输入框 -->
      </div>

      <div class="ws-search__results-shell" data-ws-search-interactive="true">
        <div ref="resultsElement" class="ws-search__results">
          <div v-if="visibleResults.length > 0" class="ws-search__result-list" role="listbox" aria-label="搜索结果">
            <button
              v-for="item in visibleResults"
              :key="item.id"
              class="ws-search__result"
              :class="{ 'ws-search__result--selected': selectedResult?.id === item.id }"
              type="button"
              role="option"
              :aria-selected="selectedResult?.id === item.id"
              @click="selectResult(item)"
            >
              <span class="ws-search__result-main">
                <span
                  class="ws-search__result-title"
                  :title="item.title"
                >
                  {{ item.title }}
                </span>
                <span v-if="item.resultPath" class="ws-search__result-path">{{ item.resultPath }}</span>
              </span>
              <span v-if="item.detail || item.preview" class="ws-search__result-detail">
                {{ item.detail || item.preview }}
              </span>
            </button>
          </div>
          <div v-else class="ws-search__empty" role="status">暂无搜索结果</div>

          <button v-if="hasMoreResults" class="ws-search__more" type="button" @click="loadMore">
            ...更多
          </button>
        </div>

        <WorkbenchVerticalScrollbar
          :always-visible="true"
          :scroller-element="resultsElement"
        />
      </div>

      <footer class="ws-search__footer" data-ws-search-interactive="true">
        <span class="ws-search__selected-path" :title="selectedResult?.path || ''">
          {{ selectedResult?.path || '' }}
        </span>
        <span class="ws-search__keyboard-hints">
          <span>↑↓ · 导航</span>
          <span>Esc · 退出</span>
        </span>
        <button class="ws-search__split" type="button" @click="handleOpenSplit">
          右侧拆分打开
        </button>
      </footer>
    </section>
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ws-search-overlay {
  position: fixed;
  z-index: 30;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.ws-search {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - #{$spacing-md});
  height: min(36rem, calc(100vh - #{$spacing-md}));
  max-height: calc(100vh - #{$spacing-md});
  min-height: 16rem;
  overflow: hidden;
  pointer-events: auto;
  border: $input-border-width solid var(--ws-border, transparent);
  border-radius: $radius-xs;
  background: var(--ws-dialog-background, var(--ws-menu-background, var(--ws-background)));
  color: var(--ws-foreground);
  box-shadow: 0 0.75rem 2rem rgb(0 0 0 / 0.24);
  line-height: 1.25;
}

.ws-search__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-sm;
  min-height: 2.5rem;
  padding: $spacing-2xs $spacing-xs;
  border-bottom: $input-border-width solid var(--ws-border, transparent);
  cursor: default;
  user-select: none;
  :deep(.ws-icon-button){
    height: 1.5rem;
  }
}

.ws-search--window-drag .ws-search__header {
  -webkit-app-region: drag;
}

.ws-search--window-drag .ws-search__header [data-ws-search-interactive="true"] {
  -webkit-app-region: no-drag;
}

.ws-search__header:active {
  cursor: grabbing;
}

.ws-search__scopes,
.ws-search__header-actions {
  display: flex;
  align-items: center;
  gap: $spacing-xs;
  min-width: 0;
}

.ws-search__scopes {
  overflow-x: auto;
  scrollbar-width: none;
}

.ws-search__scopes::-webkit-scrollbar {
  display: none;
}

.ws-search__scope {
  flex: none;
  min-height: $button-height;
  padding: $spacing-2xs $spacing-xs;
  border: 0;
  border-radius: $radius-xs;
  background: transparent;
  color: var(--ws-tab-inactiveForeground, var(--ws-foreground));
  font: inherit;
  font-size: $font-size-sm;
  cursor: pointer;
}

.ws-search__scope:hover,
.ws-search__scope--active {
  background: var(--ws-tab-hoverBackground, var(--ws-button-hoverBackground));
  color: var(--ws-tab-activeForeground, var(--ws-foreground));
}

.ws-search__header-actions {
  flex: none;
}

.ws-search__file-type {
  min-width: 8rem;
}

.ws-search__action :deep(.ws-icon-button__icon),
.ws-search__clear :deep(.ws-icon-button__icon),
.ws-search__query-icon {
  width: $icon-size-width;
  height: $icon-size-height;
}

.ws-search__query {
  flex: none;
  padding: $spacing-xs;
}

.ws-search__query-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: $icon-size-width;
  height: $icon-size-height;
  color: var(--ws-descriptionForeground, var(--ws-foreground));
}

.ws-search__clear {
  margin-inline-end: -$spacing-2xs;
}

.ws-search__results-shell {
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  flex: 1;
  position: relative;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0 $spacing-xs $spacing-xs;
}

.ws-search__results {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
 padding: 0 0.5rem;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ws-search__results::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.ws-search__result-list {
  display: flex;
  flex-direction: column;
}

.ws-search__result,
.ws-search__more {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-sm;
  min-height: 1.5rem;
  padding: $spacing-03rem;
  border: 0;
  border-radius: $radius-xs;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  margin-bottom: 2px;
}

.ws-search__result:hover,
.ws-search__result--selected,
.ws-search__more:hover {
  background: var(--ws-tab-hoverBackground, var(--ws-button-hoverBackground));
}

.ws-search__result-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  flex-direction: row;
  gap: $spacing-sm;
  min-width: 0;
  max-width: 100%;
}

.ws-search__result-title,
.ws-search__result-path,
.ws-search__result-detail,
.ws-search__selected-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-search__result-title {
  flex: 0 1 auto;
  display: block;
  max-width: 50%;
  min-width: 0;
  overflow: hidden;
  color: var(--ws-foreground);
  font-size: $font-size-sm;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-search__result-path,
.ws-search__result-detail,
.ws-search__selected-path {
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  opacity: 0.78;
  margin-left: 0;
}

.ws-search__result-path {
  flex: 1 1 auto;
  min-width: 0;
}

.ws-search__result-detail {
  min-width: 0;
  max-width: 42%;
}

.ws-search__empty {
  padding: $spacing-xl $spacing-md;
  color: var(--ws-foreground);
  text-align: center;
}

.ws-search__more {
  width: 100%;
  margin-top: $spacing-2xs;
}

.ws-search__footer {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: $spacing-sm;
  height: 2rem;
  min-height: 2rem;
  padding: $spacing-2xs $spacing-xs;
  line-height: 1.25;
}

.ws-search__selected-path {
  display: block;
  height: 1.25rem;
  min-width: 0;
  overflow: hidden;
  line-height: 1.25rem;
  direction: rtl;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-search__keyboard-hints {
  display: inline-flex;
  align-items: center;
  gap: $spacing-sm;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  white-space: nowrap;
  opacity: 0.5;
}

.ws-search__split {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: $spacing-2xs;
  min-height: $button-height;
  padding: $spacing-2xs $spacing-xs;
  border: 0;
  border-radius: $radius-xs;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: $font-size-sm;
  cursor: pointer;
}

.ws-search__split:hover {
  background: var(--ws-button-hoverBackground);
}

@media (max-width: 48rem) {
  .ws-search__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .ws-search__header-actions {
    width: 100%;
  }

  .ws-search__file-type {
    flex: 1;
  }

  .ws-search__footer {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
    height: auto;
  }

  .ws-search__selected-path {
    width: 100%;
  }
}

.ws-search.ws-search--window-drag {
  position: absolute;
  inset: 0;
  width: 100%;
  max-width: none;
  height: 100%;
  max-height: none;
  min-height: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.ws-search--window-drag .ws-search__header {
  align-items: center;
  flex-direction: row;
}

.ws-search--window-drag .ws-search__header-actions {
  width: auto;
}

.ws-search--window-drag .ws-search__file-type {
  flex: 0 0 8rem;
  width: 8rem;
  min-width: 8rem;
}

.ws-search--window-drag .ws-search__results-shell {
  padding-inline: 0;
}

.ws-search--window-drag .ws-search__footer {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto auto;
  height: 2rem;
  min-height: 2rem;
}

.ws-search--window-drag .ws-search__selected-path {
  width: auto;
}
</style>
