<!--
  文件说明：渲染文件列表插件使用的左右分栏仓库管理对话框。
-->
<script setup lang="ts">
import { nextTick, ref } from 'vue';
import WsMenu from '@/components/WsMenu/WsMenu.vue';
const closeIcon = 'icon icon-close';
const checkedIcon = 'icon icon-check-gou-xuan';
const editorIcon = 'icon icon-editor';
const foldOpenIcon = 'icon icon-fold-open';
const folderTreeIcon = 'icon icon-folder-tree';
const moreVerticalIcon = 'icon icon-more-vertical';
import {
  formatFilePath,
  fullFilePath,
  type PathDisplayMode
} from '../../../plugin/sdk/path';
import type {
  PluginDialogPickItem,
  PluginDialogRepositoryAction
} from '../../../plugin/sdk';

interface RepositoryManagerDialogProps {
  title: string;
  items: readonly PluginDialogPickItem[];
  currentItemId?: string;
  version: string;
  actions: readonly PluginDialogRepositoryAction[];
  error?: string;
}

const props = withDefaults(defineProps<RepositoryManagerDialogProps>(), {
  currentItemId: undefined,
  error: undefined
});

const menuOpen = ref(false);
const menuTarget = ref<HTMLElement | null>(null);
const menuRepositoryId = ref<string>();
const pathDisplayMode = ref<PathDisplayMode>('compact');
const editingRepositoryId = ref<string>();
const editingName = ref('');
const inlineNameInput = ref<HTMLInputElement | null>(null);

const emit = defineEmits<{
  select: [itemId: string];
  action: [actionId: string];
}>();

/** 选择仓库并立即交给插件执行切换。 */
function selectRepository(item: PluginDialogPickItem): void {
  if (item.disabled) return;
  if (editingRepositoryId.value) {
    if (editingRepositoryId.value === item.id) return;
    cancelInlineRename();
  }
  emit('select', item.id);
}

/** 触发右侧仓库操作。 */
function selectAction(action: PluginDialogRepositoryAction): void {
  emit('action', action.id);
}

function openRepositoryMenu(item: PluginDialogPickItem, event: MouseEvent): void {
  event.stopPropagation();
  menuRepositoryId.value = item.id;
  menuTarget.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  menuOpen.value = true;
}

function selectRepositoryMenuAction(actionId: string): void {
  const repositoryId = menuRepositoryId.value;
  if (!repositoryId) return;
  menuOpen.value = false;
  if (actionId === 'rename') {
    const item = props.items.find(candidate => candidate.id === repositoryId);
    if (item && !item.disabled) beginInlineRename(item);
    return;
  }
  emit('action', `repository-action:${repositoryId}:${actionId}`);
}

/** 切换仓库路径显示模式，所有模式均从完整路径派生。 */
function setPathDisplayMode(mode: PathDisplayMode): void {
  pathDisplayMode.value = mode;
  menuOpen.value = false;
}

/** 将仓库名称切换为当前列表项内的可编辑输入框。 */
function beginInlineRename(item: PluginDialogPickItem): void {
  editingRepositoryId.value = item.id;
  editingName.value = repositoryName(item);
  void nextTick(() => {
    inlineNameInput.value?.focus();
    inlineNameInput.value?.select();
  });
}

/** 取消当前仓库的内联重命名，不提交任何动作。 */
function cancelInlineRename(): void {
  editingRepositoryId.value = undefined;
  editingName.value = '';
}

/** 提交内联仓库名称，名称由对话框响应传回文件列表插件。 */
function submitInlineRename(item: PluginDialogPickItem): void {
  const name = editingName.value.trim();
  if (!name) return;
  cancelInlineRename();
  emit('action', `repository-action:${item.id}:rename:${encodeURIComponent(name)}`);
}

/** 兼容旧版插件把完整路径写入 label 的情况，仓库名称始终取路径最后一级。 */
function isPathLike(value: string): boolean {
  return value.includes('\\') || value.includes('/') || /^[A-Za-z]:/u.test(value);
}

