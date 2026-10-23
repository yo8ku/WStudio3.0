<!-- 文件说明：渲染设置窗口的快捷键表格，展示命令、键绑定和来源。 -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

const checkIconMarkup = 'icon icon-check-gou-xuan';
import WsInput from '@/components/WsInput/WsInput.vue';
import WsSearchInput from '@/components/WsSearchInput/WsSearchInput.vue';
import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import WorkbenchDialog from '@/components/workbench/WorkbenchDialog.vue';
import { useShortcutStore } from '@/store/shortcuts';
const clearIcon = 'icon icon-clear';
const keyboardIcon = 'icon icon-keyboard';
const paiXuIcon = 'icon icon-pai-xu';
const penIcon = 'icon icon-pen';
const searchIcon = 'icon icon-search';
import { shortcutDefinitions, type ShortcutDefinition } from '@/utils/shortcutDefinitions';
import { WORKBENCH_TOOLTIP_OPEN_DELAY } from '@/utils/workbenchTooltip';

const searchQuery = ref('');
const shortcutStore = useShortcutStore();
const shortcutSource = '系统';
const actionButtonProps = {
  density: 'compact',
  icon: true,
  ripple: false,
  variant: 'text'
} as const;
const searchActionButtonProps = {
  density: 'compact',
  icon: true,
  ripple: false,
  variant: 'text'
} as const;
const shortcutFilterMenuProps = {
  contentClass: 'ws-menu shortcut-settings-panel__filter-menu',
  location: 'bottom end',
  transition: false
} as const;
const shortcutFilterListProps = {
  density: 'compact',
  nav: false
} as const;
const actionTooltipProps = {
  location: 'top',
  openDelay: WORKBENCH_TOOLTIP_OPEN_DELAY
} as const;
const editFieldProps = {
  density: 'compact',
  hideDetails: true,
  variant: 'outlined'
} as const;
const modifierKeyNames = new Set(['Control', 'Alt', 'Shift', 'Meta']);
const modifierLabels = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
const maxShortcutChordCount = 2;

interface ShortcutKeybindingPart {
  key: string;
  separator?: 'plus' | 'chord';
}

interface TextFieldInstance {
  $el?: HTMLElement;
}

type ShortcutFilter = 'all' | 'existing' | 'unrecorded' | 'recent';

interface ShortcutFilterOption {
  id: ShortcutFilter;
  label: string;
}

const shortcutFilterOptions: readonly ShortcutFilterOption[] = [
  { id: 'all', label: '全部' },
  { id: 'existing', label: '已有键' },
  { id: 'unrecorded', label: '未记录键' },
  { id: 'recent', label: '最新修改' }
];

/** 快捷键表格的列定义，首列预留给无标题操作区域。 */
const shortcutTableHeaders = [
  { key: 'leading-action', label: '' },
  { key: 'command', label: '命令' },
  { key: 'keybinding', label: '键绑定' },
  { key: 'source', label: '源' }
] as const;

const editingShortcut = ref<ShortcutDefinition>();
const capturedKeybinding = ref('');
const isEditDialogOpen = ref(false);
const isKeyboardFilterActive = ref(false);
const keyboardSearchBinding = ref('');
const isShortcutFilterMenuOpen = ref(false);
const selectedShortcutFilter = ref<ShortcutFilter>('all');
const shortcutModifiedAt = ref<Record<string, number>>({});
const duplicateBindingFilter = ref('');
const searchInputElement = ref<TextFieldInstance | null>(null);
const editInputElement = ref<TextFieldInstance | null>(null);
const displayedShortcutDefinitions = computed(() => shortcutDefinitions.map(shortcut => ({
  ...shortcut,
  keybinding: shortcut.implemented
    ? shortcutStore.getBinding(shortcut.command)
    : '-'
})));

/** 根据过滤菜单选项整理快捷键列表。 */
const shortcutFilterDefinitions = computed(() => {
  const definitions = displayedShortcutDefinitions.value;

  if (selectedShortcutFilter.value === 'existing') {
    return definitions.filter(shortcut => shortcut.keybinding !== '-');
  }

  if (selectedShortcutFilter.value === 'unrecorded') {
    return definitions.filter(shortcut => shortcut.keybinding === '-');
  }

  if (selectedShortcutFilter.value === 'recent') {
    return [...definitions].sort((left, right) => (
      (shortcutModifiedAt.value[right.command] ?? 0) -
      (shortcutModifiedAt.value[left.command] ?? 0)
    ));
  }

  return definitions;
});

