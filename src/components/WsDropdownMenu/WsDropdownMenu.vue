<!-- 文件说明：提供宿主统一的下拉菜单容器，负责触发器、定位、关闭和键盘行为。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, useSlots, watch } from 'vue';
import type { CSSProperties } from 'vue';

import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';

export interface WsDropdownMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  selected?: boolean;
  separator?: boolean;
}

interface WsDropdownMenuProps {
  items?: readonly unknown[];
  itemTitle?: string;
  itemValue?: string;
  panelAlign?: 'start' | 'end';
  matchTriggerWidth?: boolean;
  panelPlacement?: 'auto' | 'below';
  closeOnScroll?: boolean;
  disabled?: boolean;
}

interface DropdownItem {
  raw: unknown;
  title: string;
  value: unknown;
}

interface DropdownItemProps {
  class: string;
  role: 'menuitem';
  tabindex: number;
  'data-ws-dropdown-item': string;
  onClick: () => void;
}

const props = withDefaults(defineProps<WsDropdownMenuProps>(), {
  items: () => [],
  itemTitle: 'label',
  itemValue: 'id',
  panelAlign: 'start',
  matchTriggerWidth: false,
  panelPlacement: 'auto',
  closeOnScroll: false,
  disabled: false
});

const attrs = useAttrs();
const slots = useSlots();
const open = defineModel<boolean>('open', { default: false });
const modelValue = defineModel<string | null>();
const rootElement = ref<HTMLElement | null>(null);
const triggerElement = ref<HTMLElement | null>(null);
const panelElement = ref<HTMLElement | null>(null);
const panelScrollerElement = ref<HTMLElement | null>(null);
const activeIndex = ref(-1);
const panelStyle = ref<CSSProperties>({});
let resizeObserver: ResizeObserver | undefined;
let openEffectsAttached = false;

const rootClass = computed(() => attrs.class);

const normalizedItems = computed<DropdownItem[]>(() => props.items.map(raw => ({
  raw,
  title: getItemText(raw, props.itemTitle),
  value: getItemValue(raw, props.itemValue)
})));

const selectedIndex = computed(() => normalizedItems.value.findIndex(item => isSameValue(item.value, modelValue.value)));

function getItemText(item: unknown, key: string): string {
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item !== 'object' || item === null) return '';
  const value = (item as Record<string, unknown>)[key];
  return value === null || value === undefined ? '' : String(value);
}

function getItemValue(item: unknown, key: string): unknown {
  if (typeof item !== 'object' || item === null) return item;
  return (item as Record<string, unknown>)[key];
}

function isSameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || (left !== null && right !== null && String(left) === String(right));
}

function isItemDisabled(item: unknown): boolean {
  return typeof item === 'object'
    && item !== null
    && Boolean((item as { disabled?: unknown }).disabled);
}

function getItemProps(index: number): DropdownItemProps {
  const item = normalizedItems.value[index];
  return {
    class: [
      'ws-dropdown-menu__item',
      activeIndex.value === index ? 'ws-dropdown-menu__item--active' : '',
      selectedIndex.value === index ? 'ws-dropdown-menu__item--selected' : ''
    ].filter(Boolean).join(' '),
    role: 'menuitem',
    tabindex: activeIndex.value === index ? 0 : -1,
    'data-ws-dropdown-item': String(item?.value ?? index),
    onClick: () => selectItem(index)
  };
}

function selectItem(index: number): void {
  const item = normalizedItems.value[index];
  if (!item) return;
  modelValue.value = item.value === null || item.value === undefined
    ? null
    : String(item.value);
  emitSelect(item.raw);
  closeMenu();
}

function emitSelect(item: unknown): void {
  emit('select', item);
}

const emit = defineEmits<{
  select: [item: unknown];
  open: [];
  close: [];
}>();

function syncTriggerState(): void {
  const wrapper = triggerElement.value;
  const trigger = wrapper?.querySelector<HTMLElement>('[aria-haspopup]')
    ?? wrapper?.querySelector<HTMLSlotElement>('slot[name="trigger"]')
      ?.assignedElements()
      .find((element): element is HTMLElement => element instanceof HTMLElement && element.hasAttribute('aria-haspopup'))
    ?? wrapper;
  trigger?.setAttribute('aria-expanded', String(open.value));
}

