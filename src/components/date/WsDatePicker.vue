<!-- 文件说明：封装工作台统一日期选择器，提供紧凑年月面板、主题样式与通用滚动条。 -->
<script setup lang="ts">
import { computed, defineComponent, h, nextTick, ref, watch } from 'vue';
import { zhHans } from 'vuetify/locale';

const arrowBackIcon = 'icon icon-arrow-back';
const arrowForwardIcon = 'icon icon-arrow-forward';
import WorkbenchVerticalScrollbar from '@/components/scrollbar/WorkbenchVerticalScrollbar.vue';
import WsTimeColumn from '@/components/date/WsTimeColumn.vue';

/** 通用日期选择器接受并返回的日期值。 */
type WsDatePickerValue = string | Date | null;
/** Vuetify 日期选择器当前展示的面板类型。 */
type WsDatePickerViewMode = 'month' | 'months' | 'year';
/** Vuetify 日期选择器控制栏的导航按钮类型。 */
type WsDatePickerNavigationControl = 'prev-month' | 'next-month' | 'prev-year' | 'next-year';
/** 日期面板固定补充的上月日期单元。 */
interface WsDatePickerLeadingDay {
  isoDate: string;
  label: number;
  disabled: boolean;
  ariaLabel: string;
}

/** 通用日期选择器公开参数。 */
interface WsDatePickerProps {
  modelValue?: WsDatePickerValue;
  min?: string | Date;
  max?: string | Date;
  disabled?: boolean;
  readonly?: boolean;
  showAdjacentMonths?: boolean;
  firstDayOfWeek?: number;
  showActions?: boolean;
  showTime?: boolean;
}

const props = withDefaults(defineProps<WsDatePickerProps>(), {
  modelValue: null,
  min: undefined,
  max: undefined,
  disabled: false,
  readonly: false,
  showAdjacentMonths: true,
  firstDayOfWeek: 1,
  showActions: true,
  showTime: false
});
const emit = defineEmits<{
  'update:modelValue': [value: WsDatePickerValue];
  select: [value: WsDatePickerValue];
  clear: [];
  today: [value: WsDatePickerValue];
}>();

const pickerViewMode = ref<WsDatePickerViewMode>('month');
const returnToMonthsAfterYearSelection = ref(false);
const initialDisplayedDate = resolveDateValue(props.modelValue) ?? new Date();
const displayedMonth = ref(initialDisplayedDate.getMonth());
const displayedYear = ref(initialDisplayedDate.getFullYear());
const selectedDateDraft = ref(formatLocalIsoDate(initialDisplayedDate));
const timeDraft = ref({
  hour: String(initialDisplayedDate.getHours()).padStart(2, '0'),
  minute: String(initialDisplayedDate.getMinutes()).padStart(2, '0')
});
const pickerSurfaceRef = ref<{ $el?: HTMLElement } | null>(null);
const datePickerRef = ref<{ $el?: HTMLElement } | null>(null);
const monthDaysElement = ref<HTMLElement | null>(null);
const yearScrollerElement = ref<HTMLElement | null>(null);
const yearScrollbarStyle = ref<Record<string, string>>();
const datePickerProps = {
  color: 'primary',
  hideHeader: true,
  nextIcon: defineComponent({
    name: 'WsDatePickerNextIcon',
    setup() {
      return () => h('span', {
        class: `ws-date-picker__control-icon ${arrowForwardIcon}`
      });
    }
  }),
  prevIcon: defineComponent({
    name: 'WsDatePickerPreviousIcon',
    setup() {
      return () => h('span', {
        class: `ws-date-picker__control-icon ${arrowBackIcon}`
      });
    }
  }),
  weeksInMonth: 'dynamic'
} as const;
const dateActionButtonProps = {
  density: 'compact',
  ripple: false,
  size: 'small',
  variant: 'text'
} as const;
const dateControlIconButtonProps = {
  density: 'comfortable',
  variant: 'text'
} as const;
const dateControlTextButtonProps = {
  density: 'default',
  variant: 'text'
} as const;
const leadingDayButtonProps = {
  icon: true,
  ripple: false,
  variant: 'text'
} as const;
const dateLocaleMessages = {
  zhHans
} as const;
const DAYS_IN_WEEK = 7;
const HOURS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'));