/** 按键模式只改变搜索方式，不改变过滤菜单已选定的列表范围。 */
const keyboardFilteredShortcutDefinitions = computed(() => shortcutFilterDefinitions.value);

/** 根据搜索文本筛选命令、键绑定和描述。 */
const filteredShortcutDefinitions = computed(() => {
  if (duplicateBindingFilter.value) {
    const candidate = normalizeKeybinding(duplicateBindingFilter.value);

    return displayedShortcutDefinitions.value.filter(shortcut => (
      normalizeKeybinding(shortcut.keybinding) === candidate
    ));
  }

  if (isKeyboardFilterActive.value) {
    const query = normalizeKeybinding(keyboardSearchBinding.value);

    if (!query) {
      return keyboardFilteredShortcutDefinitions.value;
    }

    return keyboardFilteredShortcutDefinitions.value.filter(shortcut => (
      normalizeKeybinding(shortcut.keybinding).includes(query)
    ));
  }

  const query = searchQuery.value.trim().toLocaleLowerCase();

  if (!query) {
    return keyboardFilteredShortcutDefinitions.value;
  }

  return keyboardFilteredShortcutDefinitions.value.filter((shortcut) => (
    [shortcut.command, shortcut.keybinding, shortcut.description, shortcutSource]
      .some(value => value.toLocaleLowerCase().includes(query))
  ));
});

/** 切换只显示已有真实快捷键的命令。 */
function toggleKeyboardFilter(): void {
  isKeyboardFilterActive.value = !isKeyboardFilterActive.value;
  keyboardSearchBinding.value = '';
  searchQuery.value = '';
  duplicateBindingFilter.value = '';

  void nextTick().then(() => {
    searchInputElement.value?.$el?.querySelector('input')?.focus();
  });
}

/** 清空快捷键搜索文本。 */
function clearSearchQuery(): void {
  searchQuery.value = '';
  keyboardSearchBinding.value = '';
  duplicateBindingFilter.value = '';
}

/** 选择快捷键列表过滤方式并关闭菜单。 */
function selectShortcutFilter(filter: ShortcutFilter): void {
  selectedShortcutFilter.value = filter;
  isShortcutFilterMenuOpen.value = false;
  duplicateBindingFilter.value = '';
}

/** 展示当前快捷键绑定的全部重复命令。 */
function showDuplicateBindings(): void {
  if (!capturedKeybinding.value || duplicateBindingCount.value <= 0) {
    return;
  }

  const duplicateKeybinding = capturedKeybinding.value;
  const duplicateKeybindingPreview = formatKeybindingPreview(duplicateKeybinding);

  isKeyboardFilterActive.value = false;
  keyboardSearchBinding.value = '';
  searchQuery.value = duplicateKeybindingPreview;
  isEditDialogOpen.value = false;

  void nextTick().then(() => {
    duplicateBindingFilter.value = duplicateKeybinding;
    searchInputElement.value?.$el?.querySelector('input')?.focus();
  });
}

/** 处理已有键模式下的按键捕获，阻止按键转换为普通文本。 */
function handleKeyboardSearchKeydown(event: KeyboardEvent): void {
  if (!isKeyboardFilterActive.value || !(event.target instanceof HTMLInputElement)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (event.repeat) {
    return;
  }

  if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'Delete') {
    clearSearchQuery();
    return;
  }

  if (event.key === 'Enter') {
    return;
  }

  keyboardSearchBinding.value = resolvePressedKeybinding(event);
  searchQuery.value = formatKeybindingPreview(keyboardSearchBinding.value);
}

const capturedKeybindingPreview = computed(() => {
  if (!capturedKeybinding.value) {
    return '';
  }

  return formatKeybindingPreview(capturedKeybinding.value);
});

/** 将编辑框中的快捷键预览转换为小写，保持输入状态与键帽展示区分。 */
const capturedKeybindingInputValue = computed(() => capturedKeybindingPreview.value.toLocaleLowerCase());

