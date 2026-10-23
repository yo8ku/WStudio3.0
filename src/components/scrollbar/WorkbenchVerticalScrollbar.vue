<script setup lang="ts">
/**
 * 文件说明：渲染工作台通用纵向自定义滚动条，并同步外部滚动容器的位置、拖拽行为与淡入淡出过渡。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface WorkbenchVerticalScrollbarProps {
  scrollerElement?: HTMLElement | null;
  alwaysVisible?: boolean;
  topInset?: number;
}

const props = withDefaults(defineProps<WorkbenchVerticalScrollbarProps>(), {
  scrollerElement: null,
  alwaysVisible: false,
  topInset: 0
});

const scrollbarElement = ref<HTMLElement | null>(null);
const scrollbarThumbElement = ref<HTMLButtonElement | null>(null);
const scrollTop = ref(0);
const scrollHeight = ref(0);
const clientHeight = ref(0);
const scrollbarTrackHeight = ref(0);
const scrollbarOpacity = ref(0);
const isPointerInsideScroller = ref(false);
const isPointerInsideThumb = ref(false);
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let scheduledSyncFrame = 0;
let activeScrollbarPointerId: number | undefined;
let scrollbarDragStartY = 0;
let scrollbarDragStartScrollTop = 0;
let attachedScroller: HTMLElement | null = null;
let hideScrollbarTimeout = 0;
let opacityAnimationTimeout = 0;

const showVerticalScrollbar = computed(() =>
  scrollHeight.value - clientHeight.value > 1
);

const scrollbarTopInset = computed(() => (
  Number.isFinite(props.topInset) ? Math.max(0, props.topInset) : 0
));

const scrollbarContainerStyle = computed(() => ({
  top: `${scrollbarTopInset.value}px`
}));

const verticalThumbHeight = computed(() => {
  if (!showVerticalScrollbar.value || scrollbarTrackHeight.value <= 0 || scrollHeight.value <= 0) {
    return 0;
  }

  const scaledHeight = (scrollbarTrackHeight.value * clientHeight.value) / scrollHeight.value;

  return Math.max(getScrollbarThumbMinHeight(), Math.min(scrollbarTrackHeight.value, scaledHeight));
});

const verticalThumbOffset = computed(() => {
  if (!showVerticalScrollbar.value) {
    return 0;
  }

  const maxScrollTop = scrollHeight.value - clientHeight.value;
  const maxThumbOffset = scrollbarTrackHeight.value - verticalThumbHeight.value;

  if (maxScrollTop <= 0 || maxThumbOffset <= 0) {
    return 0;
  }

  return (scrollTop.value / maxScrollTop) * maxThumbOffset;
});

const verticalThumbStyle = computed(() => ({
  height: `${Math.max(
    verticalThumbHeight.value,
    props.alwaysVisible ? getScrollbarThumbMinHeight() : 0
  )}px`,
  transform: `translateY(${verticalThumbOffset.value}px)`,
  opacity: props.alwaysVisible && showVerticalScrollbar.value
    ? getScrollbarVisibleOpacity().toFixed(3)
    : scrollbarOpacity.value.toFixed(3)
}));

/**
 * 将 CSS 长度值转换为像素值，供滑块最小高度计算使用。
 */
function convertCssLengthToPixels(length: string): number {
  const value = Number.parseFloat(length);

  if (Number.isNaN(value)) {
    return 0;
  }

  if (length.endsWith('rem')) {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return value * rootFontSize;
  }

  return value;
}

/**
 * 将 CSS 时间值转换为毫秒值，供淡出延迟计算使用。
 */
function convertCssTimeToMilliseconds(time: string): number {
  const value = Number.parseFloat(time);

  if (Number.isNaN(value)) {
    return 0;
  }

  if (time.endsWith('ms')) {
    return value;
  }

  if (time.endsWith('s')) {
    return value * 1000;
  }

  return value;
}

/**
 * 读取滚动条滑块最小高度，保持脚本计算与样式来源一致。
 */
function getScrollbarThumbMinHeight(): number {
  if (!scrollbarElement.value) {
    return 0;
  }

  const thumbMinHeight = getComputedStyle(scrollbarElement.value)
    .getPropertyValue('--workbench-scrollbar-thumb-min-height')
    .trim();

  return convertCssLengthToPixels(thumbMinHeight);
}

/**
 * 读取滚动条淡出延迟，保持脚本行为与样式来源一致。
 */
function getScrollbarFadeOutDelay(): number {
  if (!scrollbarElement.value) {
    return 0;
  }

  const fadeOutDelay = getComputedStyle(scrollbarElement.value)
    .getPropertyValue('--workbench-scrollbar-fade-out-delay')
    .trim();

  return convertCssTimeToMilliseconds(fadeOutDelay);
}

