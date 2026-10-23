<script setup lang="ts">
/**
 * 文件说明：提供笔记属性日期与日期时间的固定分段输入，并复用通用日期选择器。
 */
import { computed, nextTick, ref, watch } from 'vue';

import WsDatePicker from '@/components/date/WsDatePicker.vue';
import {
  fromPickerDateValue,
  getDateSegmentRange,
  getDateSegments,
  isEditablePropertyDate,
  normalizePropertyDate,
  toEditablePropertyDate,
  toPickerDateValue,
  toPropertyDateDraft,
  type NotePropertyDateMode,
  type NotePropertyDateSegment
} from '@editor/NoteProperties/notePropertyDateTime';

/** 日期属性输入参数。 */
interface NotePropertyDateInputProps {
  modelValue?: string;
  mode?: NotePropertyDateMode;
}

const props = withDefaults(defineProps<NotePropertyDateInputProps>(), {
  modelValue: '',
  mode: 'date'
});
const emit = defineEmits<{
  'update:modelValue': [value: string];
  save: [value?: string];
  cancel: [];
}>();

const menuVisible = ref(false);
const dateDraft = ref(toEditablePropertyDate(props.modelValue, props.mode));
const dateFieldRef = ref<{ $el?: HTMLElement } | null>(null);
const dateActivator = ref<HTMLElement>();
const skipNextYearSelection = ref(false);
const activeInputSegment = ref<NotePropertyDateSegment>('year');
const activeSegmentDigitBuffer = ref('');
let dateTextMeasurementCanvas: HTMLCanvasElement | undefined;
const dateInputProps = {
  density: 'compact',
  hideDetails: true,
  inputmode: 'numeric',
  singleLine: true,
  variant: 'plain'
} as const;
const dateMenuProps = {
  closeOnContentClick: false,
  location: 'bottom start',
  openOnClick: false,
  origin: 'top start',
  scrollStrategy: 'close',
  transition: false
} as const;
const dateFieldClass = computed(() => ({
  'note-property-date-input__field': true,
  'note-property-date-input__field--datetime': props.mode === 'datetime'
}));
const pickerDate = computed(() => toPickerDateValue(props.modelValue, props.mode));

watch([() => props.modelValue, () => props.mode], ([value, mode]) => {
  const nextValue = toEditablePropertyDate(value, mode);
  if (nextValue === dateDraft.value) return;

  dateDraft.value = nextValue;
  activeInputSegment.value = 'year';
  activeSegmentDigitBuffer.value = '';
});

/** 返回组件内部原生输入框。 */
function getDateInputElement(): HTMLInputElement | null {
  return dateFieldRef.value?.$el?.querySelector('input') ?? null;
}

/** 输入框首次获得焦点时选中年份，便于直接替换四位年份。 */
async function selectYearSegment(): Promise<void> {
  if (skipNextYearSelection.value) {
    skipNextYearSelection.value = false;
    return;
  }

  await nextTick();
  selectInputSegment('year', true);
}

/** 聚焦并完整选中指定日期分段。 */
function selectInputSegment(segment: NotePropertyDateSegment, focus = false): void {
  const input = getDateInputElement();
  if (!input) return;
  const range = getDateSegmentRange(segment);
  if (focus) input.focus({ preventScroll: true });
  input.setSelectionRange(range.start, range.end);
  activeInputSegment.value = segment;
  activeSegmentDigitBuffer.value = '';
}

/** 在浏览器放置光标前选中鼠标所在的完整日期分段。 */
function selectDateSegmentFromPointer(event: PointerEvent): void {
  const input = event.target instanceof HTMLInputElement ? event.target : getDateInputElement();
  if (!input) return;

  const segment = getPointerDateSegment(event, input);
  if (!segment) return;
  if (document.activeElement !== input) {
    skipNextYearSelection.value = true;
    input.focus({ preventScroll: true });
  }
  selectInputSegment(segment);
}