const duplicateBindingCount = computed(() => {
  const candidate = normalizeKeybinding(capturedKeybinding.value);

  if (!candidate) {
    return 0;
  }

  return displayedShortcutDefinitions.value.filter(shortcut => (
    normalizeKeybinding(shortcut.keybinding) === candidate
  )).length;
});

/** 弹窗打开后将焦点交给输入框，确保光标始终可见。 */
watch(isEditDialogOpen, (open) => {
  if (!open) {
    return;
  }

  void nextTick().then(() => {
    editInputElement.value?.$el?.querySelector('input')?.focus();
  });
});

/** 用户重新输入普通搜索文本时退出重复绑定结果视图。 */
watch(searchQuery, (query, previousQuery) => {
  if (query !== previousQuery && duplicateBindingFilter.value) {
    duplicateBindingFilter.value = '';
  }
});

/** 统一快捷键文本格式，供重复绑定比较使用。 */
function normalizeKeybinding(keybinding: string): string {
  return keybinding.replace(/\s+/gu, '').toLocaleLowerCase();
}

/** 将浏览器键名转换为快捷键界面使用的简短名称。 */
function normalizePressedKey(key: string): string {
  const keyNames: Readonly<Record<string, string>> = {
    Control: 'Ctrl',
    Escape: 'Esc',
    ' ': 'Space',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    Backspace: 'Backspace',
    Delete: 'Delete',
    PageDown: 'PageDown',
    PageUp: 'PageUp'
  };

  const normalizedKey = keyNames[key] ?? key;

  return normalizedKey.length === 1 && /[a-z]/iu.test(normalizedKey)
    ? normalizedKey.toUpperCase()
    : normalizedKey;
}

/** 从键盘事件生成当前按键组合文本，支持多个修饰键与一个普通键。 */
function resolvePressedKeybinding(event: KeyboardEvent): string {
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : ''
  ].filter(Boolean);

  if (modifierKeyNames.has(event.key)) {
    return modifiers.join('+') || normalizePressedKey(event.key);
  }

  return [...modifiers, normalizePressedKey(event.key)].join('+');
}

/** 判断一个组合是否仍只包含修饰键，供串联快捷键持续捕获使用。 */
function isModifierOnlyKeybinding(keybinding: string): boolean {
  return modifierLabels.has(keybinding.split('+').at(-1) ?? '');
}

/** 格式化快捷键预览文本，并在仅有修饰键时保留加号提示。 */
function formatKeybindingPreview(keybinding: string): string {
  return keybinding
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((chord) => {
      const formatted = chord.split('+').join(' + ');
      return isModifierOnlyKeybinding(chord) ? `${formatted} +` : formatted;
    })
    .join(' ');
}

/** 更新快捷键组合，最多保留两组连续按键并允许重新编辑第二组。 */
function appendKeybinding(currentKeybinding: string, event: KeyboardEvent): string {
  if (event.repeat) {
    return currentKeybinding;
  }

  const nextKeybinding = resolvePressedKeybinding(event);
  const chords = currentKeybinding.trim().split(/\s+/u).filter(Boolean);
  const lastChord = chords.at(-1);

  if (!lastChord) {
    chords.push(nextKeybinding);
  } else if (isModifierOnlyKeybinding(lastChord)) {
    chords[chords.length - 1] = nextKeybinding;
  } else if (chords.length < maxShortcutChordCount) {
    chords.push(nextKeybinding);
  } else {
    chords[chords.length - 1] = nextKeybinding;
  }

  return chords.join(' ');
}

/** 将本次按键更新到快捷键编辑弹窗的当前组合。 */
function appendCapturedKeybinding(event: KeyboardEvent): void {
  capturedKeybinding.value = appendKeybinding(capturedKeybinding.value, event);
}

/** 打开指定快捷键的编辑弹窗。 */
function openShortcutEditor(shortcut: ShortcutDefinition): void {
  editingShortcut.value = shortcut;
  capturedKeybinding.value = '';
  isEditDialogOpen.value = true;
}

/** 提交当前捕获的快捷键组合，并关闭编辑弹窗。 */
function commitShortcutBinding(): void {
  const shortcut = editingShortcut.value;
  const keybinding = capturedKeybinding.value;
  const lastChord = keybinding.trim().split(/\s+/u).at(-1) ?? '';

  if (!shortcut || !keybinding || isModifierOnlyKeybinding(lastChord)) {
    return;
  }

  shortcutStore.setBinding(shortcut.command, keybinding);
  shortcutModifiedAt.value = {
    ...shortcutModifiedAt.value,
    [shortcut.command]: Date.now()
  };
  isEditDialogOpen.value = false;
}

