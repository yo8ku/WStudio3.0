<script setup lang="ts">
/** 文件说明：提供编辑器设置页中的字体大小、字体族与快速字号调整选项。 */
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import { systemApi } from '@/api/system';
const arrowBackIcon = 'icon icon-arrow-back';
const arrowForwardIcon = 'icon icon-arrow-forward';
const closeIcon = 'icon icon-close';
const menuIcon = 'icon icon-menu';
const searchIcon = 'icon icon-search';
import WsInput from '@/components/WsInput/WsInput.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsSwitch from '@/components/WsSwitch/WsSwitch.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import { useEditorSettingsStore } from '@/store/editorSettings';

const DEFAULT_FONT_SIZE = '14';
const MAX_FONT_SIZE = 30;

const editorFontSizeInput = ref(DEFAULT_FONT_SIZE);
const fontSizeEditBaseline = ref(DEFAULT_FONT_SIZE);
const fontSizeError = ref('');
const quickFontSizeEnabled = ref(true);
const showFontFamilyPage = ref(false);
const fontSearchQuery = ref('');
const draggedFontIndex = ref<number | null>(null);
const dragOverFontIndex = ref<number | null>(null);
const selectedFontListElement = ref<HTMLElement | null>(null);
let fontDragPointerId: number | undefined;
const editorSettingsStore = useEditorSettingsStore();
const { editorFontFamily, editorFontSize, selectedFontFamilies } = storeToRefs(editorSettingsStore);
const fontFamilyOptions = ref<string[]>([]);
const filteredFontFamilyOptions = computed(() => {
  const query = fontSearchQuery.value.trim().toLocaleLowerCase();
  return fontFamilyOptions.value.filter(fontFamily => (
    !selectedFontFamilies.value.includes(fontFamily)
    && (!query || fontFamily.toLocaleLowerCase().includes(query))
  ));
});

function getFontSizeDigits(value: string | number): string {
  return String(value).replace(/\D/gu, '').slice(0, 3);
}

function handleFontSizeFocus(): void {
  fontSizeEditBaseline.value = editorFontSize.value;
}

function handleFontSizeInput(value: string | number): void {
  const digits = getFontSizeDigits(value);
  editorFontSizeInput.value = digits;
  if (!digits) {
    fontSizeError.value = '值必须为数字。';
    editorSettingsStore.setEditorFontSize(fontSizeEditBaseline.value);
    return;
  }
  if (Number(digits) > MAX_FONT_SIZE) {
    fontSizeError.value = '值必须小于或等于30';
    return;
  }
  fontSizeError.value = '';
  editorSettingsStore.setEditorFontSize(digits);
}

function handleFontSizeBlur(): void {
  const digits = getFontSizeDigits(editorFontSizeInput.value);
  if (!digits) {
    fontSizeError.value = '值必须为数字。';
    editorSettingsStore.setEditorFontSize(fontSizeEditBaseline.value);
    return;
  }
  const normalizedDigits = Number(digits) > MAX_FONT_SIZE
    ? digits.slice(0, -1)
    : digits;
  editorFontSizeInput.value = normalizedDigits;
  fontSizeError.value = '';
  editorSettingsStore.setEditorFontSize(normalizedDigits);
}

const fontSizeModel = computed<string>({
  get: () => editorFontSizeInput.value,
  set: value => handleFontSizeInput(value)
});

function openFontFamilyPage(): void {
  fontSearchQuery.value = '';
  showFontFamilyPage.value = true;
}

function closeFontFamilyPage(): void {
  showFontFamilyPage.value = false;
}

function selectFontFamily(fontFamily: string): void {
  editorSettingsStore.addFontFamily(fontFamily);
}

/** 从字体回退栈中移除指定字体，并重新应用首项。 */
function removeFontFamily(index: number): void {
  editorSettingsStore.removeFontFamily(index);
}

/** Capture the pointer so reordering works consistently in WKWebView. */
function handleFontPointerDown(index: number, event: PointerEvent): void {
  if (event.button !== 0 || selectedFontFamilies.value.length <= 1) return;
  const handle = event.currentTarget;
  if (!(handle instanceof HTMLElement)) return;

  fontDragPointerId = event.pointerId;
  handle.setPointerCapture(event.pointerId);
  draggedFontIndex.value = index;
  updateFontDropTarget(event.clientY);
}

