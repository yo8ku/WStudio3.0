<script setup lang="ts">
/**
 * 文件说明：渲染工作台欢迎标签页，提供启动入口与最近文件记录的静态展示。
 */
import { computed, ref } from 'vue';

import { useDockingThreeStore } from '@/store/dockingThree';

const closeIcon = 'icon icon-close';
const fileIcon = 'icon icon-file';
const folderIcon = 'icon icon-folder';
const gitIcon = 'icon icon-git';
const newFileIcon = 'icon icon-new-file';

interface WorkbenchWelcomeActionItem {
  id: string;
  title: string;
  shortcut: string;
  iconClass: string;
}

interface WorkbenchWelcomeRecentItem {
  id: string;
  title: string;
  path: string;
  iconClass: string;
}

interface WorkbenchWelcomeDisplayItem {
  id: string;
  title: string;
  iconClass: string;
}

interface WorkbenchWelcomeRecentDisplayItem extends WorkbenchWelcomeDisplayItem {
  path: string;
}

interface WorkbenchWelcomeTabProps {
  groupId: string;
  tabId: string;
}

const props = defineProps<WorkbenchWelcomeTabProps>();

/**
 * 统一收敛欢迎页列表的展示属性，保持模板仅表达结构语义。
 */
const welcomeListProps = {
  density: 'compact'
} as const;

/**
 * 统一关闭启动入口的按压波纹，避免鼠标按下时出现背景底色。
 */
const startupListItemProps = {
  ripple: false
} as const;

/**
 * 统一收敛最近记录关闭按钮的展示属性，避免模板内散落样式型组件参数。
 */
const recentCloseButtonProps = {
  density: 'compact',
  ripple: false,
  variant: 'text'
} as const;

const projectName = 'WStudio';
const dockingThreeStore = useDockingThreeStore();

const startupItems: readonly WorkbenchWelcomeActionItem[] = [
  {
    id: 'new-file',
    title: '新建文件',
    shortcut: 'Ctrl + N',
    iconClass: newFileIcon
  },
  {
    id: 'open-file',
    title: '打开文件',
    shortcut: 'Ctrl + O',
    iconClass: folderIcon
  },
  {
    id: 'import-repository',
    title: '导入仓库',
    shortcut: 'Ctrl + L',
    iconClass: gitIcon
  }
] as const;

const recentItems = ref<WorkbenchWelcomeRecentItem[]>([
  {
    id: 'recent-1',
    title: '脑子没货，肚子没墨水，强烈建议...',
    path: 'C:\\Users\\Administrator\\Desktop\\书冲文案\\data',
    iconClass: fileIcon
  },
  {
    id: 'recent-2',
    title: '能力没那么重要，真正能让人成功...',
    path: 'C:\\Users\\Administrator\\Desktop\\书冲文案\\data',
    iconClass: fileIcon
  },
  {
    id: 'recent-3',
    title: '你不被二观，就敢不到大钱！...',
    path: 'C:\\Users\\Administrator\\Desktop\\书冲文案\\data',
    iconClass: fileIcon
  },
  {
    id: 'recent-4',
    title: '贫穷的本质是拖延，拖延的本质又...',
    path: 'C:\\Users\\Administrator\\Desktop\\书冲文案\\data',
    iconClass: fileIcon
  },
  {
    id: 'recent-5',
    title: '沟通能力强的人，说话都套用了这5...',
    path: 'C:\\Users\\Administrator\\Desktop\\书冲文案\\data',
    iconClass: fileIcon
  }
]);

/**
/**
 * 构建启动区展示数据，避免模板中混入图标样式拼接逻辑。
 */
function buildActionDisplayItems(
  items: readonly WorkbenchWelcomeActionItem[]
): WorkbenchWelcomeDisplayItem[] {
  return items.map((item) => ({
    id: item.id,
    title: `${item.title} (${item.shortcut})`,
    iconClass: item.iconClass
  }));
}

/**
 * 构建最近文件展示数据，统一收敛路径与图标表现层字段。
 */
function buildRecentDisplayItems(
  items: readonly WorkbenchWelcomeRecentItem[]
): WorkbenchWelcomeRecentDisplayItem[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    path: item.path,
    iconClass: item.iconClass
  }));
}

const startupDisplayItems = buildActionDisplayItems(startupItems);
const recentDisplayItems = computed(() => buildRecentDisplayItems(recentItems.value));

/**
 * 处理欢迎页启动入口点击，复用现有编辑器标签创建能力。
 */
function handleActionClick(itemId: string): void {
  if (itemId !== 'new-file') {
    return;
  }

  dockingThreeStore.replaceWelcomeTabWithEditor(props.groupId, props.tabId);
}

/**
 * 关闭欢迎页最近列表中的指定记录，仅更新当前标签页的展示状态。
 */
function closeRecentItem(itemId: string): void {
  recentItems.value = recentItems.value.filter((item) => item.id !== itemId);
}
</script>