/**
 * 读取滚动条淡入淡出时长，供淡出结束后彻底卸载滑块使用。
 */
function getScrollbarFadeDuration(): number {
  if (!scrollbarElement.value) {
    return 0;
  }

  const fadeDuration = getComputedStyle(scrollbarElement.value)
    .getPropertyValue('--workbench-scrollbar-fade-duration')
    .trim();

  return convertCssTimeToMilliseconds(fadeDuration);
}

/**
 * 读取滚动条可见时的目标透明度，保证脚本行为与样式来源一致。
 */
function getScrollbarVisibleOpacity(): number {
  if (!scrollbarElement.value) {
    return 0.5;
  }

  const visibleOpacity = getComputedStyle(scrollbarElement.value)
    .getPropertyValue('--workbench-scrollbar-thumb-opacity')
    .trim();

  return Number.parseFloat(visibleOpacity) || 0.5;
}

/**
 * 同步滚动容器尺寸，用于计算自定义滚动条的显示状态与滑块位置。
 */
function syncScrollerMetrics(): void {
  const scroller = attachedScroller;

  if (!scroller) {
    scrollTop.value = 0;
    scrollHeight.value = 0;
    clientHeight.value = 0;
    scrollbarTrackHeight.value = 0;
    hideScrollbarImmediately();
    return;
  }

  scrollTop.value = scroller.scrollTop;
  scrollHeight.value = scroller.scrollHeight;
  clientHeight.value = scroller.clientHeight;
  scrollbarTrackHeight.value = scrollbarElement.value?.clientHeight || clientHeight.value;

  if (!showVerticalScrollbar.value) {
    hideScrollbarImmediately();
  }
}

/**
 * 清理滚动条淡出定时器，避免重复进入时出现闪烁。
 */
function clearHideScrollbarTimeout(): void {
  if (hideScrollbarTimeout === 0) {
    return;
  }

  window.clearTimeout(hideScrollbarTimeout);
  hideScrollbarTimeout = 0;
}

/**
 * 清理透明度动画定时器，避免多段动画互相打断时状态抖动。
 */
function clearOpacityAnimationTimeout(): void {
  if (opacityAnimationTimeout === 0) {
    return;
  }

  window.clearTimeout(opacityAnimationTimeout);
  opacityAnimationTimeout = 0;
}

/**
 * 立即隐藏并卸载滚动条，用于内容不再可滚动或组件销毁时收尾。
 */
function hideScrollbarImmediately(): void {
  clearHideScrollbarTimeout();
  clearOpacityAnimationTimeout();
  scrollbarOpacity.value = 0;
}

/**
 * 以连续透明度变化的方式播放滚动条显隐动画，让视觉过渡更明显。
 */
function animateScrollbarOpacity(nextOpacity: number): void {
  clearOpacityAnimationTimeout();

  const duration = getScrollbarFadeDuration();

  if (duration <= 0) {
    scrollbarOpacity.value = nextOpacity;
    return;
  }

  const stepInterval = 16;
  const startOpacity = scrollbarOpacity.value;
  const deltaOpacity = nextOpacity - startOpacity;
  const steps = Math.max(1, Math.round(duration / stepInterval));
  let currentStep = 0;

  const tick = () => {
    currentStep += 1;
    const progress = Math.min(currentStep / steps, 1);
    scrollbarOpacity.value = Number((startOpacity + deltaOpacity * progress).toFixed(3));

    if (progress >= 1) {
      opacityAnimationTimeout = 0;
      return;
    }

    opacityAnimationTimeout = window.setTimeout(tick, stepInterval);
  };

  tick();
}

/**
 * 立即显示滚动条，用于鼠标进入滚动区域或开始拖拽时淡入。
 */
function showScrollbar(): void {
  clearHideScrollbarTimeout();

  if (!showVerticalScrollbar.value) {
    return;
  }

  if (props.alwaysVisible) {
    clearOpacityAnimationTimeout();
    scrollbarOpacity.value = getScrollbarVisibleOpacity();
    return;
  }

  animateScrollbarOpacity(getScrollbarVisibleOpacity());
}

/**
 * 在鼠标离开滚动区域后延迟隐藏滚动条，形成自然淡出效果。
 */
function scheduleHideScrollbar(): void {
  if (props.alwaysVisible) {
    return;
  }

  if (
    activeScrollbarPointerId !== undefined
    || isPointerInsideScroller.value
    || isPointerInsideThumb.value
  ) {
    return;
  }

  clearHideScrollbarTimeout();
  hideScrollbarTimeout = window.setTimeout(() => {
    hideScrollbarTimeout = 0;
    animateScrollbarOpacity(0);
  }, getScrollbarFadeOutDelay());
}

