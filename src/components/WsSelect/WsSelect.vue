<script setup lang="ts" generic="T">
/** A framework-independent select control used across the workbench. */
import { computed, nextTick, onBeforeUnmount, ref, useAttrs, useSlots, watch } from 'vue';
import type { CSSProperties } from 'vue';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';

const arrowDownIcon = 'icon icon-arrow-down';
const arrowUpIcon = 'icon icon-arrow-up';

interface WsSelectProps {
  items: readonly unknown[];
  disabled?: boolean;
  loading?: boolean | string;
  itemTitle?: string;
  itemValue?: string;
  minWidth?: string | number;
  maxWidth?: string | number;
  minHeight?: string | number;
  maxHeight?: string | number;
}

interface SelectItem {
  raw: unknown;
  title: string;
  value: unknown;
}

interface SelectItemProps {
  role: 'option';
  tabindex: number;
  'aria-selected': 'true' | 'false';
  onClick: () => void;
}

const props = withDefaults(defineProps<WsSelectProps>(), {
  disabled: false,
  loading: false,
  itemTitle: 'title',
  itemValue: 'value'
});

const modelValue = defineModel<T | null>({ required: true });
const attrs = useAttrs();
const slots = useSlots();
const open = ref(false);
const activeIndex = ref(-1);
const triggerElement = ref<HTMLButtonElement | null>(null);
const dropdownElement = ref<HTMLElement | null>(null);
const dropdownScrollerElement = ref<HTMLElement | null>(null);
const dropdownStyle = ref<CSSProperties>({});
let triggerResizeObserver: ResizeObserver | undefined;

const rootAttrs = computed(() => {
  const allowed = ['id', 'name', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-testid'];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (attrs[key] !== undefined) result[key] = attrs[key];
  }
  return result;
});

const rootClass = computed(() => attrs.class);
const selectStyle = computed<CSSProperties>(() => ({
  ...(props.minWidth !== undefined ? { minWidth: props.minWidth } : {}),
  ...(props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : {})
}));
const dropdownSizeStyle = computed<CSSProperties>(() => ({
  ...(props.minHeight !== undefined ? { minHeight: props.minHeight } : {}),
  ...(props.maxHeight !== undefined ? { maxHeight: props.maxHeight } : {})
}));
const placeholder = computed(() => typeof attrs.placeholder === 'string' ? attrs.placeholder : '');
const isLoading = computed(() => Boolean(props.loading));

const normalizedItems = computed<SelectItem[]>(() => props.items.map((raw) => ({
  raw,
  title: getItemText(raw, props.itemTitle),
  value: getItemValue(raw, props.itemValue)
})));

const selectedIndex = computed(() => normalizedItems.value.findIndex(item => isSameValue(item.value, modelValue.value)));
const selectedItem = computed(() => selectedIndex.value >= 0 ? normalizedItems.value[selectedIndex.value] : undefined);
const displayText = computed(() => selectedItem.value?.title || placeholder.value);
const arrowClass = computed(() => open.value ? arrowUpIcon : arrowDownIcon);

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

function getItemProps(index: number): SelectItemProps {
  return {
    role: 'option',
    tabindex: activeIndex.value === index ? 0 : -1,
    'aria-selected': selectedIndex.value === index ? 'true' : 'false',
    onClick: () => selectItem(index)
  };
}

function selectItem(index: number): void {
  const item = normalizedItems.value[index];
  if (!item) return;
  modelValue.value = item.value as T;
  close();
}

function getDropdownLeft(left: number, width: number): number {
  const maxLeft = window.innerWidth - width - 4;
  return Math.max(4, Math.min(left, maxLeft));
}

async function positionDropdown(): Promise<void> {
  await nextTick();
  const trigger = triggerElement.value;
  if (!trigger) return;

  const bounds = trigger.getBoundingClientRect();
  const dropdown = dropdownElement.value;
  const width = bounds.width;
  const left = getDropdownLeft(bounds.left, width);
  const dropdownHeight = dropdown?.getBoundingClientRect().height ?? 0;
  const below = bounds.bottom + dropdownHeight <= window.innerHeight - 4;
  const top = below ? bounds.bottom : Math.max(4, bounds.top - dropdownHeight);

  dropdownStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    minWidth: `${bounds.width}px`
  };
}