function updateFontDropTarget(clientY: number): void {
  const rows = selectedFontListElement.value?.querySelectorAll<HTMLElement>(
    '.settings-editor__selected-font'
  );
  if (!rows?.length) return;

  const targetIndex = [...rows].findIndex(row => {
    const bounds = row.getBoundingClientRect();
    return clientY < bounds.top + bounds.height / 2;
  });
  dragOverFontIndex.value = targetIndex < 0 ? rows.length : targetIndex;
}

function handleFontPointerMove(event: PointerEvent): void {
  if (fontDragPointerId !== event.pointerId || draggedFontIndex.value === null) return;
  updateFontDropTarget(event.clientY);
}

function handleFontPointerUp(event: PointerEvent): void {
  if (fontDragPointerId !== event.pointerId) return;
  updateFontDropTarget(event.clientY);
  const sourceIndex = draggedFontIndex.value;
  const targetIndex = dragOverFontIndex.value;
  if (sourceIndex !== null && targetIndex !== null) {
    editorSettingsStore.moveFontFamily(sourceIndex, targetIndex);
  }
  handleFontPointerEnd(event);
}

function handleFontPointerEnd(event: PointerEvent): void {
  if (fontDragPointerId !== event.pointerId) return;
  const handle = event.currentTarget;
  if (handle instanceof HTMLElement && handle.hasPointerCapture(event.pointerId)) {
    handle.releasePointerCapture(event.pointerId);
  }
  fontDragPointerId = undefined;
  draggedFontIndex.value = null;
  dragOverFontIndex.value = null;
}

/** 只在确实会改变顺序的插入点显示占位，避免占位紧贴拖拽源。 */
function shouldShowFontPlaceholder(index: number): boolean {
  const sourceIndex = draggedFontIndex.value;
  return sourceIndex !== null
    && dragOverFontIndex.value === index
    && index !== sourceIndex
    && index !== sourceIndex + 1;
}

onMounted(async () => {
  try {
    await editorSettingsStore.initialize();
  } catch {
    // Keep the default editor font when persisted settings are unavailable.
  }
  try {
    const fonts = await systemApi.listFonts();
    fontFamilyOptions.value = fonts
      .map(font => font.trim())
      .filter(Boolean);
  } catch {
    // Keep the list empty when the host cannot query installed fonts.
  }
});

watch(editorFontSize, value => {
  if (!editorFontSizeInput.value && fontSizeError.value) return;
  editorFontSizeInput.value = value;
  fontSizeError.value = '';
}, { immediate: true });
</script>