/** 以固定宽度逐位写入当前分段，并在写满后自动进入下一段。 */
async function handleDateSegmentKeydown(event: KeyboardEvent): Promise<void> {
  if (!/^\d$/u.test(event.key)) return;

  event.preventDefault();
  const segment = activeInputSegment.value;
  const range = getDateSegmentRange(segment);
  const segmentLength = range.end - range.start;
  const previousBuffer = activeSegmentDigitBuffer.value.length >= segmentLength
    ? ''
    : activeSegmentDigitBuffer.value;
  const nextBuffer = `${previousBuffer}${event.key}`;
  const nextSegmentValue = nextBuffer.padStart(segmentLength, '0');
  if (nextBuffer.length === segmentLength && !isSegmentValueAllowed(segment, nextSegmentValue)) return;

  activeSegmentDigitBuffer.value = nextBuffer;
  const nextValue = `${dateDraft.value.slice(0, range.start)}${nextSegmentValue}${dateDraft.value.slice(range.end)}`;
  dateDraft.value = nextValue;
  emit('update:modelValue', toPropertyDateDraft(nextValue));

  await nextTick();
  const segments = getDateSegments(props.mode);
  const segmentIndex = segments.indexOf(segment);
  const nextSegment = segments[segmentIndex + 1];
  if (nextBuffer.length === segmentLength && nextSegment) {
    selectInputSegment(nextSegment);
    return;
  }
  selectInputSegment(segment);
  activeSegmentDigitBuffer.value = nextBuffer;
}

/** 判断完整分段值是否处于有效基础范围。 */
function isSegmentValueAllowed(segment: NotePropertyDateSegment, value: string): boolean {
  const numericValue = Number(value);
  if (segment === 'month') return numericValue >= 1 && numericValue <= 12;
  if (segment === 'day') return numericValue >= 1 && numericValue <= 31;
  if (segment === 'hour') return numericValue <= 23;
  if (segment === 'minute') return numericValue <= 59;
  return true;
}

/** 根据文字实际渲染宽度判断鼠标所在的日期分段。 */
function getPointerDateSegment(event: MouseEvent, input: HTMLInputElement): NotePropertyDateSegment | undefined {
  dateTextMeasurementCanvas ??= document.createElement('canvas');
  const context = dateTextMeasurementCanvas.getContext('2d');
  if (!context) return undefined;

  const style = window.getComputedStyle(input);
  context.font = style.font;
  const pointerOffset = event.clientX
    - input.getBoundingClientRect().left
    - Number.parseFloat(style.paddingInlineStart || '0');
  let measuredWidth = 0;
  let previousSegmentEnd = 0;

  for (const segment of getDateSegments(props.mode)) {
    const range = getDateSegmentRange(segment);
    const prefix = input.value.slice(previousSegmentEnd, range.start);
    measuredWidth += context.measureText(prefix).width;
    const segmentWidth = context.measureText(input.value.slice(range.start, range.end)).width;
    if (pointerOffset <= measuredWidth + segmentWidth) return segment;
    measuredWidth += segmentWidth;
    previousSegmentEnd = range.end;
  }
  return undefined;
}

/** 仅在鼠标所在分段上显示文本指针。 */
function updateDateInputCursor(event: MouseEvent): void {
  const input = event.target instanceof HTMLInputElement ? event.target : getDateInputElement();
  if (input) {
    input.style.cursor = getPointerDateSegment(event, input) === activeInputSegment.value
      ? 'text'
      : 'default';
  }
}

/** 鼠标离开日期输入框后恢复默认指针。 */
function resetDateInputCursor(): void {
  const input = getDateInputElement();
  if (input) input.style.cursor = 'default';
}

/** 在浏览器写入前阻止破坏固定日期结构或超出范围的操作。 */
function handleDateBeforeInput(event: InputEvent): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;

  const selectionStart = input.selectionStart ?? 0;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  const insertedText = event.inputType.startsWith('delete') ? '' : (event.data ?? '');
  const nextValue = `${input.value.slice(0, selectionStart)}${insertedText}${input.value.slice(selectionEnd)}`;
  if (!isEditablePropertyDate(nextValue, props.mode)) event.preventDefault();
}

/** 接收手动输入草稿，完整值在保存时统一校验。 */
function handleDateInput(value: string): void {
  if (!isEditablePropertyDate(value, props.mode)) {
    const input = getDateInputElement();
    if (input) input.value = dateDraft.value;
    return;
  }

  dateDraft.value = value;
  emit('update:modelValue', toPropertyDateDraft(value));
}

/** 保存手动输入的有效日期或日期时间。 */
function commitDateInput(): void {
  const normalizedDate = normalizePropertyDate(dateDraft.value, props.mode);
  if (!normalizedDate) return;

  dateDraft.value = toEditablePropertyDate(normalizedDate, props.mode);
  emit('update:modelValue', normalizedDate);
  setDatePickerVisibility(false);
  emit('save', normalizedDate);
}