/**
 * 合并一帧内的多次滚动同步请求，避免频繁布局抖动。
 */
function scheduleScrollerSync(): void {
  if (scheduledSyncFrame !== 0) {
    window.cancelAnimationFrame(scheduledSyncFrame);
  }

  scheduledSyncFrame = window.requestAnimationFrame(() => {
    scheduledSyncFrame = 0;
    syncScrollerMetrics();
  });
}

/**
 * 响应滚动容器原生滚动事件并刷新滚动条状态。
 */
function handleScrollerScroll(): void {
  syncScrollerMetrics();
  showScrollbar();

  if (!isPointerInsideScroller.value) {
    scheduleHideScrollbar();
  }
}

/**
 * 在鼠标进入滚动容器时显示滚动条。
 */
function handleScrollerPointerEnter(): void {
  isPointerInsideScroller.value = true;
  showScrollbar();
}

/**
 * 在鼠标离开滚动容器时启动淡出流程。
 */
function handleScrollerPointerLeave(): void {
  isPointerInsideScroller.value = false;
  scheduleHideScrollbar();
}

/**
 * 在鼠标进入滚动条滑块时保持滚动条可见。
 */
function handleScrollbarThumbPointerEnter(): void {
  isPointerInsideThumb.value = true;
  showScrollbar();
}

/**
 * 在鼠标离开滚动条滑块时启动淡出流程。
 */
function handleScrollbarThumbPointerLeave(): void {
  isPointerInsideThumb.value = false;
  scheduleHideScrollbar();
}

/** 窗口失焦时清除指针状态，避免滚动条保持可见。 */
function handleWindowBlur(): void {
  isPointerInsideScroller.value = false;
  isPointerInsideThumb.value = false;
  cleanupScrollbarDrag();
  scheduleHideScrollbar();
}

/**
 * 卸载与当前滚动容器绑定的事件和观察器。
 */
function detachScroller(): void {
  attachedScroller?.removeEventListener('scroll', handleScrollerScroll);
  attachedScroller?.removeEventListener('pointerenter', handleScrollerPointerEnter);
  attachedScroller?.removeEventListener('pointerleave', handleScrollerPointerLeave);
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  resizeObserver = undefined;
  mutationObserver = undefined;
  attachedScroller = null;
  isPointerInsideScroller.value = false;
  isPointerInsideThumb.value = false;
}

/**
 * 将自定义滚动条绑定到当前滚动容器上。
 */
function attachScroller(nextScroller: HTMLElement | null | undefined): void {
  if (attachedScroller === nextScroller) {
    scheduleScrollerSync();
    return;
  }

  detachScroller();

  if (!nextScroller) {
    syncScrollerMetrics();
    return;
  }

  attachedScroller = nextScroller;
  nextScroller.addEventListener('scroll', handleScrollerScroll, { passive: true });
  nextScroller.addEventListener('pointerenter', handleScrollerPointerEnter);
  nextScroller.addEventListener('pointerleave', handleScrollerPointerLeave);
  resizeObserver = new ResizeObserver(() => {
    scheduleScrollerSync();
  });
  resizeObserver.observe(nextScroller);
  mutationObserver = new MutationObserver(() => {
    scheduleScrollerSync();
  });
  mutationObserver.observe(nextScroller, {
    childList: true,
    subtree: true,
    characterData: true
  });
  scheduleScrollerSync();
}

/**
 * 结束滚动条拖拽，并清理全局指针事件监听。
 */
function cleanupScrollbarDrag(): void {
  activeScrollbarPointerId = undefined;
  window.removeEventListener('pointermove', handleWindowPointerMove);
  window.removeEventListener('pointerup', handleWindowPointerUp);
  window.removeEventListener('pointercancel', handleWindowPointerUp);
}

/**
 * 根据指针位移计算滚动位置，实现自定义滚动条拖拽。
 */
function handleWindowPointerMove(event: PointerEvent): void {
  const scroller = attachedScroller;

  if (activeScrollbarPointerId !== event.pointerId || !scroller) {
    return;
  }

  const maxScrollTop = scrollHeight.value - clientHeight.value;
  const maxThumbOffset = scrollbarTrackHeight.value - verticalThumbHeight.value;

  if (maxScrollTop <= 0 || maxThumbOffset <= 0) {
    return;
  }

  const deltaY = event.clientY - scrollbarDragStartY;
  const nextScrollTop = scrollbarDragStartScrollTop + ((deltaY / maxThumbOffset) * maxScrollTop);

  scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop));
  syncScrollerMetrics();
}

/**
 * 在指针释放或取消时终止滚动条拖拽。
 */
function handleWindowPointerUp(event: PointerEvent): void {
  if (activeScrollbarPointerId !== event.pointerId) {
    return;
  }

  cleanupScrollbarDrag();

  if (isPointerInsideScroller.value || isPointerInsideThumb.value) {
    showScrollbar();
    return;
  }

  scheduleHideScrollbar();
}