<template>
  <v-sheet
    class="workbench-welcome-tab rounded-0"
  >
    <div class="workbench-welcome-tab__content">
      <header class="workbench-welcome-tab__header">
        <h1 class="workbench-welcome-tab__title">{{ projectName }}</h1>
      </header>

      <section class="workbench-welcome-tab__section">
        <h2 class="workbench-welcome-tab__section-title">启动</h2>

        <v-list
          v-bind="welcomeListProps"
          class="workbench-welcome-tab__list"
        >
          <v-list-item
            v-for="item in startupDisplayItems"
            :key="item.id"
            v-bind="startupListItemProps"
            class="workbench-welcome-tab__list-item workbench-welcome-tab__list-item--action"
            @click="handleActionClick(item.id)"
          >
            <template #prepend>
              <span
                class="workbench-welcome-tab__icon"
                :class="item.iconClass"
              />
            </template>

            <span class="workbench-welcome-tab__action-title">{{ item.title }}</span>
          </v-list-item>
        </v-list>
      </section>

      <section class="workbench-welcome-tab__section">
        <h2 class="workbench-welcome-tab__section-title">最近</h2>

        <v-list
          v-bind="welcomeListProps"
          class="workbench-welcome-tab__list"
        >
          <v-list-item
            v-for="item in recentDisplayItems"
            :key="item.id"
            class="workbench-welcome-tab__list-item workbench-welcome-tab__list-item--recent"
          >
            <template #prepend>
              <span
                class="workbench-welcome-tab__icon"
                :class="item.iconClass"
              />
            </template>

            <div class="workbench-welcome-tab__recent-row">
              <span class="workbench-welcome-tab__recent-title">{{ item.title }}</span>
              <span class="workbench-welcome-tab__recent-path">{{ item.path }}</span>
            </div>

            <template #append>
              <v-btn
                v-bind="recentCloseButtonProps"
                class="workbench-welcome-tab__recent-close"
                :aria-label="`关闭 ${item.title}`"
                @pointerdown.stop
                @click.stop="closeRecentItem(item.id)"
              >
                <span
                  class="workbench-welcome-tab__recent-close-icon"
                  :class="closeIcon"
                />
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </section>
    </div>
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.workbench-welcome-tab {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--ws-editor-background);
  color: var(--ws-foreground);
  user-select: none;
  -webkit-user-select: none;
}

.workbench-welcome-tab__content {
  @include flex-column;
  gap: $spacing-xl;
  width: 100%;
  min-height: 100%;
  padding: $spacing-xl;
}

.workbench-welcome-tab__header {
  padding-top: $spacing-xl;
}

.workbench-welcome-tab__title {
  margin: 0;
  font-size: $editor-heading-size;
  font-weight: $editor-heading-font-weight;
  line-height: $editor-heading-line-height;
  color: var(--ws-newPage-titleColor);
}

.workbench-welcome-tab__section {
  @include flex-column;
  gap: $spacing-sm;
  cursor: default;
}

.workbench-welcome-tab__section-title {
  margin: 0;
  font-size: $font-size-xl;
  font-weight: $editor-heading-font-weight;
  line-height: $editor-heading-line-height;
  color: var(--ws-newPage-titleColor);
}

.workbench-welcome-tab__list {
  padding: 0;
  background: transparent;
}

.workbench-welcome-tab__list-item {
  min-height: 2rem;
  padding-inline: 0;
  color: inherit;
}

.workbench-welcome-tab__list-item--action {
  width: fit-content;
  max-width: 100%;
}

.workbench-welcome-tab__list-item:deep(.v-list-item__prepend) {
  margin-right: $spacing-sm;
}

.workbench-welcome-tab__list-item:deep(.v-list-item__content) {
  overflow: hidden;
}

.workbench-welcome-tab__list-item:deep(.v-list-item__append) {
  margin-left: $spacing-xs;
}

.workbench-welcome-tab__list-item:deep(.v-list-item__overlay) {
  display: none;
}

.workbench-welcome-tab__list-item:hover {
  color: var(--ws-newPage-hoverForeground);
}

.workbench-welcome-tab__list-item:hover .workbench-welcome-tab__icon,
.workbench-welcome-tab__list-item:hover .workbench-welcome-tab__action-title,
.workbench-welcome-tab__list-item:hover .workbench-welcome-tab__recent-title,
.workbench-welcome-tab__list-item:hover .workbench-welcome-tab__recent-path {
  color: var(--ws-newPage-hoverForeground);

}

.workbench-welcome-tab__icon {
  display: block;
  width: $font-size-sm;
  height: $font-size-sm;
  background-color: currentColor;
  color: var(--ws-newPage-foreground);
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
}

.workbench-welcome-tab__action-title,
.workbench-welcome-tab__recent-title {
  display: block;
  flex: 0 1 16rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-welcome-tab__action-title,
.workbench-welcome-tab__recent-title,
.workbench-welcome-tab__recent-path {
  color: var(--ws-newPage-foreground);
  line-height: 1.4;
  font-size: $font-size-sm;
}

.workbench-welcome-tab__recent-row {
  display: flex;
  align-items: center;
  gap: $spacing-md;
  min-width: 0;
}

.workbench-welcome-tab__recent-close {
  @include flex-center;
  width: $editor-header-action-width;
  min-width: $editor-header-action-width;
  height: $editor-header-action-height;
  min-height: $editor-header-action-height;
  padding: 0;
  color: var(--ws-newPage-hoverForeground);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  border-radius: $radius-xs;
}

.workbench-welcome-tab__list-item--recent:hover .workbench-welcome-tab__recent-close,
.workbench-welcome-tab__list-item--recent:focus-within .workbench-welcome-tab__recent-close {
  color: var(--ws-newPage-hoverForeground);
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.workbench-welcome-tab__recent-close :deep(.v-btn__content) {
  @include flex-center;
}

.workbench-welcome-tab__recent-path {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workbench-welcome-tab__recent-close-icon {
  @extend .workbench-welcome-tab__icon;
  color: inherit;
}
</style>
