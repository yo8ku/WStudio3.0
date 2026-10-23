<script setup lang="ts">
/** Renders the searchable @ reference file selector for the inline chat editor. */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import type { WorkspaceFileEntry } from '@/types/ipc';
import type { RecentWorkspaceFile } from '@/store/dockingThree';

export interface AtReferenceItem {
  readonly path: string;
  readonly relativePath?: string;
  readonly title: string;
  readonly recent: boolean;
}

export interface AtReferenceMenuHandle {
  moveActive(delta: number): void;
  selectActive(): void;
}

interface AtReferenceMenuProps {
  files?: readonly WorkspaceFileEntry[];
  recentFiles?: readonly RecentWorkspaceFile[];
}

const props = withDefaults(defineProps<AtReferenceMenuProps>(), {
  files: () => [],
  recentFiles: () => []
});

const emit = defineEmits<{
  select: [item: AtReferenceItem];
  close: [];
}>();

const search = ref('');
const activeIndex = ref(0);
const scrollerElement = ref<HTMLElement | null>(null);
const menuElement = ref<HTMLElement | null>(null);

const allItems = computed<AtReferenceItem[]>(() => {
  const seen = new Set<string>();
  const recentItems: AtReferenceItem[] = [];

  for (const file of props.recentFiles.slice(0, 5)) {
    if (!file.path || seen.has(file.path)) continue;
    seen.add(file.path);
    recentItems.push({
      path: file.path,
      relativePath: file.relativePath,
      title: file.title,
      recent: true
    });
  }

  const workspaceItems = props.files
    .filter(file => Boolean(file.path))
    .map(file => ({
      path: file.path,
      relativePath: file.relativePath,
      title: file.name,
      recent: false
    }));

  return [...recentItems, ...workspaceItems];
});

const filteredItems = computed<AtReferenceItem[]>(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return allItems.value;
  return allItems.value.filter(item => (
    [item.title, item.relativePath ?? '', item.path]
      .some(value => value.toLocaleLowerCase().includes(query))
  ));
});

const recentItems = computed(() => filteredItems.value.filter(item => item.recent));
const workspaceItems = computed(() => filteredItems.value.filter(item => !item.recent));

function itemAt(index: number): AtReferenceItem | undefined {
  return filteredItems.value[index];
}

function selectActive(): void {
  const item = itemAt(activeIndex.value);
  if (item) emit('select', item);
}

function moveActive(delta: number): void {
  const count = filteredItems.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
  void nextTick(() => {
    const item = menuElement.value?.querySelector<HTMLElement>(
      `[data-at-reference-index="${activeIndex.value}"]`
    );
    item?.scrollIntoView({ block: 'nearest' });
  });
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    moveActive(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    selectActive();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
}

function handleDocumentPointerdown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Node && menuElement.value?.contains(target)) return;
  emit('close');
}

watch(filteredItems, (items) => {
  activeIndex.value = items.length > 0 ? Math.min(activeIndex.value, items.length - 1) : 0;
  void nextTick(() => scrollerElement.value?.scrollTo({ top: 0 }));
});

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerdown, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', handleDocumentPointerdown, true));

defineExpose<AtReferenceMenuHandle>({ moveActive, selectActive });
</script>