/**
 * 启动滚动条滑块拖拽，并注册全局指针跟踪。
 */
function handleScrollbarThumbPointerDown(event: PointerEvent): void {
  const scroller = attachedScroller;

  if (!showVerticalScrollbar.value || !scroller) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  showScrollbar();
  activeScrollbarPointerId = event.pointerId;
  scrollbarDragStartY = event.clientY;
  scrollbarDragStartScrollTop = scroller.scrollTop;
  scrollbarThumbElement.value?.setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', handleWindowPointerMove);
  window.addEventListener('pointerup', handleWindowPointerUp);
  window.addEventListener('pointercancel', handleWindowPointerUp);
}

/**
 * 在滚动容器引用变化时重新绑定自定义滚动条。
 */
watch(() => props.scrollerElement, (nextScroller) => {
  attachScroller(nextScroller);
}, {
  immediate: true
});

/**
 * 当内容重新变为不可滚动时，立即回收滚动条节点。
 */
watch(showVerticalScrollbar, (hasScrollableContent) => {
  if (hasScrollableContent) {
    if (props.alwaysVisible) {
      showScrollbar();
    }
    return;
  }

  hideScrollbarImmediately();
}, { immediate: true });

watch(() => props.alwaysVisible, (alwaysVisible) => {
  if (alwaysVisible && showVerticalScrollbar.value) {
    showScrollbar();
    return;
  }

  if (!alwaysVisible) {
    scheduleHideScrollbar();
  }
});

/** 顶部预留变更后，在更新过的轨道尺寸上重新计算滑块。 */
watch(scrollbarTopInset, () => {
  void nextTick(scheduleScrollerSync);
});

onMounted(() => {
  window.addEventListener('blur', handleWindowBlur);
});

/**
 * 释放动画帧、滚动监听和拖拽事件，防止组件卸载后残留副作用。
 */
onBeforeUnmount(() => {
  window.removeEventListener('blur', handleWindowBlur);
  if (scheduledSyncFrame !== 0) {
    window.cancelAnimationFrame(scheduledSyncFrame);
    scheduledSyncFrame = 0;
  }

  clearHideScrollbarTimeout();
  clearOpacityAnimationTimeout();
  cleanupScrollbarDrag();
  detachScroller();
});
</script>

<template>
  <div
    v-show="props.alwaysVisible || showVerticalScrollbar"
    ref="scrollbarElement"
    class="scrollbar-vertical"
    :class="{ 'scrollbar-vertical--interactive': props.alwaysVisible || scrollbarOpacity > 0.01 }"
    :style="scrollbarContainerStyle"
    aria-hidden="true"
  >
    <button
      ref="scrollbarThumbElement"
      type="button"
      tabindex="-1"
      class="scrollbar-vertical__thumb"
      :style="verticalThumbStyle"
      @mousedown.prevent.stop
      @click.prevent.stop
      @pointerenter="handleScrollbarThumbPointerEnter"
      @pointerleave="handleScrollbarThumbPointerLeave"
      @pointerdown="handleScrollbarThumbPointerDown"
    />
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.scrollbar-vertical {
  --workbench-scrollbar-fade-out-delay: #{$scrollbar-fade-out-delay};
  --workbench-scrollbar-fade-duration: #{$scrollbar-fade-duration};
  --workbench-scrollbar-thumb-idle-opacity: #{$scrollbar-thumb-idle-opacity};
  --workbench-scrollbar-thumb-opacity: #{$scrollbar-thumb-opacity};
  --workbench-scrollbar-thumb-hover-opacity: #{$scrollbar-thumb-hover-opacity};
  --workbench-scrollbar-thumb-active-opacity: #{$scrollbar-thumb-active-opacity};
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--workbench-scrollbar-hit-width);
  pointer-events: none;
}

.scrollbar-vertical__thumb {
  position: absolute;
  top: 0;
  right: 0;
  width: var(--workbench-scrollbar-thumb-width);
  min-height: var(--workbench-scrollbar-thumb-min-height);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--workbench-scrollbar-thumb);
  box-shadow: none;
  pointer-events: none;
  cursor: default;
  touch-action: none;
  user-select: none;
  will-change: opacity;
  transition: background-color $scrollbar-fade-duration $scrollbar-fade-easing;
}

.scrollbar-vertical--interactive .scrollbar-vertical__thumb {
  pointer-events: auto;
  
}

.scrollbar-vertical__thumb:hover {
  background: var(--workbench-scrollbar-thumb-hover);
}

.scrollbar-vertical__thumb:active {
  background: var(--workbench-scrollbar-thumb-active);

}
</style>