function repositoryName(item: PluginDialogPickItem): string {
  const label = item.label.trim();
  if (!isPathLike(label)) return label || '未命名仓库';
  const pathValue = (item.description ?? label).trim();
  const segments = pathValue.split(/[\\/]/u).filter(Boolean);
  return segments[segments.length - 1] || label || '未命名仓库';
}

function repositoryFullPath(item: PluginDialogPickItem): string | undefined {
  const description = item.description?.trim();
  if (description && isPathLike(description)) return fullFilePath(description);
  const label = item.label.trim();
  return isPathLike(label) ? fullFilePath(label) : undefined;
}

function repositoryPath(item: PluginDialogPickItem): string | undefined {
  const completePath = repositoryFullPath(item);
  return completePath ? formatFilePath(completePath, pathDisplayMode.value) : undefined;
}

</script>

<template>
  <div class="repository-manager-dialog" role="region" :aria-label="title">
      <section class="repository-manager-dialog__repositories" aria-label="仓库列表">
        <div v-if="items.length" class="repository-manager-dialog__list">
          <div
            v-for="item in items"
            :key="item.id"
            role="button"
            tabindex="0"
            class="repository-manager-dialog__repository"
            :class="{
              'repository-manager-dialog__repository--active': item.id === currentItemId,
              'repository-manager-dialog__repository--disabled': item.disabled
            }"
            :aria-disabled="item.disabled ? 'true' : undefined"
            :aria-current="item.id === currentItemId ? 'true' : undefined"
            @click="selectRepository(item)"
            @keydown.enter.prevent="selectRepository(item)"
            @keydown.space.prevent="selectRepository(item)"
          >
            <span class="repository-manager-dialog__repository-copy">
              <input
                v-if="editingRepositoryId === item.id"
                ref="inlineNameInput"
                v-model="editingName"
                type="text"
                class="repository-manager-dialog__repository-input"
                :aria-label="`重命名${repositoryName(item)}`"
                maxlength="200"
                @click.stop
                @keydown.stop
                @keydown.enter.prevent="submitInlineRename(item)"
                @keydown.esc.prevent="cancelInlineRename"
                @blur="cancelInlineRename"
              />
              <strong v-else class="repository-manager-dialog__repository-name">{{ repositoryName(item) }}</strong>
              <span v-if="repositoryPath(item)" class="repository-manager-dialog__repository-path">
                {{ repositoryPath(item) }}
              </span>
            </span>
            <button
              type="button"
              class="repository-manager-dialog__repository-more"
              :class="{
                'repository-manager-dialog__repository-more--open':
                  menuOpen && menuRepositoryId === item.id
              }"
              aria-label="仓库操作"
              aria-haspopup="menu"
              :aria-expanded="menuOpen && menuRepositoryId === item.id ? 'true' : 'false'"
              @click.stop="openRepositoryMenu(item, $event)"
              @keydown.stop
            ><span aria-hidden="true" :class="moreVerticalIcon" /></button>
          </div>
        </div>
        <p v-else class="repository-manager-dialog__empty">暂无仓库</p>
      </section>

      <WsMenu
        v-model:open="menuOpen"
        :target="menuTarget"
        :z-index="3000"
        content-class="repository-manager-menu"
      >
        <v-list density="compact" nav>
          <v-list-item title="重命名仓库" @click="selectRepositoryMenuAction('rename')">
            <template #prepend>
              <span class="repository-manager-menu__icon" aria-hidden="true" :class="editorIcon" />
            </template>
          </v-list-item>
          <v-list-item title="移动仓库" @click="selectRepositoryMenuAction('move')">
            <template #prepend>
              <span class="repository-manager-menu__icon" aria-hidden="true" :class="folderTreeIcon" />
            </template>
          </v-list-item>
          <v-divider />
          <v-list-item
            :aria-checked="pathDisplayMode === 'compact'"
            role="menuitemradio"
            title="层级忽略"
            @click="setPathDisplayMode('compact')"
          >
            <template #prepend>
              <span class="repository-manager-menu__check" aria-hidden="true">
                <span v-if="pathDisplayMode === 'compact'" :class="checkedIcon" />
              </span>
            </template>
          </v-list-item>
          <v-list-item
            :aria-checked="pathDisplayMode === 'with-drive'"
            role="menuitemradio"
            title="显示盘符"
            @click="setPathDisplayMode('with-drive')"
          >
            <template #prepend>
              <span class="repository-manager-menu__check" aria-hidden="true">
                <span v-if="pathDisplayMode === 'with-drive'" :class="checkedIcon" />
              </span>
            </template>
          </v-list-item>
          <v-list-item
            :aria-checked="pathDisplayMode === 'full'"
            role="menuitemradio"
            title="显示完整路径"
            @click="setPathDisplayMode('full')"
          >
            <template #prepend>
              <span class="repository-manager-menu__check" aria-hidden="true">
                <span v-if="pathDisplayMode === 'full'" :class="checkedIcon" />
              </span>
            </template>
          </v-list-item>
          <v-divider />
          <v-list-item title="在资源管理器中显示" @click="selectRepositoryMenuAction('reveal')">
            <template #prepend>
              <span class="repository-manager-menu__icon" aria-hidden="true" :class="foldOpenIcon" />
            </template>
          </v-list-item>
          <v-divider />
          <v-list-item
            class="repository-manager-menu__remove"
            title="从仓库列表中移除"
            @click="selectRepositoryMenuAction('remove')"
          >
            <template #prepend>
              <span class="repository-manager-menu__icon" aria-hidden="true" :class="closeIcon" />
            </template>
          </v-list-item>
        </v-list>
      </WsMenu>

      <aside class="repository-manager-dialog__aside" aria-label="仓库操作">
        <div class="repository-manager-dialog__brand">
          <img class="repository-manager-dialog__logo" src="/wslog2.png" alt="WStudio" />
          <h2 class="repository-manager-dialog__app-name">WStudio</h2>
          <span class="repository-manager-dialog__version">v{{ version }}</span>
        </div>

        <div class="repository-manager-dialog__actions">
          <article
            v-for="action in actions"
            :key="action.id"
            class="repository-manager-dialog__action"
          >
            <span class="repository-manager-dialog__action-copy">
              <strong class="repository-manager-dialog__action-label">{{ action.label }}</strong>
              <span class="repository-manager-dialog__action-description">{{ action.description }}</span>
            </span>
            <button
              type="button"
              class="repository-manager-dialog__action-button"
              @click="selectAction(action)"
            >
              {{ action.label }}
            </button>
          </article>
        </div>

        <p v-if="error" class="repository-manager-dialog__error" role="alert">{{ error }}</p>
      </aside>
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.repository-manager-dialog {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 7fr);
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.repository-manager-dialog__repositories {
  min-width: 0;
  padding: $spacing-xs;
}

