<script setup lang="ts">
/** 文件说明：宿主标签面板，读取工作区 Markdown 内容并展示标签及来源文件。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import { workspaceApi } from '@/api/workspace';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsMenu from '@/components/WsMenu/WsMenu.vue';
import type { WsMenuItem } from '@/components/WsMenu/types';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import { useWorkspaceStore } from '@/store/workspace';
const foldIcon = 'icon icon-fold';
const foldUpIcon = 'icon icon-fold-up';
const arrowDownIcon = 'icon icon-arrow-down';
const arrowForwardIcon = 'icon icon-arrow-forward';
const folderTreeIcon = 'icon icon-folder-tree';
const searchIcon = 'icon icon-search';
const sortIcon = 'icon icon-sort';
import { collectMarkdownTagLabels, type MarkdownTagMatch } from '@editor/Markdown/tagHighlightExtension';
import { useDockingThreeStore } from '@/store/dockingThree';

interface EditorTagItem {
  id: string;
  label: string;
  path: string;
  position: number;
}

interface TagTreeNode {
  fullLabel: string;
  label: string;
  items: EditorTagItem[];
  children: Map<string, TagTreeNode>;
  count: number;
}

interface VisibleTagTreeNode {
  node: TagTreeNode;
  depth: number;
  expanded: boolean;
}

const workspaceStore = useWorkspaceStore();
const dockingThreeStore = useDockingThreeStore();
const { workspaceFiles } = storeToRefs(workspaceStore);
const tags = ref<EditorTagItem[]>([]);
type TagSortMode = 'name-asc' | 'name-desc' | 'count-desc' | 'count-asc';

const sortMode = ref<TagSortMode>('name-asc');
const sortMenuOpen = ref(false);
const sortMenuTarget = ref<HTMLElement | null>(null);
const nestedVisible = ref(false);
const collapsedNodeKeys = ref<Set<string>>(new Set());
const searchVisible = ref(false);
const searchQuery = ref('');
let refreshSequence = 0;

const markdownPattern = /\.(?:md|markdown)$/iu;

const groupedTags = computed(() => {
  const groups = tags.value.reduce<Record<string, EditorTagItem[]>>((result, item) => {
    (result[item.label] ??= []).push(item);
    return result;
  }, {});
  const query = searchQuery.value.trim().toLocaleLowerCase();

  return Object.entries(groups)
    .filter(([label]) => !query || label.toLocaleLowerCase().includes(query))
    .sort(([leftLabel, leftItems], [rightLabel, rightItems]) => {
      if (sortMode.value === 'count-desc' || sortMode.value === 'count-asc') {
        const countDifference = leftItems.length - rightItems.length;
        if (countDifference !== 0) {
          return sortMode.value === 'count-desc' ? -countDifference : countDifference;
        }
      }

      const nameDifference = leftLabel.localeCompare(
        rightLabel,
        undefined,
        { sensitivity: 'base' }
      );
      return sortMode.value === 'name-desc' ? -nameDifference : nameDifference;
    });
});

const flatGroupedTags = computed(() => {
  const groups = new Map<string, EditorTagItem[]>();

  groupedTags.value.forEach(([fullLabel, items]) => {
    const parts = fullLabel.split('/');
    parts.forEach((_, index) => {
      const prefix = parts.slice(0, index + 1).join('/');
      const prefixItems = groups.get(prefix) ?? [];
      items.forEach((item, itemIndex) => {
        prefixItems.push({
          ...item,
          id: `${item.id}:${prefix}:${itemIndex}`,
          label: prefix
        });
      });
      groups.set(prefix, prefixItems);
    });
  });

  return [...groups.entries()]
    .filter(([label]) => {
      const query = searchQuery.value.trim().toLocaleLowerCase();
      return !query || label.toLocaleLowerCase().includes(query);
    })
    .sort(([leftLabel, leftItems], [rightLabel, rightItems]) => compareTagEntries(
      leftLabel,
      leftItems.length,
      rightLabel,
      rightItems.length
    ));
});

function compareTagEntries(
  leftLabel: string,
  leftCount: number,
  rightLabel: string,
  rightCount: number
): number {
  if (sortMode.value === 'count-desc' || sortMode.value === 'count-asc') {
    const countDifference = leftCount - rightCount;
    if (countDifference !== 0) {
      return sortMode.value === 'count-desc' ? -countDifference : countDifference;
    }
  }

  const nameDifference = leftLabel.localeCompare(
    rightLabel,
    undefined,
    { sensitivity: 'base' }
  );
  return sortMode.value === 'name-desc' ? -nameDifference : nameDifference;
}

const nestedTagTree = computed(() => {
  const roots = new Map<string, TagTreeNode>();

  for (const [fullLabel, items] of groupedTags.value) {
    const parts = fullLabel.split('/');
    let parentPath = '';
    let currentNodes = roots;

    parts.forEach((part, index) => {
      const nodePath = parentPath ? `${parentPath}/${part}` : part;
      let node = currentNodes.get(nodePath);
      if (!node) {
        node = {
          fullLabel: nodePath,
          label: part.startsWith('#') ? part.slice(1) : part,
          items: [],
          children: new Map<string, TagTreeNode>(),
          count: 0
        };
        currentNodes.set(nodePath, node);
      }

      if (index === parts.length - 1) {
        node.items = items;
      }

      parentPath = nodePath;
      currentNodes = node.children;
    });
  }

  const sortNodes = (nodes: Map<string, TagTreeNode>): TagTreeNode[] => {
    const values = [...nodes.values()];
    values.forEach((node) => {
      const children = sortNodes(node.children);
      node.children = new Map(children.map((child) => [child.fullLabel, child]));
      node.count = node.items.length + children.reduce((sum, child) => sum + child.count, 0);
    });
    return values.sort((left, right) => compareTagEntries(
      left.label,
      left.count,
      right.label,
      right.count
    ));
  };

  return sortNodes(roots);
});

const expandableTagKeys = computed(() => {
  const keys: string[] = [];
  const collectKeys = (nodes: readonly TagTreeNode[]): void => {
    nodes.forEach((node) => {
      if (node.children.size === 0) return;
      keys.push(node.fullLabel);
      collectKeys([...node.children.values()]);
    });
  };

  collectKeys(nestedTagTree.value);
  return keys;
});

const groupsExpanded = computed(() =>
  expandableTagKeys.value.every(key => !collapsedNodeKeys.value.has(key))
);

const visibleNestedTags = computed<VisibleTagTreeNode[]>(() => {
  const visible: VisibleTagTreeNode[] = [];

  const appendNodes = (nodes: readonly TagTreeNode[], depth: number): void => {
    nodes.forEach((node) => {
      const expanded = !collapsedNodeKeys.value.has(node.fullLabel);
      visible.push({ node, depth, expanded });
      if (expanded && node.children.size > 0) {
        appendNodes([...node.children.values()], depth + 1);
      }
    });
  };

  appendNodes(nestedTagTree.value, 0);
  return visible;
});

const sortMenuItems = computed<WsMenuItem[]>(() => [
  {
    type: 'action',
    id: 'name-asc',
    label: '标签名称(A-Z)',
    checked: sortMode.value === 'name-asc'
  },
  {
    type: 'action',
    id: 'name-desc',
    label: '标签名称(Z-A)',
    checked: sortMode.value === 'name-desc'
  },
  { type: 'separator', id: 'sort-divider' },
  {
    type: 'action',
    id: 'count-desc',
    label: '使用频次(从高到低)',
    checked: sortMode.value === 'count-desc'
  },
  {
    type: 'action',
    id: 'count-asc',
    label: '使用频次(从低到高)',
    checked: sortMode.value === 'count-asc'
  }
]);

function toggleSearch(): void {
  searchVisible.value = !searchVisible.value;
  if (searchVisible.value) {
    void nextTick(() => {
      document.querySelector<HTMLInputElement>('.ws-editor-tag__search input')?.focus();
    });
  } else {
    searchQuery.value = '';
  }
}

function toggleGroups(): void {
  if (groupsExpanded.value) {
    collapsedNodeKeys.value = new Set(expandableTagKeys.value);
    return;
  }

  collapsedNodeKeys.value = new Set();
}

function toggleNestedNode(node: TagTreeNode): void {
  if (node.children.size === 0) return;

  const nextCollapsed = new Set(collapsedNodeKeys.value);
  if (nextCollapsed.has(node.fullLabel)) {
    nextCollapsed.delete(node.fullLabel);
  } else {
    nextCollapsed.add(node.fullLabel);
  }
  collapsedNodeKeys.value = nextCollapsed;
}

function openSortMenu(event: MouseEvent): void {
  sortMenuTarget.value = event.currentTarget instanceof HTMLElement
    ? event.currentTarget
    : null;
  sortMenuOpen.value = true;
}

function selectSortMode(mode: TagSortMode): void {
  sortMode.value = mode;
  sortMenuOpen.value = false;
}

function handleSortMenuSelect(itemId: string): void {
  if (itemId === 'name-asc' || itemId === 'name-desc'
    || itemId === 'count-desc' || itemId === 'count-asc') {
    selectSortMode(itemId);
  }
}

async function refresh(): Promise<void> {
  const sequence = ++refreshSequence;
  const files = workspaceFiles.value.filter(file => markdownPattern.test(file.name));
  const snapshots = await Promise.all(files.map(file => workspaceApi.readMarkdownFile(file.path)));
  if (sequence !== refreshSequence) return;

  tags.value = snapshots.flatMap((snapshot) => {
    if (!snapshot) return [];
    const path = snapshot.relativePath.replace(/[\\/]+/gu, '/');
    return collectMarkdownTagLabels(snapshot.content).map((match: MarkdownTagMatch, index) => ({
      id: `${path}:${match.label}:${index}`,
      label: match.label,
      path,
      position: match.from
    }));
  });
}

async function openTag(item: EditorTagItem): Promise<void> {
  const request = await workspaceApi.openFile(item.path);
  if (!request || request.kind !== 'text') return;

  dockingThreeStore.openWorkspaceFile({
    ...request,
    position: item.position,
    selectionEnd: item.position + item.label.length,
    verticalAlignment: 'center' as const
  });
}

onMounted(() => {
  void workspaceStore.initialize().then(refresh);
});

watch(workspaceFiles, () => {
  void refresh();
}, { deep: true });

onBeforeUnmount(() => {
  refreshSequence += 1;
});
</script>

<template>
  <section class="ws-editor-tag" aria-label="标签">
    <header class="ws-editor-tag__header">
      <div class="ws-editor-tag__actions">
        <WsIconButton
          :icon="sortIcon"
          label="排序"
          tooltip="排序"
          class="ws-editor-tag__action"
          :active="sortMenuOpen"
          :aria-expanded="sortMenuOpen"
          aria-haspopup="menu"
          @click="openSortMenu"
        />
        <WsIconButton
          :icon="folderTreeIcon"
          label="显示嵌套"
          tooltip="显示嵌套"
          class="ws-editor-tag__action"
          :pressed="nestedVisible"
          @click="nestedVisible = !nestedVisible"
        />
        <WsIconButton
          :icon="groupsExpanded ? foldUpIcon : foldIcon"
          :label="groupsExpanded ? '折叠全部' : '展开全部'"
          :tooltip="groupsExpanded ? '折叠全部' : '展开全部'"
          class="ws-editor-tag__action"
          @click="toggleGroups"
        />
        <WsIconButton
          :icon="searchIcon"
          label="查找标签"
          tooltip="查找标签"
          class="ws-editor-tag__action"
          :active="searchVisible"
          @click="toggleSearch"
        />
      </div>
    </header>
    <WsMenu
      v-model:open="sortMenuOpen"
      :target="sortMenuTarget"
      :items="sortMenuItems"
      @select="handleSortMenuSelect"
    />
    <div v-if="searchVisible" class="ws-editor-tag__search">
      <WsSearchInput
        v-model="searchQuery"
        placeholder="查找标签"
        aria-label="查找标签"
      />
    </div>
    <div v-if="tags.length === 0" class="ws-editor-tag__empty">暂无标签</div>
    <div v-else-if="nestedVisible" class="ws-editor-tag__groups ws-editor-tag__groups--nested">
      <section
        v-for="visibleTag in visibleNestedTags"
        :key="visibleTag.node.fullLabel"
        class="ws-editor-tag__group ws-editor-tag__group--nested"
      >
        <div
          class="ws-editor-tag__row ws-editor-tag__row--nested"
          :class="{ 'ws-editor-tag__row--nested-child': visibleTag.depth > 0 }"
          :style="{ '--ws-editor-tag-depth': visibleTag.depth }"
          :role="visibleTag.node.children.size > 0 ? 'button' : undefined"
          :tabindex="visibleTag.node.children.size > 0 ? 0 : undefined"
          @click="visibleTag.node.children.size > 0 && toggleNestedNode(visibleTag.node)"
          @keydown.enter="visibleTag.node.children.size > 0 && toggleNestedNode(visibleTag.node)"
          @keydown.space.prevent="visibleTag.node.children.size > 0 && toggleNestedNode(visibleTag.node)"
          @dblclick="visibleTag.node.items[0] && openTag(visibleTag.node.items[0])"
        >
          <span class="ws-editor-tag__guides" aria-hidden="true">
            <span
              v-for="guideDepth in visibleTag.depth"
              :key="guideDepth"
              class="ws-editor-tag__guide"
              :style="{ insetInlineStart: `calc(3px + 0.5rem + ${(guideDepth - 1) * 0.75}rem)` }"
            />
          </span>
          <button
            v-if="visibleTag.node.children.size > 0"
            type="button"
            class="ws-editor-tag__disclosure"
            :aria-label="visibleTag.expanded ? '折叠标签' : '展开标签'"
            @click.stop="toggleNestedNode(visibleTag.node)"
          >
            <span
              aria-hidden="true"
              :class="visibleTag.expanded ? arrowDownIcon : arrowForwardIcon"
            />
          </button>
          <span v-else class="ws-editor-tag__disclosure-spacer" aria-hidden="true" />
          <span class="ws-editor-tag__label">{{ visibleTag.node.label }}</span>
          <span class="ws-editor-tag__count">{{ visibleTag.node.count }}</span>
        </div>
      </section>
    </div>
    <div v-else class="ws-editor-tag__groups">
      <section v-for="([label, items]) in flatGroupedTags" :key="label" class="ws-editor-tag__group">
        <div
          class="ws-editor-tag__row"
          @dblclick="items[0] && openTag(items[0])"
        >
          <span class="ws-editor-tag__label">{{ label.replace(/^#/u, '') }}</span>
          <span class="ws-editor-tag__count">{{ items.length }}</span>
        </div>
      </section>
    </div>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ws-editor-tag {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: auto;
  min-height: 100%;
  min-width: 0;
  overflow: visible;
  background: var(--ws-list-background);
}

.ws-editor-tag__header {
    background: var(--ws-list-background);
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: $spacing-xs;
  flex: none;
  min-width: 0;
  padding: $spacing-2xs $spacing-xs $spacing-2xs $spacing-md;
  border-bottom: 1px solid var(--ws-sideBarSectionHeader-border, var(--ws-border, transparent));
  font-size: $font-size-sm;
  font-weight: 600;
  :deep(.ws-icon-button){
    height: 1.5rem;
  }
}

.ws-editor-tag__title {
  min-width: 0;
}

.ws-editor-tag__actions {
  display: flex;
  align-items: center;
  flex: none;
  gap: $spacing-xs;
}

.ws-editor-tag__action {
  width: $button-width;
  min-width: $button-width;
  height: $button-height;
  min-height: $button-height;
}

.ws-editor-tag__action :deep(.ws-icon-button__icon) {
  width: $icon-size-width;
  height: $icon-size-height;
}

.ws-editor-tag__search {
  flex: none;
  padding: $spacing-xs;
}

.ws-editor-tag__groups {
  flex: 0 0 auto;
  min-width: 0;
  padding: $spacing-xs;
}

.ws-editor-tag__group {
  cursor: default;
}

.ws-editor-tag__group--nested {
  margin: 0;
}

.ws-editor-tag__row {
  display: flex;
  align-items: center;
  gap: $spacing-sm;
  min-width: 0;
  border-radius: $radius-xs;
  padding: 3px;
  margin-bottom: 3px;
}

.ws-editor-tag__row:hover {
  background: var(--ws-list-hoverBackground);
}

.ws-editor-tag__row--nested {
  position: relative;
  padding-inline-start: calc(3px + (var(--ws-editor-tag-depth) * 0.75rem));
}

.ws-editor-tag__row--nested-child {
  margin-bottom: 0;
}

.ws-editor-tag__guides {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.ws-editor-tag__guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ws-tree-indentGuidesStroke, var(--ws-border, transparent));
}

.ws-editor-tag__disclosure,
.ws-editor-tag__disclosure-spacer {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: $font-size-md;
  height: $font-size-md;
}

.ws-editor-tag__disclosure {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  cursor: default;
}

.ws-editor-tag__disclosure:hover {
  background: transparent;
}

.ws-editor-tag__disclosure {
  display: block;
  width: 100%;
  height: 100%;
}

.ws-editor-tag__label {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--ws-list-foreground, var(--ws-foreground));
  font-size: $font-size-sm;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-editor-tag__count {
  flex: 0 0 auto;
  min-width: 2ch;
  padding: 0 $spacing-2xs;
  color: var(--ws-descriptionForeground, var(--ws-foreground));
  font-size: $font-size-xs;
  line-height: 1.4;
  text-align: right;
}

.ws-editor-tag__empty {
  padding: $spacing-lg $spacing-md;
  color: var(--ws-descriptionForeground, var(--ws-foreground));
  font-size: $font-size-sm;
  text-align: center;
}
</style>