const leadingWeekDates = computed<readonly WsDatePickerLeadingDay[]>(() => {
  const firstOfMonth = new Date(displayedYear.value, displayedMonth.value, 1);
  const normalizedFirstDay = ((props.firstDayOfWeek % DAYS_IN_WEEK) + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const leadingOffset = (firstOfMonth.getDay() - normalizedFirstDay + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const calendarGridStart = new Date(displayedYear.value, displayedMonth.value, 1 - leadingOffset);

  return Array.from({ length: DAYS_IN_WEEK }, (_, index) => {
    const date = new Date(calendarGridStart);
    date.setDate(calendarGridStart.getDate() - DAYS_IN_WEEK + index);

    return {
      isoDate: formatLocalIsoDate(date),
      label: date.getDate(),
      disabled: isDateOutsideBounds(date),
      ariaLabel: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
    };
  });
});

watch(() => props.modelValue, (value) => {
  const date = resolveDateValue(value);
  if (!date) return;

  displayedMonth.value = date.getMonth();
  displayedYear.value = date.getFullYear();
  selectedDateDraft.value = formatLocalIsoDate(date);
  timeDraft.value = {
    hour: String(date.getHours()).padStart(2, '0'),
    minute: String(date.getMinutes()).padStart(2, '0')
  };
});

const pickerModelValue = computed(() => selectedDateDraft.value);

/** 在日期面板挂载或切换月份后定位日期网格，供补充完整上月周。 */
watch(
  [pickerViewMode, displayedMonth, displayedYear, () => props.showAdjacentMonths],
  async ([viewMode, , , showAdjacentMonths]) => {
    monthDaysElement.value = null;
    if (viewMode !== 'month' || !showAdjacentMonths) return;

    await nextTick();
    monthDaysElement.value = datePickerRef.value?.$el
      ?.querySelector<HTMLElement>('.v-date-picker-month__days') ?? null;
  },
  { immediate: true }
);

/** 在年份面板挂载后绑定通用滚动条，并同步滚动区域的实际位置。 */
watch(pickerViewMode, async (viewMode) => {
  yearScrollerElement.value = null;
  yearScrollbarStyle.value = undefined;
  if (viewMode !== 'year') return;

  await nextTick();
  const surfaceElement = pickerSurfaceRef.value?.$el;
  const pickerElement = datePickerRef.value?.$el;
  const scrollerElement = pickerElement?.querySelector<HTMLElement>('.v-date-picker-years');
  if (!(surfaceElement instanceof HTMLElement) || !scrollerElement) return;

  const surfaceRect = surfaceElement.getBoundingClientRect();
  const scrollerRect = scrollerElement.getBoundingClientRect();
  yearScrollerElement.value = scrollerElement;
  yearScrollbarStyle.value = {
    top: `${scrollerRect.top - surfaceRect.top}px`,
    right: `${surfaceRect.right - scrollerRect.right}px`,
    left: 'auto',
    bottom: 'auto',
    height: `${scrollerRect.height}px`
  };
});

/** 接收 Vuetify 日期值，并拒绝公开契约之外的模型类型。 */
function handleDateSelected(value: unknown): void {
  if (value !== null && typeof value !== 'string' && !(value instanceof Date)) return;

  if (!props.showTime) {
    emit('update:modelValue', value);
    emit('select', value);
    return;
  }

  const date = resolveDateValue(value);
  if (!date) return;
  selectedDateDraft.value = formatLocalIsoDate(date);

  const hour = normalizeTimePart('hour', timeDraft.value.hour);
  const minute = normalizeTimePart('minute', timeDraft.value.minute);
  timeDraft.value = { hour, minute };
  date.setHours(Number(hour), Number(minute), 0, 0);
  const nextValue = props.modelValue instanceof Date
    ? date
    : `${formatLocalIsoDate(date)} ${hour}:${minute}`;
  emit(
    'update:modelValue',
    nextValue
  );
}

/** 将公开日期值转换为有效的本地 Date，避免 ISO 字符串发生 UTC 偏移。 */
function resolveDateValue(value: WsDatePickerValue | undefined): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : new Date(value);
  }

  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})(?:(?:\s+|T)(\d{2}):(\d{2})(?::\d{2})?)?$/u.exec(
    value.trim()
  );
  if (!match) return undefined;

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0)
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 将本地日期转换为日期选择器使用的 ISO 日期值。 */
function formatLocalIsoDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

/** 判断补充日期是否超出通用日期选择器允许范围。 */
function isDateOutsideBounds(date: Date): boolean {
  if (props.disabled || props.readonly) return true;

  const minDate = resolveDateValue(props.min);
  const maxDate = resolveDateValue(props.max);
  if (minDate && date < minDate) return true;
  if (maxDate && date > maxDate) return true;

  return false;
}