/** 处理编辑弹窗中的 Escape、Enter 和快捷键捕获事件。 */
function handleEditDialogKeydown(event: KeyboardEvent): void {
  if (!(event.target instanceof HTMLInputElement)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    isEditDialogOpen.value = false;
    return;
  }

  if (event.key === 'Enter') {
    commitShortcutBinding();
    return;
  }

  appendCapturedKeybinding(event);
}

/** 将快捷键拆分为独立按键，并保留组合键与连续键组之间的分隔关系。 */
function getKeybindingParts(keybinding: string): readonly ShortcutKeybindingPart[] {
  const parts: ShortcutKeybindingPart[] = [];
  const chords = keybinding.trim().split(/\s+/u).filter(Boolean);

  chords.forEach((chord, chordIndex) => {
    chord.split('+').filter(Boolean).forEach((key, keyIndex) => {
      const separator = keyIndex > 0 ? 'plus' : chordIndex > 0 ? 'chord' : undefined;
      parts.push({
        key,
        ...(separator ? { separator } : {})
      });
    });
  });

  return parts;
}
</script>

<template>
  <section class="shortcut-settings-panel" aria-label="快捷键列表">
    <div class="shortcut-settings-panel__toolbar">
      <!-- S = 快捷键搜索框 -->
      <WsSearchInput
        ref="searchInputElement"
        v-model="searchQuery"
        aria-label="搜索快捷键"
        class="shortcut-settings-panel__search"
        placeholder="搜索快捷键"
        :spellcheck="false"
        @keydown="handleKeyboardSearchKeydown"
      >
        <template #prepend-inner>
          <span
            aria-hidden="true"
            class="shortcut-settings-panel__search-icon"
            :class="searchIcon"
          />
        </template>
        <template #append-inner>
          <v-btn
            v-bind="searchActionButtonProps"
            :aria-pressed="isKeyboardFilterActive"
            aria-label="已有键"
            class="shortcut-settings-panel__search-action shortcut-settings-panel__search-action--keyboard"
            :class="{ 'shortcut-settings-panel__search-action--selected': isKeyboardFilterActive }"
            @click.stop="toggleKeyboardFilter"
          >
            <span
              aria-hidden="true"
              class="shortcut-settings-panel__keyboard-icon"
              :class="keyboardIcon"
            />
          </v-btn>
          <v-menu
            v-model="isShortcutFilterMenuOpen"
            v-bind="shortcutFilterMenuProps"
          >
            <template #activator="{ props: filterMenuActivatorProps }">
              <v-btn
                v-bind="{ ...searchActionButtonProps, ...filterMenuActivatorProps }"
                :aria-pressed="selectedShortcutFilter !== 'all'"
                aria-label="过滤快捷键"
                class="shortcut-settings-panel__search-action shortcut-settings-panel__search-action--filter"
                :class="{
                  'shortcut-settings-panel__search-action--selected': selectedShortcutFilter !== 'all',
                  'shortcut-settings-panel__search-action--open': isShortcutFilterMenuOpen
                }"
              >
                <span
                  aria-hidden="true"
                  class="shortcut-settings-panel__filter-icon"
                  :class="paiXuIcon"
                />
              </v-btn>
            </template>
            <v-list v-bind="shortcutFilterListProps">
              <v-list-item
                v-for="option in shortcutFilterOptions"
                :key="option.id"
                :active="selectedShortcutFilter === option.id"
                :aria-checked="selectedShortcutFilter === option.id"
                role="menuitemradio"
                :title="option.label"
                @click="selectShortcutFilter(option.id)"
              >
                <template #append>
                  <span
                    aria-hidden="true"
                    class="shortcut-settings-panel__filter-check"
                    :class="{ 'shortcut-settings-panel__filter-check--visible': selectedShortcutFilter === option.id }"
                  >
                    <span v-if="selectedShortcutFilter === option.id" :class="checkIconMarkup" />
                  </span>
                </template>
              </v-list-item>
            </v-list>
          </v-menu>
          <v-btn
            v-bind="searchActionButtonProps"
            :aria-label="searchQuery || keyboardSearchBinding ? '清除搜索' : '没有可清除的搜索'"
            class="shortcut-settings-panel__search-action shortcut-settings-panel__search-action--clear"
            :disabled="!searchQuery && !keyboardSearchBinding"
            @click.stop="clearSearchQuery"
          >
            <span
              aria-hidden="true"
              class="shortcut-settings-panel__clear-icon"
              :class="clearIcon"
            />
          </v-btn>
        </template>
      </WsSearchInput>
      <!-- E = 快捷键搜索框 -->
    </div>

    <v-table class="shortcut-settings-panel__table" density="compact">
      <thead>
        <tr>
          <th
            v-for="header in shortcutTableHeaders"
            :key="header.key"
            scope="col"
            :aria-hidden="header.label.length === 0"
          >
            {{ header.label }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="shortcut in filteredShortcutDefinitions" :key="shortcut.command">
          <td class="shortcut-settings-panel__action-cell">
            <WsTooltip
              v-bind="actionTooltipProps"
              text="更改快捷键(按回车)"
            >
              <template #activator="{ props: tooltipProps }">
                <v-btn
                  v-bind="{ ...actionButtonProps, ...tooltipProps }"
                  aria-label="更改快捷键(按回车)"
                  class="shortcut-settings-panel__row-action"
                  :disabled="!shortcut.implemented"
                  @click.stop="openShortcutEditor(shortcut)"
                >
                  <span
                    aria-hidden="true"
                    class="shortcut-settings-panel__row-action-icon"
                    :class="penIcon"
                  />
                </v-btn>
              </template>
            </WsTooltip>
          </td>
          <td class="shortcut-settings-panel__command">{{ shortcut.command }}</td>
          <td>
            <span
              v-if="shortcut.keybinding === '-'"
              aria-label="无快捷键"
              class="shortcut-settings-panel__keybinding-empty"
            >
              -
            </span>
            <code
              v-else
              :aria-label="shortcut.keybinding"
              class="shortcut-settings-panel__keybinding"
            >
              <template
                v-for="(part, partIndex) in getKeybindingParts(shortcut.keybinding)"
                :key="`${shortcut.keybinding}-${partIndex}`"
              >
                <span
                  v-if="part.separator"
                  aria-hidden="true"
                  class="shortcut-settings-panel__keybinding-separator"
                  :class="`shortcut-settings-panel__keybinding-separator--${part.separator}`"
                >
                  {{ part.separator === 'plus' ? '+' : '' }}
                </span>
                <kbd class="shortcut-settings-panel__key">{{ part.key }}</kbd>
              </template>
            </code>
          </td>
          <td class="shortcut-settings-panel__source">{{ shortcutSource }}</td>
        </tr>
      </tbody>
    </v-table>

    <!-- S = 快捷键编辑弹窗 -->
    <WorkbenchDialog
      v-model="isEditDialogOpen"
      content-class="shortcut-settings-panel__edit-dialog"
      @keydown="handleEditDialogKeydown"
    >
      <p class="shortcut-settings-panel__edit-hint">
        按下所需的按键组合，然后按Enter键。
      </p>
      <WsInput
        v-bind="editFieldProps"
        aria-label="按键组合"
        autofocus
        class="shortcut-settings-panel__edit-input"
        ref="editInputElement"
        :model-value="capturedKeybindingInputValue"
        :spellcheck="false"
      />
      <code
        v-if="capturedKeybindingPreview"
        aria-label="当前按键组合"
        class="shortcut-settings-panel__keybinding shortcut-settings-panel__edit-preview"
      >
        <template
          v-for="(part, partIndex) in getKeybindingParts(capturedKeybinding)"
          :key="`edit-${capturedKeybinding}-${partIndex}`"
        >
          <span
            v-if="part.separator"
            aria-hidden="true"
            class="shortcut-settings-panel__keybinding-separator"
            :class="`shortcut-settings-panel__keybinding-separator--${part.separator}`"
          >
            {{ part.separator === 'plus' ? '+' : '' }}
          </span>
          <kbd class="shortcut-settings-panel__key">{{ part.key }}</kbd>
        </template>
      </code>
      <p
        v-if="duplicateBindingCount > 0"
        class="shortcut-settings-panel__duplicate-warning"
      >
        <button
          class="shortcut-settings-panel__duplicate-warning-action"
          type="button"
          @click="showDuplicateBindings"
        >
          已有{{ duplicateBindingCount }}个命令具有此快捷键绑定
        </button>
      </p>
    </WorkbenchDialog>
    <!-- E = 快捷键编辑弹窗 -->
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.shortcut-settings-panel {
  min-width: 0;
  color: var(--ws-foreground);
}

.shortcut-settings-panel__toolbar {
  @include flex-align-center;

  min-width: 0;
  margin-bottom: $spacing-md;
}

.shortcut-settings-panel__search {
  width: $settings-option-control-width;
  max-width: 100%;
}

.shortcut-settings-panel__search :deep(.v-input__control),
.shortcut-settings-panel__search :deep(.v-field) {
  min-height: $settings-plugin-search-height;
}

.shortcut-settings-panel__search :deep(.v-field__input) {
  min-height: $settings-plugin-search-height;
  padding-block: $spacing-none;
  font-size: $font-size-xs;
}

.shortcut-settings-panel__search :deep(.v-field__prepend-inner),
.shortcut-settings-panel__search :deep(.v-field__append-inner) {
  align-items: center;
  align-self: stretch;
  height: 100%;
  padding-block: $spacing-none;
}

.shortcut-settings-panel__search-icon,
.shortcut-settings-panel__keyboard-icon,
.shortcut-settings-panel__clear-icon,
.shortcut-settings-panel__filter-icon {
  flex: none;
  display: block;
  width: $font-size-md;
  height: $font-size-md;
  font-size: $font-size-md;
  line-height: 1;
  pointer-events: none;
}

.shortcut-settings-panel__search-action {
  display: inline-flex;
  align-items: center;
  align-self: center;
  justify-content: center;
  width: $settings-plugin-action-icon-size + $spacing-2xs;
  min-width: $settings-plugin-action-icon-size + $spacing-2xs;
  min-height: $settings-plugin-action-icon-size + $spacing-2xs;
  height: $settings-plugin-action-icon-size + $spacing-2xs;
  padding: $spacing-none;
  border-radius: $radius-xs !important;
  color: var(--ws-icon-foreground);
}

.shortcut-settings-panel__search-action > :deep(.v-btn__overlay) {
  background: transparent !important;
  opacity: 0 !important;
}

.shortcut-settings-panel__search-action--keyboard {
  cursor: default;
}

.shortcut-settings-panel__search-action--selected {
  color: var(--ws-icon-hoverForeground);
  background: var(--ws-icon-hoverBackground);
}

.shortcut-settings-panel__search-action:hover,
.shortcut-settings-panel__search-action--open {
  color: var(--ws-icon-hoverForeground);
  background: var(--ws-icon-hoverBackground);
}

:global(.shortcut-settings-panel__filter-menu) {
  min-width: $settings-shortcut-filter-menu-width;
}

.shortcut-settings-panel__filter-check {
  display: block;
  width: $settings-plugin-action-icon-size;
  height: $settings-plugin-action-icon-size;
  color: var(--ws-icon-foreground);
}

.shortcut-settings-panel__filter-check > span {
  display: block;
  width: 100%;
  height: 100%;
}

.shortcut-settings-panel__filter-check > span {
  width: 100%;
  height: 100%;
}

.shortcut-settings-panel__table {
  width: 100%;
  table-layout: fixed;
  color: inherit;
  background: transparent;

}

.shortcut-settings-panel__table :deep(table) {
  width: 100%;
  min-width: 0;
}

.shortcut-settings-panel__table :deep(.v-table__wrapper) {
  overflow-x: hidden;
}

.shortcut-settings-panel__table :deep(th),
.shortcut-settings-panel__table :deep(td) {
  box-sizing: border-box;
  height: $settings-option-row-min-height;
  padding: $spacing-xs $spacing-sm;
  border-bottom: 0;
  font-size: $font-size-sm;
  text-align: start;
  vertical-align: middle;
}

.shortcut-settings-panel__table :deep(thead) {
  background: var(--ws-KeyBinding-headBackground);
}

.shortcut-settings-panel__table :deep(tbody td) {
  border-inline-end: $input-border-width solid var(--ws-border);
}

.shortcut-settings-panel__table :deep(tbody tr:hover) {
  background: var(--ws-KeyBinding-hoverBackground);
}

.shortcut-settings-panel__table :deep(th) {
  color: var(--ws-KeyBinding-headForeground);
  font-size: $font-size-xs;
  font-weight: $editor-table-header-font-weight;
  white-space: nowrap;
}

.shortcut-settings-panel__table :deep(th:first-child),
.shortcut-settings-panel__table :deep(td:first-child) {
  width: $settings-shortcut-action-column-width;
  padding-inline: $spacing-xs;
}

.shortcut-settings-panel__table :deep(th:nth-child(2)),
.shortcut-settings-panel__table :deep(td:nth-child(2)) {
  width: $settings-shortcut-command-column-width;
}

.shortcut-settings-panel__table :deep(th:nth-child(3)),
.shortcut-settings-panel__table :deep(td:nth-child(3)) {
  width: $settings-shortcut-keybinding-column-width;
}

.shortcut-settings-panel__table :deep(th:nth-child(4)),
.shortcut-settings-panel__table :deep(td:nth-child(4)) {
  width: $settings-shortcut-source-column-width;
}

.shortcut-settings-panel__table :deep(th:last-child),
.shortcut-settings-panel__table :deep(td:last-child) {
  border-inline-end: 0;
}

.shortcut-settings-panel__command {
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shortcut-settings-panel__action-cell {
  padding-block: $spacing-none !important;
}

.shortcut-settings-panel__row-action {
  width: $settings-plugin-action-size;
  min-width: $settings-plugin-action-size;
  height: $settings-plugin-action-size;
  padding: $spacing-none;
  border-radius: $radius-xs !important;
  color: var(--ws-descriptionForeground);
  opacity: 0;
  transition: opacity $docking-splitter-hover-duration ease;
}

.shortcut-settings-panel__row-action-icon {
  display: block;
  width: $settings-plugin-action-icon-size;
  height: $settings-plugin-action-icon-size;
  font-size: $settings-plugin-action-icon-size;
  line-height: 1;
  pointer-events: none;
}

.shortcut-settings-panel__table :deep(tr:hover) .shortcut-settings-panel__row-action,
.shortcut-settings-panel__row-action:focus-visible {
  opacity: 1;
}

.shortcut-settings-panel__keybinding {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  color: var(--ws-KeyBinding-foreground);
  white-space: nowrap;
}

.shortcut-settings-panel__keybinding-empty {
  color: var(--ws-descriptionForeground);
}

.shortcut-settings-panel__key {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: $font-size-md;
  padding: $spacing-3xs $spacing-2xs;
  color: inherit;
  font-size: $font-size-xs;
  line-height: 1.2;
  background: var(--ws-KeyBinding-keyBackground);
  border: $input-border-width solid var(--ws-KeyBinding-border,transparent);
  border-radius: $radius-2px;
}

.shortcut-settings-panel__keybinding-separator {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--ws-descriptionForeground);
  margin-inline: $menu-compact-spacing;
}

.shortcut-settings-panel__keybinding-separator--chord {
  width: $spacing-xs;
}

.shortcut-settings-panel__edit-hint {
  margin: 0 0 $spacing-sm;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-sm;
  line-height: 1.4;
  text-align: center;
}

.shortcut-settings-panel__edit-input {
  width: 100%;
}

.shortcut-settings-panel__edit-input :deep(.v-field__input),
.shortcut-settings-panel__edit-input :deep(input) {
  text-align: center;
}

.shortcut-settings-panel__edit-input :deep(input) {
  caret-color: var(--ws-foreground);
}

.shortcut-settings-panel__edit-preview {
  justify-content: center;
  min-height: $font-size-md;
  margin-top: $spacing-2xs;
}

.shortcut-settings-panel__duplicate-warning {
  margin: $spacing-xs 0 0;
  font-size: $font-size-xs;
  line-height: 1.4;
  text-align: center;
  color: var(--ws-warningForeground);
}

.shortcut-settings-panel__duplicate-warning-action {
  padding: $spacing-none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  text-underline-offset: $spacing-3xs;
  cursor: pointer;
}

.shortcut-settings-panel__source {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