<template>
  <div ref="menuElement" class="ws-at-reference-menu" role="listbox" @keydown="handleKeydown">
    <div class="ws-at-reference-menu__search">
      <WsSearchInput
        v-model="search"
        autofocus
        aria-label="搜索文件"
        placeholder="搜索文件"
        @keydown="handleKeydown"
      />
    </div>

    <div class="ws-at-reference-menu__viewport">
      <div ref="scrollerElement" class="ws-at-reference-menu__scroll" tabindex="-1">
        <section v-if="recentItems.length > 0" class="ws-at-reference-menu__section">
          <h3 class="ws-at-reference-menu__section-title">最近打开</h3>
          <button
            v-for="(item, index) in recentItems"
            :key="`recent-${item.path}`"
            class="ws-at-reference-menu__item"
            :class="{ 'ws-at-reference-menu__item--active': activeIndex === index }"
            :data-at-reference-index="index"
            type="button"
            @mousedown.prevent
            @click="emit('select', item)"
          >
            <span class="ws-at-reference-menu__item-title">{{ item.title }}</span>
            <span class="ws-at-reference-menu__item-path">{{ item.relativePath || item.path }}</span>
          </button>
        </section>

        <section v-if="workspaceItems.length > 0" class="ws-at-reference-menu__section">
          <button
            v-for="(item, index) in workspaceItems"
            :key="`workspace-${item.path}`"
            class="ws-at-reference-menu__item"
            :class="{ 'ws-at-reference-menu__item--active': activeIndex === recentItems.length + index }"
            :data-at-reference-index="recentItems.length + index"
            type="button"
            @mousedown.prevent
            @click="emit('select', item)"
          >
            <span class="ws-at-reference-menu__item-title">{{ item.title }}</span>
            <span class="ws-at-reference-menu__item-path">{{ item.relativePath || item.path }}</span>
          </button>
        </section>

        <div v-if="filteredItems.length === 0" class="ws-at-reference-menu__empty" role="status">
          暂无文件
        </div>
      </div>
      <WorkbenchVerticalScrollbar :scroller-element="scrollerElement" always-visible />
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as variables;

.ws-at-reference-menu {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
  // Existing materialized built-in themes may predate the @ menu colors.
  border: variables.$editor-block-border-width solid var(--ws-inlineEditor-at-border, var(--ws-border));
  border-radius: variables.$radius-xs;
  color: var(--ws-inlineEditor-at-foreground, var(--ws-inlineEditor-foreground));
  background-color: var(
    --ws-inlineEditor-at-background,
    var(--ws-inlineEditor-background, var(--ws-editor-background, var(--ws-background, #ffffff)))
  );
  isolation: isolate;
  box-shadow: variables.$menu-box-shadow;
  font-family: inherit;
  font-size: inherit;
  line-height: normal;
}

.ws-at-reference-menu__search {
  flex: 0 0 auto;
  margin-block: variables.$menu-compact-spacing;
}

.ws-at-reference-menu__search :deep(.v-field) {
  height: variables.$select-trigger-height;
  min-height: variables.$select-trigger-height;
  border: 0;
}

.ws-at-reference-menu__viewport {
  position: relative;
  min-height: 0;
  padding: variables.$menu-compact-spacing;
}

.ws-at-reference-menu__scroll {
  position: relative;
  min-height: 0;
  max-height: variables.$inline-chat-at-menu-max-height;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ws-at-reference-menu__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.ws-at-reference-menu__section {
  padding: variables.$spacing-2xs 0;
}

.ws-at-reference-menu__section + .ws-at-reference-menu__section {
  border-top: variables.$editor-block-border-width solid var(--ws-inlineEditor-at-border, var(--ws-border));
}

.ws-at-reference-menu__section-title {
  margin: 0;
  padding: variables.$spacing-2xs variables.$spacing-sm;
  color: var(--ws-inlineEditor-at-sectionForeground, var(--ws-descriptionForeground));
  font-size: variables.$font-size-xs;
  font-weight: 600;
}

.ws-at-reference-menu__item {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: variables.$dropdown-menu-item-height;
  align-items: center;
  gap: variables.$spacing-sm;
  padding: variables.$dropdown-menu-item-padding-block variables.$spacing-sm;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: start;
  cursor: pointer;
  border-radius: variables.$radius-xs;
}

.ws-at-reference-menu__item:hover,
.ws-at-reference-menu__item:focus-visible,
.ws-at-reference-menu__item--active {
  background: var(--ws-inlineEditor-at-hoverBackground, var(--ws-menu-hoverBackground));
  outline: none;
}

.ws-at-reference-menu__item-title,
.ws-at-reference-menu__item-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-at-reference-menu__item-title {
  flex: 1 1 auto;
}

.ws-at-reference-menu__item-path {
  flex: 0 1 55%;
  color: var(--ws-inlineEditor-at-pathForeground, var(--ws-descriptionForeground));
  text-align: end;
}

.ws-at-reference-menu__empty {
  padding: variables.$spacing-md;
  color: var(--ws-inlineEditor-at-pathForeground, var(--ws-descriptionForeground));
  text-align: center;
}
</style>