/** 选择固定补充的上月日期。 */
function selectLeadingDate(day: WsDatePickerLeadingDay): void {
  if (day.disabled) return;

  const selectedDate = resolveDateValue(day.isoDate);
  handleDateSelected(props.modelValue instanceof Date && selectedDate
    ? selectedDate
    : day.isoDate);
}

/** 清除当前日期值。 */
function clearDate(): void {
  emit('update:modelValue', null);
  emit('clear');
}

/** 返回本地时区中的今天日期，避免 UTC 转换造成日期偏移。 */
function createTodayValue(): WsDatePickerValue {
  if (props.modelValue instanceof Date) return new Date();

  if (props.showTime) {
    const today = new Date();
    return `${formatLocalIsoDate(today)} ${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}`;
  }

  return formatLocalIsoDate(new Date());
}

/** 将时间分段限制到合法范围并补足两位。 */
function normalizeTimePart(part: 'hour' | 'minute', value: string): string {
  const maximum = part === 'hour' ? 23 : 59;
  return String(Math.min(Number(value || 0), maximum)).padStart(2, '0');
}

/** 选择小时或分钟并同步完整日期时间草稿。 */
function selectTimeOption(part: 'hour' | 'minute', value: string): void {
  timeDraft.value = { ...timeDraft.value, [part]: normalizeTimePart(part, value) };
  const nextValue = createSelectedDateTimeValue();
  if (nextValue !== null) emit('update:modelValue', nextValue);
}

/** 合成当前日期和时分选择，保持公开模型的 Date 或字符串类型。 */
function createSelectedDateTimeValue(): WsDatePickerValue {
  const date = resolveDateValue(selectedDateDraft.value);
  if (!date) return null;

  const hour = normalizeTimePart('hour', timeDraft.value.hour);
  const minute = normalizeTimePart('minute', timeDraft.value.minute);
  date.setHours(Number(hour), Number(minute), 0, 0);
  return props.modelValue instanceof Date
    ? date
    : `${formatLocalIsoDate(date)} ${hour}:${minute}`;
}

/** 确认日期时间选择并通知上层关闭面板。 */
function confirmSelection(): void {
  const value = createSelectedDateTimeValue();
  if (value === null) return;

  emit('update:modelValue', value);
  emit('select', value);
}

/** 选择今天并同步日期模型。 */
function selectToday(): void {
  const today = createTodayValue();
  const todayDate = resolveDateValue(today);
  if (todayDate) selectedDateDraft.value = formatLocalIsoDate(todayDate);
  emit('update:modelValue', today);
  if (!props.showTime) emit('select', today);
  emit('today', today);
}

/** 记录面板切换来源，供年份选择后恢复月份面板。 */
function handlePickerViewModeUpdate(nextMode: WsDatePickerViewMode): void {
  returnToMonthsAfterYearSelection.value = pickerViewMode.value === 'months'
    && nextMode === 'year';
  pickerViewMode.value = nextMode;
}

/** 同步 Vuetify 当前展示月份。 */
function handlePickerMonthUpdate(month: unknown): void {
  if (typeof month === 'number' && Number.isInteger(month)) {
    displayedMonth.value = month;
  }
}

/** 从月份面板选择年份后返回月份面板，继续完成月份选择。 */
function handlePickerYearUpdate(year: unknown): void {
  if (typeof year === 'number' && Number.isInteger(year)) {
    displayedYear.value = year;
  }

  if (pickerViewMode.value !== 'year' || !returnToMonthsAfterYearSelection.value) return;

  returnToMonthsAfterYearSelection.value = false;
  void nextTick(() => {
    pickerViewMode.value = 'months';
  });
}

/** 保留 Vuetify 的边界禁用规则，仅允许月份面板切换年份。 */
function isPickerNavigationDisabled(
  disabledControls: readonly string[],
  control: WsDatePickerNavigationControl
): boolean {
  const isYearNavigation = control === 'prev-year' || control === 'next-year';
  if (pickerViewMode.value === 'months' && isYearNavigation) return false;

  return disabledControls.includes(control);
}
</script>