function setInitialDropdownWidth(): void {
  const trigger = triggerElement.value;
  if (!trigger) return;

  const bounds = trigger.getBoundingClientRect();
  const width = bounds.width;
  const left = getDropdownLeft(bounds.left, width);
  dropdownStyle.value = {
    ...dropdownStyle.value,
    left: `${left}px`,
    width: `${width}px`,
    minWidth: `${width}px`
  };
}

function openSelect(): void {
  if (props.disabled || isLoading.value) return;
  open.value = true;
  activeIndex.value = selectedIndex.value >= 0
    ? selectedIndex.value
    : normalizedItems.value.length > 0 ? 0 : -1;
  setInitialDropdownWidth();
  void positionDropdown();
  document.addEventListener('pointerdown', handleOutsidePointerDown, true);
  window.addEventListener('resize', positionDropdown);
  window.addEventListener('scroll', positionDropdown, true);
  triggerResizeObserver = new ResizeObserver(() => {
    if (open.value) void positionDropdown();
  });
  if (triggerElement.value) triggerResizeObserver.observe(triggerElement.value);
}

function close(): void {
  open.value = false;
  activeIndex.value = -1;
  triggerResizeObserver?.disconnect();
  triggerResizeObserver = undefined;
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  window.removeEventListener('resize', positionDropdown);
  window.removeEventListener('scroll', positionDropdown, true);
}

function toggle(): void {
  if (open.value) close();
  else openSelect();
}

function handleOutsidePointerDown(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Node && (triggerElement.value?.contains(target) || dropdownElement.value?.contains(target))) return;
  close();
}

function handleTriggerKeydown(event: KeyboardEvent): void {
  if (props.disabled || isLoading.value) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggle();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!open.value) openSelect();
    else moveActive(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    close();
  }
}

function handleDropdownKeydown(event: KeyboardEvent): void {
  if (!open.value) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveActive(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter' && activeIndex.value >= 0) {
    event.preventDefault();
    selectItem(activeIndex.value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    close();
    triggerElement.value?.focus();
  }
}

function moveActive(delta: number): void {
  const count = normalizedItems.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
}

watch(() => props.items, () => {
  if (selectedIndex.value < 0 && modelValue.value !== null) modelValue.value = null;
  if (open.value) void positionDropdown();
}, { deep: true });

watch([() => props.minHeight, () => props.maxHeight], () => {
  if (open.value) void positionDropdown();
});

onBeforeUnmount(close);
</script>

<template>
  <div
    v-bind="rootAttrs"
    class="ws-select"
    :class="[rootClass, { 'ws-select--open': open, 'ws-select--disabled': props.disabled }]"
    :style="selectStyle"
  >
    <button
      ref="triggerElement"
      aria-haspopup="listbox"
      :aria-expanded="open ? 'true' : 'false'"
      class="ws-select__trigger ws-no-text-selection"
      :disabled="props.disabled || isLoading"
      type="button"
      @click="toggle"
      @keydown="handleTriggerKeydown"
    >
      <span class="ws-select__value">
        <slot v-if="selectedItem && slots.selection" name="selection" :item="selectedItem" />
        <span v-else>{{ isLoading ? '加载中...' : displayText }}</span>
      </span>
      <span aria-hidden="true" class="ws-select__arrow" :class="arrowClass" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="dropdownElement"
        class="ws-select-dropdown"
        :style="[dropdownStyle, dropdownSizeStyle]"
        role="listbox"
        @keydown="handleDropdownKeydown"
      >
        <div
          ref="dropdownScrollerElement"
          class="ws-select__scroller"
        >
          <slot name="prepend-item" />
          <template v-if="normalizedItems.length > 0">
            <template v-for="(item, index) in normalizedItems" :key="index">
              <slot v-if="slots.item" name="item" :item="{ raw: item.raw, title: item.title, value: item.value }" :props="getItemProps(index)" />
              <button
                v-else
                class="ws-select__option"
                :class="{ 'ws-select__option--active': activeIndex === index, 'ws-select__option--selected': selectedIndex === index }"
                v-bind="getItemProps(index)"
                type="button"
              >
                {{ item.title }}
              </button>
            </template>
          </template>
          <div v-else class="ws-select__empty" role="status">暂无选项</div>
          <slot name="append-item" />
        </div>

        <!-- S = 下拉框自定义滚动条 -->
        <WorkbenchVerticalScrollbar
          class="ws-select__scrollbar"
          :scroller-element="dropdownScrollerElement"
        />
        <!-- E = 下拉框自定义滚动条 -->
      </div>
    </Teleport>
  </div>
</template>