<template>
  <!-- S = 编辑器字体设置列表 -->
  <SettingsOptionList
    v-if="!showFontFamilyPage"
    list-label="字体设置"
    title="字体导航"
  >
    <SettingsOptionItem
      title="字体大小"
      description="设置编辑器正文的字号。"
    >
      <div class="settings-editor__font-size-control">
        <WsInput
          v-model="fontSizeModel"
          aria-label="字体大小"
          class="settings-editor__control"
          :hide-details="true"
          inputmode="numeric"
          maxlength="3"
          pattern="[0-9]*"
          type="text"
          @focus="handleFontSizeFocus"
          @blur="handleFontSizeBlur"
        />
        <p
          v-if="fontSizeError"
          class="settings-editor__font-size-error"
          role="alert"
        >
          {{ fontSizeError }}
        </p>
      </div>
    </SettingsOptionItem>

    <SettingsOptionItem
      title="字体族"
      description="选择编辑器使用的字体。"
    >
      <button
        aria-label="选择字体族"
        class="settings-editor__font-family-trigger"
        type="button"
        @click="openFontFamilyPage"
      >
        <span class="settings-editor__font-family-value">{{ editorFontFamily }}</span>
        <span
          aria-hidden="true"
          class="settings-editor__font-family-arrow"
          :class="arrowForwardIcon"
        />
      </button>
    </SettingsOptionItem>

    <SettingsOptionItem
      title="快速调整字体大小"
      description="允许在编辑器中快速调整字号。"
    >
      <WsSwitch
        v-model="quickFontSizeEnabled"
        aria-label="快速调整字体大小"
      />
    </SettingsOptionItem>
  </SettingsOptionList>
  <!-- E = 编辑器字体设置列表 -->

  <!-- S = 字体族二级设置 -->
  <SettingsOptionList
    v-else
    list-label="字体族"
  >
    <template #title-actions>
      <div class="settings-editor__font-family-heading">
        <WsIconButton
          :icon="arrowBackIcon"
          icon-position="start"
          label=""
          text="返回"
          @click="closeFontFamilyPage"
        />
      </div>
    </template>

    <section class="settings-editor__font-fallback" aria-label="选择的字体列表">
      <p class="settings-editor__font-fallback-description">
        列表中第一种字体将被应用，若该字体不存在于当前设备上，则自动应用下一个字体。
      </p>

      <div
        ref="selectedFontListElement"
        class="settings-editor__selected-font-list"
      >
        <template v-for="(fontFamily, index) in selectedFontFamilies" :key="fontFamily">
          <div
            v-if="shouldShowFontPlaceholder(index)"
            class="settings-editor__selected-font-placeholder"
            aria-hidden="true"
          />
          <div
            class="settings-editor__selected-font"
            :class="{ 'settings-editor__selected-font--dragging': draggedFontIndex === index }"
          >
            <span class="settings-editor__selected-font-name">{{ fontFamily }}</span>
            <span class="settings-editor__selected-font-actions">
              <WsIconButton
                :icon="closeIcon"
                :label="`移除字体${fontFamily}`"
                class="settings-editor__selected-font-action"
                :disabled="selectedFontFamilies.length <= 1"
                @click.stop="removeFontFamily(index)"
              />
              <WsIconButton
                :icon="menuIcon"
                :label="`拖拽调整${fontFamily}顺序`"
                class="settings-editor__selected-font-action settings-editor__selected-font-drag"
                :disabled="selectedFontFamilies.length <= 1"
                @pointerdown.stop.prevent="handleFontPointerDown(index, $event)"
                @pointermove="handleFontPointerMove"
                @pointerup="handleFontPointerUp"
                @pointercancel="handleFontPointerEnd"
                @lostpointercapture="handleFontPointerEnd"
                @dragstart.prevent
                @keydown.up.prevent="editorSettingsStore.moveFontFamily(index, index - 1)"
                @keydown.down.prevent="editorSettingsStore.moveFontFamily(index, index + 2)"
              />
            </span>
          </div>
        </template>
        <div
          v-if="shouldShowFontPlaceholder(selectedFontFamilies.length)"
          class="settings-editor__selected-font-placeholder"
          aria-hidden="true"
          />
      </div>
    </section>

    <div class="settings-editor__font-search">
      <WsInput
        v-model="fontSearchQuery"
        aria-label="搜索字体"
        placeholder="搜索字体"
      >
        <template #prepend-inner>
          <span
            aria-hidden="true"
            class="settings-editor__font-search-icon"
            :class="searchIcon"
          />
        </template>
      </WsInput>
    </div>

    <div
      v-if="filteredFontFamilyOptions.length > 0"
      class="settings-editor__font-family-list"
      role="listbox"
      aria-label="系统字体列表"
    >
      <SettingsOptionItem
        v-for="fontFamily in filteredFontFamilyOptions"
        :key="fontFamily"
        :title="fontFamily"
        :clickable="true"
        aria-selected="false"
        role="option"
        @click="selectFontFamily(fontFamily)"
      />
    </div>
    <SettingsOptionItem
      v-else
      title="未找到字体"
      description="请尝试其他搜索关键词。"
    />
  </SettingsOptionList>
  <!-- E = 字体族二级设置 -->
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.settings-editor__font-size-control {
  position: relative;
  display: flex;
  align-items: stretch;
  width: $settings-option-control-width;
  max-width: 100%;
}

.settings-editor__font-size-control .settings-editor__control {
  width: 100%;
}