<template>
  <v-locale-provider
    locale="zhHans"
    :messages="dateLocaleMessages"
  >
    <v-sheet
      ref="pickerSurfaceRef"
      class="ws-date-picker"
      :class="{ 'ws-date-picker--with-time': showTime }"
    >
      <v-date-picker
        ref="datePickerRef"
        v-bind="datePickerProps"
        :model-value="pickerModelValue"
        :view-mode="pickerViewMode"
        :month="displayedMonth"
        :year="displayedYear"
        :min="min"
        :max="max"
        :disabled="disabled"
        :readonly="readonly"
        :first-day-of-week="firstDayOfWeek"
        :show-adjacent-months="showAdjacentMonths"
        @update:model-value="handleDateSelected"
        @update:month="handlePickerMonthUpdate"
        @update:view-mode="handlePickerViewModeUpdate"
        @update:year="handlePickerYearUpdate"
      >
        <template
          #controls="{
            disabled,
            monthText,
            yearText,
            openMonths,
            openYears,
            prevMonth,
            nextMonth,
            prevYear,
            nextYear
          }"
        >
          <div class="v-date-picker-controls__month">
            <v-btn
              v-bind="dateControlIconButtonProps"
              :disabled="isPickerNavigationDisabled(disabled, 'prev-month')"
              :icon="datePickerProps.prevIcon"
              aria-label="上个月"
              data-testid="prev-month"
              @click="prevMonth"
            />
            <v-btn
              v-bind="dateControlTextButtonProps"
              class="v-date-picker-controls__only-month-btn"
              :text="monthText"
              aria-label="选择月份"
              data-testid="month-btn"
              @click="openMonths"
            />
            <v-btn
              v-bind="dateControlIconButtonProps"
              :disabled="isPickerNavigationDisabled(disabled, 'next-month')"
              :icon="datePickerProps.nextIcon"
              aria-label="下个月"
              data-testid="next-month"
              @click="nextMonth"
            />
          </div>
          <v-spacer />
          <div class="v-date-picker-controls__year">
            <v-btn
              v-bind="dateControlIconButtonProps"
              :disabled="isPickerNavigationDisabled(disabled, 'prev-year')"
              :icon="datePickerProps.prevIcon"
              aria-label="上一年"
              data-testid="prev-year"
              @click="prevYear"
            />
            <v-btn
              v-bind="dateControlTextButtonProps"
              class="v-date-picker-controls__only-year-btn"
              :text="yearText"
              aria-label="选择年份"
              data-testid="year-btn"
              @click="openYears"
            />
            <v-btn
              v-bind="dateControlIconButtonProps"
              :disabled="isPickerNavigationDisabled(disabled, 'next-year')"
              :icon="datePickerProps.nextIcon"
              aria-label="下一年"
              data-testid="next-year"
              @click="nextYear"
            />
          </div>
        </template>

        <template #year="{ year, props: yearButtonProps }">
          <v-btn
            v-bind="yearButtonProps"
            :text="String(year.value)"
          />
        </template>

        <template #actions>
          <div
            v-if="(showActions || showTime) && pickerViewMode === 'month'"
            class="ws-date-picker__actions"
          >
            <template v-if="showActions">
              <slot
                name="actions"
                :clear="clearDate"
                :confirm="confirmSelection"
                :select-today="selectToday"
              >
                <v-btn
                  v-bind="dateActionButtonProps"
                  class="ws-date-picker__action"
                  @click="clearDate"
                >
                  清除
                </v-btn>
                <v-spacer />
                <v-btn
                  v-bind="dateActionButtonProps"
                  class="ws-date-picker__action"
                  @click="selectToday"
                >
                  今天
                </v-btn>
                <v-btn
                  v-if="showTime"
                  v-bind="dateActionButtonProps"
                  class="ws-date-picker__action"
                  @click="confirmSelection"
                >
                  确定
                </v-btn>
              </slot>
            </template>
          </div>
        </template>
      </v-date-picker>

      <!-- S = 时间选择面板 -->
      <aside v-if="showTime" class="ws-date-picker__time-panel">
        <WsTimeColumn
          label="时"
          :model-value="timeDraft.hour"
          :options="HOURS"
          @update:model-value="selectTimeOption('hour', $event)"
        />
        <WsTimeColumn
          label="分"
          :model-value="timeDraft.minute"
          :options="MINUTES"
          @update:model-value="selectTimeOption('minute', $event)"
        />
      </aside>
      <!-- E = 时间选择面板 -->

      <Teleport
        v-if="monthDaysElement && showAdjacentMonths"
        :to="monthDaysElement"
      >
        <div
          v-for="day in leadingWeekDates"
          :key="day.isoDate"
          class="v-date-picker-month__day v-date-picker-month__day--adjacent ws-date-picker__leading-day"
          :data-v-date="day.disabled ? undefined : day.isoDate"
        >
          <v-btn
            v-bind="leadingDayButtonProps"
            class="v-date-picker-month__day-btn"
            :aria-label="day.ariaLabel"
            :disabled="day.disabled"
            @click="selectLeadingDate(day)"
          >
            {{ day.label }}
          </v-btn>
        </div>
      </Teleport>

      <!-- S = 年份面板自定义滚动条 -->
      <WorkbenchVerticalScrollbar
        v-if="pickerViewMode === 'year' && yearScrollerElement"
        class="ws-date-picker__year-scrollbar"
        :scroller-element="yearScrollerElement"
        :style="yearScrollbarStyle"
      />
      <!-- E = 年份面板自定义滚动条 -->
    </v-sheet>
  </v-locale-provider>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.ws-date-picker {
  position: relative;
  box-sizing: border-box;
  width: $ws-date-picker-width + ($input-border-width * 2);
  min-width: $ws-date-picker-width + ($input-border-width * 2);
  border: $input-border-width solid var(--ws-border);
  background: var(--ws-editor-background);
  color: var(--ws-editor-foreground);
}