.repository-manager-dialog__list {
  display: flex;
  flex-direction: column;
  gap: $spacing-xs;
}

.repository-manager-dialog__repository {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 1.25rem;
  align-items: center;
  gap: $spacing-sm;
  width: 100%;
  min-height: 3rem;
  border: 0;
  border-radius: $radius-xs;
  padding: 0 $spacing-sm;
  color: var(--ws-foreground);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.repository-manager-dialog__repository:hover,
.repository-manager-dialog__repository:focus-visible {
  background: var(--ws-list-hoverBackground);
  outline: none;
}

.repository-manager-dialog__repository--active {
  background: var(--ws-list-activeSelectionBackground);
}

.repository-manager-dialog__repository:disabled {
  cursor: default;
  opacity: 0.55;
}

.repository-manager-dialog__repository--disabled {
  cursor: default;
  opacity: 0.55;
}

.repository-manager-dialog__repository-copy {
  display: flex;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: $spacing-2xs;
  overflow: hidden;
}

.repository-manager-dialog__repository-name {
  display: block;
  max-width: 100%;
  overflow: visible;
  color: var(--ws-foreground);
  overflow-wrap: anywhere;
  font-size: $font-size-sm;
  font-weight: 700;
  line-height: 1.35;
}

.repository-manager-dialog__repository-input {
  display: block;
  width: 100%;
  min-width: 0;
  border: $input-border-width solid var(--ws-focusBorder);
  border-radius: $radius-2px;
  padding: 0 $spacing-2xs;
  color: var(--ws-foreground);
  background: var(--ws-input-background);
  font: inherit;
  line-height: 1.35;
  outline: none;
}

.repository-manager-dialog__action-label {
  display: block;
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--ws-foreground);
  font-size: $font-size-sm;
  font-weight: 700;
  line-height: 1.35;
}