function attachOpenEffects(): void {
  if (openEffectsAttached) return;
  openEffectsAttached = true;
  document.addEventListener('pointerdown', handleOutsidePointerDown, true);
  window.addEventListener('resize', positionMenu);
  window.addEventListener('scroll', handleScroll, true);
  resizeObserver = new ResizeObserver(() => {
    if (open.value) void positionMenu();
  });
  if (triggerElement.value) resizeObserver.observe(triggerElement.value);
}

function detachOpenEffects(): void {
  if (!openEffectsAttached) return;
  openEffectsAttached = false;
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  window.removeEventListener('resize', positionMenu);
  window.removeEventListener('scroll', handleScroll, true);
}

async function positionMenu(): Promise<void> {
  await nextTick();
  const trigger = triggerElement.value;
  const panel = panelElement.value;
  if (!trigger || !panel) return;

  const bounds = trigger.getBoundingClientRect();
  const matchedWidth = props.matchTriggerWidth ? Math.ceil(bounds.width) : undefined;
  if (matchedWidth !== undefined && panelStyle.value.width !== `${matchedWidth}px`) {
    panelStyle.value = {
      ...panelStyle.value,
      width: `${matchedWidth}px`
    };
    await nextTick();
  }
  const panelBounds = panel.getBoundingClientRect();
  const panelWidth = matchedWidth ?? panelBounds.width;
  const alignedLeft = props.panelAlign === 'end'
    ? bounds.right - panelWidth
    : bounds.left;
  const left = Math.max(4, Math.min(alignedLeft, window.innerWidth - panelWidth - 4));
  const below = bounds.bottom + panelBounds.height <= window.innerHeight - 4;
  const top = props.panelPlacement === 'below' || below
    ? bounds.bottom
    : Math.max(4, bounds.top - panelBounds.height);
  panelStyle.value = {
    ...panelStyle.value,
    left: `${left}px`,
    top: `${top}px`
  };
}

function openMenu(): void {
  if (props.disabled || open.value) return;
  open.value = true;
  activeIndex.value = selectedIndex.value;
  syncTriggerState();
  emit('open');
  attachOpenEffects();
  void positionMenu();
}

function closeMenu(): void {
  const wasOpen = open.value;
  if (wasOpen) open.value = false;
  activeIndex.value = -1;
  syncTriggerState();
  if (wasOpen) emit('close');
  detachOpenEffects();
}

function toggleMenu(): void {
  if (open.value) closeMenu();
  else openMenu();
}

function handleTriggerClick(): void {
  toggleMenu();
}

function handleOutsidePointerDown(event: PointerEvent): void {
  const target = event.target;
  const path = event.composedPath();
  if (
    (target instanceof Node && rootElement.value?.contains(target))
    || (rootElement.value && path.includes(rootElement.value))
  ) return;
  closeMenu();
}

function handleScroll(event: Event): void {
  if (!props.closeOnScroll) {
    void positionMenu();
    return;
  }

  const target = event.target;
  const panel = panelElement.value;
  const path = event.composedPath();
  if (
    (target instanceof Node && panel?.contains(target))
    || (panel && path.includes(panel))
  ) return;

  closeMenu();
}

function handleKeydown(event: KeyboardEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.matches('input, textarea, [contenteditable="true"]')) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter' && activeIndex.value >= 0) {
    event.preventDefault();
    selectItem(activeIndex.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
  }
}

function moveActive(delta: number): void {
  const count = normalizedItems.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
}

watch(open, (isOpen) => {
  syncTriggerState();
  if (isOpen) {
    attachOpenEffects();
    void positionMenu();
  } else {
    activeIndex.value = -1;
    detachOpenEffects();
  }
});

watch(() => props.items, () => {
  if (open.value) void positionMenu();
}, { deep: true });

watch(() => props.panelAlign, () => {
  if (open.value) void positionMenu();
});

onBeforeUnmount(closeMenu);

defineExpose({ closeMenu, openMenu, toggleMenu });
</script>