.ws-date-picker--with-time {
  width: $ws-date-picker-width + $ws-date-picker-time-panel-width + ($input-border-width * 2);
  min-width: $ws-date-picker-width + $ws-date-picker-time-panel-width + ($input-border-width * 2);
}

.ws-date-picker :deep(.v-date-picker) {
  width: $ws-date-picker-width !important;
  background: var(--ws-editor-background);
  color: var(--ws-editor-foreground);
}

.ws-date-picker :deep(.v-picker__actions) {
  padding: 0 0 $spacing-2xs $spacing-sm;
}

.ws-date-picker :deep(.v-date-picker-controls) {
  min-height: $ws-date-picker-control-height + $ws-date-picker-controls-padding-top;
  height: $ws-date-picker-control-height + $ws-date-picker-controls-padding-top;
  margin-top: $ws-date-picker-controls-padding-top;
}

.ws-date-picker :deep(.v-date-picker-controls .v-btn) {
  min-width: $icon-size-width;
  min-height: $icon-size-height;
  padding-inline: $spacing-2xs;
  border-radius: $radius-2px !important;
}

.ws-date-picker :deep(.v-date-picker-controls__month > [data-testid='prev-month']),
.ws-date-picker :deep(.v-date-picker-controls__month > [data-testid='next-month']),
.ws-date-picker :deep(.v-date-picker-controls__year > [data-testid='prev-year']),
.ws-date-picker :deep(.v-date-picker-controls__year > [data-testid='next-year']) {
  width: $ws-date-picker-control-height;
  height: $ws-date-picker-control-height;
  min-width: $ws-date-picker-control-height;
  min-height: $ws-date-picker-control-height;
  padding: 0;
}

.ws-date-picker :deep(.v-date-picker-controls__only-month-btn),
.ws-date-picker :deep(.v-date-picker-controls__only-year-btn) {
  height: $ws-date-picker-control-height;
  min-height: $ws-date-picker-control-height;
}

.ws-date-picker :deep(.v-date-picker-controls__only-month-btn .v-btn__content),
.ws-date-picker :deep(.v-date-picker-controls__only-year-btn .v-btn__content) {
  justify-content: center;
  width: 100%;
  text-align: center;
}

.ws-date-picker :deep(.v-date-picker-controls__only-month-btn .v-btn__append),
.ws-date-picker :deep(.v-date-picker-controls__only-year-btn .v-btn__append) {
  display: none;
}

.ws-date-picker :deep(.ws-date-picker__control-icon) {
  display: block;
  width: $icon-size-width;
  height: $icon-size-height;
  color: currentColor;
  line-height: 0;
}

.ws-date-picker :deep(.v-date-picker-month) {
  padding: $spacing-2xs;
}

.ws-date-picker :deep(.v-date-picker-month__weekday),
.ws-date-picker :deep(.v-date-picker-month__day) {
  font-size: $font-size-xs;
}

.ws-date-picker :deep(.v-date-picker-month__weekday) {
  order: -2;
}

.ws-date-picker__leading-day {
  order: -1;
}

.ws-date-picker :deep(.v-date-picker-month__day) {
  width: $ws-date-picker-cell-size;
  height: $ws-date-picker-cell-size;
}

.ws-date-picker :deep(.v-date-picker-month__days) {
  width: auto;
  margin-inline: auto;
  column-gap: $spacing-2xs;
  justify-content: start;
}

