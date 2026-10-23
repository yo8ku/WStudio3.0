<script setup lang="ts">
/**
 * 文件说明：共用颜色选择器，支持 RGB、HEX、不透明度和预设色板。
 */
import { computed } from 'vue';
import type { CSSProperties } from 'vue';

import WsInput from '@/components/WsInput/WsInput.vue';
import {
  CUSTOM_PROJECT_COLOR_SWATCHES,
  hexToRgbColor,
  type RgbColor,
  rgbToHexColor,
  normalizeHexColor
} from '@/utils/colorPalette';

interface ProjectColorPickerProps {
  borderless?: boolean;
  hideArrow?: boolean;
  customColors: readonly string[];
  modelValue: string;
}

const props = defineProps<ProjectColorPickerProps>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const colorPickerPanelProps = {
  elevation: 8,
} as const;
const colorCanvasProps = {
  elevation: 0,
  flat: true,
  hideEyeDropper: true,
  hideInputs: true,
  mode: 'hexa',
  modes: ['hexa'],
  showSwatches: false,
  width: '100%'
} as const;
const colorChannelInputProps = {
  density: 'compact',
  hideDetails: true,
  inputmode: 'numeric',
  maxlength: 3,
  variant: 'outlined'
} as const;
const hexInputProps = {
  density: 'compact',
  hideDetails: true,
  maxlength: 9,
  variant: 'outlined'
} as const;

const selectedColor = computed({
  get: () => props.modelValue,
  set: (value: string) => {
    const normalized = normalizeHexColor(value);
    if (normalized) emit('update:modelValue', normalized);
  }
});

const rgbColor = computed(() => hexToRgbColor(props.modelValue));
const defaultSwatchColors = CUSTOM_PROJECT_COLOR_SWATCHES.flat();
const swatchColors = computed(() => {
  const visibleCustomColors = props.customColors.slice(0, defaultSwatchColors.length);
  const customColorSet = new Set(visibleCustomColors);
  return [
    ...visibleCustomColors,
    ...defaultSwatchColors.filter(color => !customColorSet.has(color))
  ].slice(0, defaultSwatchColors.length);
});

/** 将当前颜色提供给色板顶部指示三角。 */
const colorPickerStyle = computed<CSSProperties & Record<'--ws-project-color-picker-color', string>>(
  () => ({ '--ws-project-color-picker-color': props.modelValue })
);

/** 更新指定 RGB 通道，并将结果转换为色板统一使用的 HEX 值。 */
function updateRgbChannel(channel: keyof RgbColor, value: unknown): void {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return;
  const color = rgbToHexColor({
    ...rgbColor.value,
    [channel]: numericValue
  });
  // RGB 调整保留精确 Alpha 字节，避免百分比四舍五入造成透明度漂移。
  emit('update:modelValue', `${color}${normalizeHexColor(props.modelValue)?.slice(7) ?? ''}`);
}

/** 校验并应用十六进制输入框中的颜色。 */
function updateHexColor(value: unknown): void {
  if (typeof value !== 'string') return;
  const normalized = normalizeHexColor(value);
  if (normalized) emit('update:modelValue', normalized);
}

/** 应用预设色块颜色。 */
function selectSwatchColor(color: string): void {
  emit('update:modelValue', color);
}

/** 生成色块所需的单色背景样式。 */
function resolveSwatchStyle(color: string): CSSProperties {
  return { backgroundColor: color };
}
</script>