/** 选择面板值后回写属性草稿并关闭菜单。 */
function handleDateSelected(value: unknown): void {
  const nextValue = fromPickerDateValue(value, props.mode);
  if (!nextValue) return;

  dateDraft.value = toEditablePropertyDate(nextValue, props.mode);
  emit('update:modelValue', nextValue);
  setDatePickerVisibility(false);
  emit('save', nextValue);
}

/** 日期面板编辑时分时仅同步草稿，保留面板打开状态。 */
function handlePickerDraftUpdate(value: unknown): void {
  const nextValue = fromPickerDateValue(value, props.mode);
  if (!nextValue) return;

  dateDraft.value = toEditablePropertyDate(nextValue, props.mode);
  emit('update:modelValue', nextValue);
}

/** 清除当前日期草稿。 */
function clearDate(): void {
  emit('update:modelValue', '');
  setDatePickerVisibility(false);
  emit('save');
}

/** 取消日期编辑并关闭菜单。 */
function cancelDateEditing(): void {
  dateDraft.value = toEditablePropertyDate(props.modelValue, props.mode);
  setDatePickerVisibility(false);
  emit('cancel');
}

/** 统一更新日期菜单可见状态，并在关闭时释放失效的定位锚点。 */
function setDatePickerVisibility(visible: boolean): void {
  menuVisible.value = visible;
  if (!visible) dateActivator.value = undefined;
}

/** 等待输入框挂载后打开面板，确保菜单锚点位置有效。 */
async function openDatePicker(activatorTarget?: HTMLElement): Promise<void> {
  await nextTick();
  skipNextYearSelection.value = true;
  const activator = activatorTarget ?? dateFieldRef.value?.$el;
  if (activator instanceof HTMLElement) {
    dateActivator.value = activator;
    await nextTick();
  }
  setDatePickerVisibility(true);
}

/** 对外提供输入框聚焦和打开日期面板能力。 */
defineExpose({
  focus: selectYearSegment,
  open: openDatePicker
});
</script>

<template>
  <v-menu
    v-bind="dateMenuProps"
    :model-value="menuVisible"
    :activator="dateActivator"
    @update:model-value="setDatePickerVisibility"
  >
    <template #activator="{ props: activatorProps }">
      <v-text-field
        v-bind="{ ...dateInputProps, ...activatorProps }"
        ref="dateFieldRef"
        :class="dateFieldClass"
        :maxlength="mode === 'datetime' ? 21 : 14"
        :model-value="dateDraft"
        :aria-label="mode === 'datetime' ? '选择日期和时间' : '选择日期'"
        @focus="selectYearSegment"
        @pointerdown.prevent="selectDateSegmentFromPointer"
        @mousemove="updateDateInputCursor"
        @mouseleave="resetDateInputCursor"
        @beforeinput="handleDateBeforeInput"
        @update:model-value="handleDateInput"
        @keydown="handleDateSegmentKeydown"
        @keydown.enter.stop.prevent="commitDateInput"
        @keydown.esc.stop.prevent="cancelDateEditing"
      />
    </template>

    <!-- S = 通用日期选择器 -->
    <WsDatePicker
      :model-value="pickerDate"
      :show-time="mode === 'datetime'"
      @update:model-value="handlePickerDraftUpdate"
      @select="handleDateSelected"
      @clear="clearDate"
    />
    <!-- E = 通用日期选择器 -->
  </v-menu>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.note-property-date-input__field {
  width: $note-properties-date-content-width;
  min-width: $note-properties-date-content-width;
  height: $note-properties-value-height;
  cursor: text;
}

.note-property-date-input__field--datetime {
  width: $note-properties-datetime-content-width;
  min-width: $note-properties-datetime-content-width;
}

.note-property-date-input__field :deep(.v-input__control),
.note-property-date-input__field :deep(.v-field),
.note-property-date-input__field :deep(.v-field__field) {
  height: $note-properties-value-height;
  min-height: $note-properties-value-height;
}

.note-property-date-input__field :deep(.v-field),
.note-property-date-input__field :deep(.v-field__field),
.note-property-date-input__field :deep(input) {
  cursor: text;
}

.note-property-date-input__field :deep(.v-field__input) {
  min-height: $note-properties-value-height;
  padding: 0;
  font-size: $note-properties-content-font-size;
  font-family: inherit;
  font-weight: inherit;
  letter-spacing: 0;
  line-height: $note-properties-value-height;
}

.note-property-date-input__field :deep(.v-field__overlay) {
  display: none;
}

.note-property-date-input__field :deep(input) {
  font-family: inherit;
  font-weight: inherit;
  letter-spacing: 0;
  caret-color: transparent;
}
</style>