.ws-date-picker :deep(.v-date-picker-month__day .v-btn) {
  border-radius: $radius-2px;
}

.ws-date-picker :deep(.v-date-picker-month__day .v-date-picker-month__day-btn) {
  width: $ws-date-picker-day-button-size;
  height: $ws-date-picker-day-button-size;
  min-width: $ws-date-picker-day-button-size;
  min-height: $ws-date-picker-day-button-size;
  padding: 0;
}

.ws-date-picker :deep(.v-date-picker-month__day--selected .v-btn) {
  background: var(--ws-datePiker-selectedBackground) !important;
  color: rgb(var(--v-theme-on-primary)) !important;
}

.ws-date-picker :deep(.v-date-picker-months) {
  height: $ws-date-picker-months-height !important;
}

.ws-date-picker :deep(.v-date-picker-months__content) {
  grid-template-columns: repeat(2, $ws-date-picker-month-button-width);
  gap: $ws-date-picker-months-gap $spacing-sm;
  justify-content: center;
  padding-inline: $spacing-sm;
}

.ws-date-picker :deep(.v-date-picker-months__content .v-btn) {
  width: $ws-date-picker-month-button-width;
  min-width: $ws-date-picker-month-button-width;
  height: $ws-date-picker-month-button-height;
  min-height: $ws-date-picker-month-button-height;
  padding-inline: $spacing-2xs;
  border-radius: $radius-3px !important;
}

.ws-date-picker :deep(.v-date-picker-months__content .v-btn--active),
.ws-date-picker :deep(.v-date-picker-years__content .v-btn--active) {
  background-color: var(--ws-focusBorder) !important;
  color: var(--ws-button-foreground) !important;
}

.ws-date-picker :deep(.v-date-picker-months__content .v-btn--active > .v-btn__overlay),
.ws-date-picker :deep(.v-date-picker-years__content .v-btn--active > .v-btn__overlay) {
  display: none;
}

.ws-date-picker :deep(.v-date-picker-months__content .v-btn--active > .v-btn__content),
.ws-date-picker :deep(.v-date-picker-years__content .v-btn--active > .v-btn__content) {
  color: var(--ws-button-foreground);
}

.ws-date-picker :deep(.v-date-picker-years__content) {
  grid-template-columns: repeat(3, $ws-date-picker-year-button-width);
  gap: $spacing-xs $spacing-2xs;
  justify-content: center;
  padding-inline: $spacing-2xs;
}

.ws-date-picker :deep(.v-date-picker-years__content .v-btn) {
  width: 100%;
  min-width: 0;
  height: $ws-date-picker-month-button-height;
  min-height: $ws-date-picker-month-button-height;
  padding-inline: $spacing-2xs;
  border-radius: $radius-3px !important;
}

.ws-date-picker :deep(.v-date-picker-years) {
  scrollbar-width: none;
}

.ws-date-picker :deep(.v-date-picker-years::-webkit-scrollbar) {
  display: none;
}

.ws-date-picker__actions {
  @include flex-align-center;
  width: 100%;
  min-height: $ws-date-picker-cell-size;
  height: $ws-date-picker-cell-size;
  padding: 0 $spacing-2xs;
}

.ws-date-picker__time-panel {
  position: absolute;
  inset-block: 0;
  inset-inline-end: 0;
  display: grid;
  grid-template-columns: repeat(2, $ws-date-picker-time-column-width);
  width: $ws-date-picker-time-panel-width;
  min-width: $ws-date-picker-time-panel-width;
  min-height: 0;
  border-inline-start: $input-border-width solid var(--ws-border);
}

.ws-date-picker__action {
  width: $ws-date-picker-action-button-width;
  min-width: 0;
  height: $ws-date-picker-day-button-size;
  min-height: $ws-date-picker-day-button-size;
  padding: 0 $spacing-2xs;
  color: var(--ws-textLink-foreground);
}

.ws-date-picker__year-scrollbar {
  --workbench-scrollbar-hit-width: #{$scrollbar-hit-width};
  --workbench-scrollbar-thumb-width: #{$scrollbar-thumb-width};
  --workbench-scrollbar-thumb-min-height: #{$scrollbar-thumb-min-height};
  --workbench-scrollbar-thumb: var(--ws-editor-scrollbarSlider-background);
  --workbench-scrollbar-thumb-hover: var(--ws-editor-scrollbarSlider-hoverBackground);
  --workbench-scrollbar-thumb-active: var(--ws-editor-scrollbarSlider-activeBackground);
}
</style>