.settings-editor__font-size-error {
  position: absolute;
  top: calc(100% + #{$spacing-2xs});
  left: 0;
  z-index: 1;
  display: block;
  box-sizing: border-box;
  width: max-content;
  max-width: min(28rem, calc(100vw - #{$spacing-xl}));
  margin: 0;
  padding: $spacing-2xs $spacing-xs;
  border: $input-border-width solid var(--ws-errorForeground, #ff0202);
  border-radius: $input-border-radius;
  color: var(--ws-errorForeground, #ff0202);
  background-color: color-mix(
    in srgb,
    var(--ws-errorForeground, #ff0202) 14%,
    transparent
  );
  font-size: $font-size-xs;
  line-height: $editor-line-height;
  white-space: nowrap;
  pointer-events: none;
}

.settings-editor__font-family-value {
  max-width: $settings-option-value-max-width;
  overflow: hidden;
  color: var(--ws-descriptionForeground);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-editor__font-family-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: $spacing-2xs;
  max-width: 100%;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  line-height: inherit;
  cursor: pointer;
}

.settings-editor__font-family-arrow {
  display: block;
  flex: 0 0 $icon-size-width;
  width: $icon-size-width;
  height: $icon-size-height;
  color: var(--ws-descriptionForeground);
}

.settings-editor__font-family-arrow {
  display: block;
  width: 100%;
  height: 100%;
}

.settings-editor__font-search {
  width: 100%;
}

.settings-editor__font-search :deep(.v-input__control),
.settings-editor__font-search :deep(.v-field) {
  min-height: $settings-plugin-search-height;
  height: $settings-plugin-search-height;
}

.settings-editor__font-search :deep(.v-field__input) {
  min-height: $settings-plugin-search-height;
  padding-block: $spacing-none;
  font-size: $font-size-xs;
}

.settings-editor__font-search :deep(.v-field__prepend-inner) {
  align-items: center;
  align-self: stretch;
  height: 100%;
  padding-block: $spacing-none;
}

.settings-editor__font-fallback {
  width: 100%;
}

.settings-editor__font-fallback-description {
  margin: 0 0 $spacing-xs;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  line-height: $editor-line-height;
}

.settings-editor__selected-font-list {
  width: 100%;
  margin-top: $spacing-2xs;
}

.settings-editor__selected-font-placeholder {
  width: 100%;
  position: relative;
  height: 0;
  pointer-events: none;

  &::after {
    content: '';
    position: absolute;
    inset: -1px 0 auto;
    border-top: 2px solid var(--ws-focusBorder);
  }
}

.settings-editor__selected-font {
  display: flex;
  min-width: 0;
  min-height: 1.5rem;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-xs;
  padding: 0.25rem $spacing-xs;
  border-bottom: 1px solid var(--ws-border);
  :deep(.ws-icon-button){
    height: 1.5rem;
  }
}

.settings-editor__selected-font--dragging {
  opacity: 0.55;
}

.settings-editor__selected-font-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-editor__selected-font-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: $spacing-xs;
}

.settings-editor__selected-font-action {
  flex: 0 0 auto;
}

.settings-editor__selected-font-drag {
  cursor: grab;
  touch-action: none;
}

.settings-editor__selected-font-drag:active {
  cursor: grabbing;
}

.settings-editor__selected-font-drag:disabled {
  cursor: default;
}

.settings-editor__font-family-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 10px;
}

.settings-editor__font-family-list :deep(.settings-option-item) {
  width: 100%;
  min-height: 1.7rem;
  height: 1.7rem;
  padding-inline: $spacing-xs;
  border-bottom: 1px solid var(--ws-border);
}

.settings-editor__font-family-heading {
  display: flex;
  align-items: center;
  gap: $spacing-xs;
}

.settings-editor__font-search-icon,
.settings-editor__font-search-icon {
  display: block;
  width: $icon-size-width;
  height: $icon-size-height;
}

@media (max-width: $settings-option-mobile-breakpoint) {
  .settings-editor__font-size-control {
    width: $settings-option-compact-control-width;
  }
}
</style>
