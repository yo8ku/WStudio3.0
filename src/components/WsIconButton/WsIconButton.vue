<script setup lang="ts">
/**
 * 文件说明：提供全局可复用的 Vuetify 图标按钮基础组件，仅负责按钮语义与图标内容。
 */
import { computed, mergeProps, useAttrs, useSlots, type CSSProperties } from 'vue';

import WsTooltip from '@/components/WsTooltip/WsTooltip.vue';
import { iconButtonDefaultProps } from './iconButton';

defineOptions({
  inheritAttrs: false
});

const props = withDefaults(
  defineProps<{
    /** 按钮的无障碍名称。 */
    label: string;
    /** 按钮内部的字体图标 class；传入 HTML markup 时保留旧 SVG 兼容。 */
    icon?: string;
    /** 按钮图标的资源地址。 */
    iconUrl?: string;
    /** 图标容器的自定义样式类名。 */
    iconClass?: string | readonly string[];
    /** 图标相对于文字的排列位置。 */
    iconPosition?: 'start' | 'end';
    text?: string;
    /** 按钮悬停时显示的自定义提示文案。 */
    tooltip?: string;
    /** 可选的按下状态。 */
    pressed?: boolean;
    /** 可选的视觉激活状态。 */
    active?: boolean;
  }>(),
  {
    icon: '',
    iconUrl: '',
    iconClass: undefined,
    iconPosition: 'end',
    text: undefined,
    tooltip: undefined,
    pressed: undefined,
    active: false
  }
);

const emit = defineEmits<{
  /** 转发 Vuetify 按钮点击事件。 */
  click: [event: MouseEvent];
}>();

const slots = useSlots();
const hasIconUrl = computed(() => Boolean(props.iconUrl.trim()));
const iconClassName = computed(() => [
  'ws-icon-button__icon',
  { 'ws-icon-button__icon--url': hasIconUrl.value },
  props.iconClass
]);
const hasText = computed(() => Boolean(props.text));
const hasIconSlot = computed(() => Boolean(slots.icon));
const hasIcon = computed(() => Boolean(props.icon) || hasIconUrl.value || hasIconSlot.value);
const iconMarkupIsHtml = computed(() => props.icon.trimStart().startsWith('<'));
const iconMarkupClass = computed(() => iconMarkupIsHtml.value ? undefined : props.icon);
const attrs = useAttrs();

const iconStyle = computed<CSSProperties | undefined>(() => {
  if (!hasIconUrl.value) {
    return undefined;
  }

  const maskImage = `url("${props.iconUrl}")`;
  return {
    WebkitMaskImage: maskImage,
    maskImage
  };
});

/**
 * 兼容旧调用传入的 title，同时阻止它继续透传为浏览器原生提示。
 */
const tooltipText = computed(() => {
  const explicitTooltip = props.tooltip?.trim();
  if (explicitTooltip) return explicitTooltip;

  return typeof attrs.title === 'string' ? attrs.title.trim() : '';
});

const forwardedAttrs = computed(() => {
  const { title: _nativeTitle, ...remainingAttrs } = attrs;
  return remainingAttrs;
});

/** 合并基础属性、调用方属性和 tooltip 激活器事件。 */
function getButtonBindings(tooltipProps: Record<string, unknown>): Record<string, unknown> {
  return mergeProps(iconButtonDefaultProps, forwardedAttrs.value, tooltipProps);
}

/**
 * 转发按钮点击事件，视觉与交互样式由调用方通过 attrs 决定。
 */
function handleClick(event: MouseEvent): void {
  emit('click', event);
}
</script>

<template>
  <WsTooltip
    :disabled="tooltipText.length === 0"
    :text="tooltipText"
  >
    <template #activator="{ props: tooltipProps }">
      <v-btn
        v-bind="getButtonBindings(tooltipProps)"
        :icon="!hasText && hasIcon"
        class="ws-icon-button"
        :class="{
          'v-btn--active': props.active,
          'ws-icon-button--active': props.active,
          'ws-icon-button--icon-start': props.iconPosition === 'start',
          'ws-icon-button--with-text': hasText
        }"
        :aria-label="label"
        :aria-pressed="pressed"
        @click="handleClick"
      >
        <span v-if="hasText" class="ws-icon-button__text">{{ props.text }}</span>
        <span
          v-if="hasIconSlot"
          :class="iconClassName"
          aria-hidden="true"
        >
          <slot name="icon" />
        </span>
        <span
          v-else-if="hasIcon"
          :class="[iconClassName, iconMarkupClass]"
          :style="iconStyle"
          aria-hidden="true"
        >
          <span v-if="iconMarkupIsHtml" v-html="icon" />
        </span>
        <slot name="badge" />
      </v-btn>
    </template>
  </WsTooltip>
</template>