.repository-manager-dialog__repository-path,
.repository-manager-dialog__action-description {
  display: block;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.repository-manager-dialog__repository-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  position: relative;
  z-index: 1;
  min-width: 1.25rem;
  flex: 0 0 1.25rem;
  width: 1.25rem;
  height: 1.25rem;
  color: var(--ws-descriptionForeground);
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
  border-radius: 3px;
}

.repository-manager-dialog__repository-more span,
.repository-manager-dialog__repository-more {
  display: block;
  width: 100%;
  height: 100%;
}

.repository-manager-dialog__repository-more:hover,
.repository-manager-dialog__repository-more:focus-visible,
.repository-manager-dialog__repository-more--open {
  color: var(--ws-foreground);
  background: var(--ws-button-hoverBackground);
  outline: none;
}

:global(.repository-manager-menu__remove),
:global(.repository-manager-menu__remove .v-list-item-title) {
  color: #FB464C !important;
}

:global(.repository-manager-menu__check) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
}

:global(.repository-manager-menu__check > span) {
  display: block;
  width: 1rem;
  height: 1rem;
}

:global(.repository-manager-menu__icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
}

.repository-manager-dialog__aside {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: $spacing-lg;
  border-left: $editor-table-border-width solid var(--ws-border);

}

.repository-manager-dialog__brand {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: $spacing-2xs;
  min-height: 0;
}

.repository-manager-dialog__logo {
  width: 7rem;
  height: 7rem;
  object-fit: contain;
}

.repository-manager-dialog__version {
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
}

.repository-manager-dialog__app-name {
  margin: 0;
  color: var(--ws-foreground);
  font-weight: 700;
  letter-spacing: 0;
  line-height: 1;
  margin-bottom: 11px;
}

.repository-manager-dialog__actions {
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding: $spacing-xl;
}

.repository-manager-dialog__action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-md;
  width: 100%;
  color: var(--ws-foreground);
  background: transparent;
  text-align: left;
}

.repository-manager-dialog__action-copy {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: $spacing-2xs;
}

.repository-manager-dialog__actions button{
  flex: 0 0 auto;
  border: $input-border-width solid var(--ws-border);
  border-radius: $radius-xs;
  padding: $spacing-2xs $spacing-sm;
  color: var(--ws-foreground);
  background: var(--ws-button-background, transparent);
  font-size: $font-size-xs;
  white-space: nowrap;
  height: 1.5rem;
  &:hover{
    background-color: var(--ws-button-hoverBackground);
  }
}


.repository-manager-dialog__error {
  margin: 0;
  color: var(--ws-errorForeground);
  font-size: $font-size-xs;
}

.repository-manager-dialog__empty {
  margin: 0;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-sm;
}

@media (max-width: 40rem) {
  .repository-manager-dialog {
    grid-template-columns: 1fr;
    gap: $spacing-lg;
  }

  .repository-manager-dialog__repositories {
    padding-right: 0;
  }

  .repository-manager-dialog__aside {
    border-top: $editor-table-border-width solid var(--ws-border);
    border-left: 0;
    padding-top: $spacing-lg;
    padding-left: 0;
  }
}
</style>