<template>
  <div
    ref="rootElement"
    class="ws-dropdown-menu"
    :class="[rootClass, { 'ws-dropdown-menu--open': open, 'ws-dropdown-menu--disabled': props.disabled }]"
    @keydown="handleKeydown"
  >
    <div
      ref="triggerElement"
      class="ws-dropdown-menu__trigger"
      @click="handleTriggerClick"
    >
      <slot name="trigger" :open="open" :toggle="toggleMenu" :close="closeMenu" />
    </div>

    <div
      v-if="open"
      ref="panelElement"
      class="ws-dropdown-menu__panel"
      :style="panelStyle"
      role="menu"
    >
      <div
        ref="panelScrollerElement"
        class="ws-dropdown-menu__scroller"
      >
        <slot name="prepend" />
        <template v-if="normalizedItems.length > 0">
          <template v-for="(item, index) in normalizedItems" :key="index">
            <slot
              v-if="slots.item"
              name="item"
              :item="item"
              :props="getItemProps(index)"
            />
            <button
              v-else
              v-bind="getItemProps(index)"
              class="ws-dropdown-menu__item"
              :class="{ 'ws-dropdown-menu__item--active': activeIndex === index, 'ws-dropdown-menu__item--selected': selectedIndex === index }"
              :disabled="isItemDisabled(item.raw)"
              type="button"
            >
              <span class="ws-dropdown-menu__item-label">{{ item.title }}</span>
            </button>
          </template>
        </template>
        <div v-else-if="!slots.menu" class="ws-dropdown-menu__empty" role="status">暂无选项</div>
        <slot name="append" />
        <slot name="menu" />
      </div>
      <WorkbenchVerticalScrollbar :scroller-element="panelScrollerElement" />
    </div>
  </div>
</template>

<style lang="scss">
@use '@/assets/styles/variables' as *;

.ws-dropdown-menu {
  position: relative;
  display: inline-block;
  min-width: 0;
  color: var(--ws-menu-foreground, var(--ws-foreground));
  font-family: $font-family-base;
  font-size: $font-editor-context-menu-font-size;
  line-height: normal;

}

:host {
  display: inline-block;
  min-width: 0;
  max-width: 100%;
}

.ws-dropdown-menu__trigger {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: min($dropdown-menu-trigger-max-width, calc(100vw - #{$spacing-xs}));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-dropdown-menu__panel {
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
  position: fixed;
  z-index: $dropdown-menu-active-z-index;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: max-content;
  min-width: min($dropdown-menu-panel-min-width, calc(100vw - #{$spacing-xs}));
  max-width: calc(100vw - #{$spacing-xs});
  max-height: calc(100vh - #{$spacing-xs});
  overflow: hidden;
  padding: $dropdown-menu-padding-block;
  border: $editor-table-border-width solid var(--ws-menu-border, var(--ws-border));
  color: var(--ws-menu-foreground, var(--ws-foreground));
  border-radius: $radius-xs;
  background: var(--ws-menu-background, var(--ws-background));
  box-shadow: $menu-box-shadow;
  scrollbar-width: none;
  -ms-overflow-style: none;
  margin-top: 3px;
}

.ws-dropdown-menu__scroller {
  flex: 0 1 auto;
  width: 100%;
  max-width: 100%;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  white-space: nowrap;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ws-dropdown-menu__scroller::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.ws-dropdown-menu__item {
  display: flex;
  width: 100%;
  min-width: 0;
  min-height: $dropdown-menu-item-height;
  align-items: center;
  padding: $dropdown-menu-item-padding-block $dropdown-menu-item-padding-inline;
  border: 0;
  border-radius: $dropdown-menu-item-radius;
  color: inherit;
  background: transparent;
  font: inherit;
  text-align: start;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  margin-top: 2px;
}

.ws-dropdown-menu__item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: inherit;
}

.ws-dropdown-menu__item:hover,
.ws-dropdown-menu__item:focus-visible,
.ws-dropdown-menu__item--active,
.ws-dropdown-menu__item--selected {
  background: var(--ws-menu-hoverBackground, var(--ws-list-hoverBackground));
}

.ws-dropdown-menu__empty {
  min-height: $dropdown-menu-item-height;
  padding: $dropdown-menu-item-padding-block $dropdown-menu-item-padding-inline;
  color: var(--ws-descriptionForeground);
  text-align: center;
}

.ws-dropdown-menu--disabled {
  pointer-events: none;
}
</style>