<template>
  <v-sheet
    v-bind="colorPickerPanelProps"
    class="project-color-picker"
    :class="{
      'project-color-picker--borderless': borderless,
      'project-color-picker--hide-arrow': hideArrow
    }"
    :style="colorPickerStyle"
  >
    <v-color-picker
      v-model="selectedColor"
      v-bind="colorCanvasProps"
      class="project-color-picker__canvas"
    />

    <section class="project-color-picker__inputs" aria-label="颜色数值">
      <label class="project-color-picker__input">
        <span class="project-color-picker__input-label">R</span>
        <WsInput
          v-bind="colorChannelInputProps"
          aria-label="红色通道"
          :model-value="rgbColor.red"
          @update:model-value="updateRgbChannel('red', $event)"
        />
      </label>
      <label class="project-color-picker__input">
        <span class="project-color-picker__input-label">G</span>
        <WsInput
          v-bind="colorChannelInputProps"
          aria-label="绿色通道"
          :model-value="rgbColor.green"
          @update:model-value="updateRgbChannel('green', $event)"
        />
      </label>
      <label class="project-color-picker__input">
        <span class="project-color-picker__input-label">B</span>
        <WsInput
          v-bind="colorChannelInputProps"
          aria-label="蓝色通道"
          :model-value="rgbColor.blue"
          @update:model-value="updateRgbChannel('blue', $event)"
        />
      </label>
      <label class="project-color-picker__input">
        <span class="project-color-picker__input-label">十六进制</span>
        <WsInput
          v-bind="hexInputProps"
          aria-label="十六进制颜色"
          :model-value="modelValue"
          @update:model-value="updateHexColor"
        />
      </label>
    </section>

    <section
      class="project-color-picker__swatches"
      :class="{ 'project-color-picker__swatches--with-footer': !!$slots.footer }"
      aria-label="可选颜色"
    >
      <button
        v-for="color in swatchColors"
        :key="color"
        class="project-color-picker__swatch"
        :class="{ 'project-color-picker__swatch--selected': color === modelValue }"
        type="button"
        :aria-label="`选择颜色 ${color}`"
        :aria-pressed="color === modelValue"
        :style="resolveSwatchStyle(color)"
        @click="selectSwatchColor(color)"
      />
    </section>
    <slot name="footer" />
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.project-color-picker {
  position: relative;
  width: $project-color-picker-width;
  max-width: calc(100vw - ($spacing-md * 2));
  color: var(--ws-menu-foreground);
  background: var(--ws-editor-background) !important;
  border: 1px solid var(--ws-border);
  border-radius: $radius-xs;
  box-shadow: 0;
}

.project-color-picker--borderless {
  border: 0;
}

:global(.v-menu > .workbench-title-bar__color-picker-menu > .project-color-picker) {
  overflow: visible;
}

.project-color-picker:not(.project-color-picker--hide-arrow)::before {
  content: '';
  position: absolute;
  top: calc($project-color-picker-arrow-height * -1);
  left: 50%;
  width: $project-color-picker-arrow-width;
  height: $project-color-picker-arrow-height;
  background: var(--ws-project-color-picker-color);
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
  transform: translateX(-50%);
}

.project-color-picker__canvas {
  background: transparent;
}

.project-color-picker__inputs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(0, 2fr);
  gap: $project-color-picker-input-gap;
  padding-inline: $project-color-picker-content-padding;
  margin-bottom: $menu-compact-spacing;
}

.project-color-picker__input {
  display: grid;
  row-gap: $spacing-2xs;
}

.project-color-picker__input-label {
  font-size: $font-size-xs;
  line-height: $font-size-md;
  text-align: center;
}

.project-color-picker__inputs :deep(.v-field__input) {
  min-height: $project-color-picker-input-height;
  padding: $spacing-3xs $spacing-2xs;
  font-size: $font-size-xs;
  text-align: center;
}

.project-color-picker__swatches {
  display: grid;
  grid-template-columns: repeat(
    $project-color-picker-swatch-columns,
    $project-color-picker-swatch-size
  );
  justify-content: space-between;
  row-gap: $project-color-picker-swatch-row-gap;
  padding: $project-color-picker-section-gap $project-color-picker-content-padding;
  margin-bottom: $spacing-xs;
}

.project-color-picker__swatches--with-footer {
  margin-bottom: 0;
}

.project-color-picker__swatch {
  width: $project-color-picker-swatch-size;
  height: $project-color-picker-swatch-size;
  padding: 0;
  border: 1px solid var(--ws-border);
  border-radius: $radius-2px;
  cursor: pointer;
}

.project-color-picker__swatch:hover {
  border: $project-color-picker-selected-swatch-border-width solid var(--ws-checked-border,#FFF);
}

</style>
