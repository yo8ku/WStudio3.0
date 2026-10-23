<script setup lang="ts">
/**
 * 文件说明：渲染工作台通用横向自定义滚动条，并同步外部滚动容器的位置、拖拽行为与淡入淡出过渡。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface WorkbenchHorizontalScrollbarProps {
  scrollerElement?: HTMLElement | null;
}

const props = withDefaults(defineProps<WorkbenchHorizontalScrollbarProps>(), {
  scrollerElement: null
});

const scrollbarElement = ref<HTMLElement | null>(null);
const scrollbarThumbElement = ref<HTMLButtonElement | null>(null);
const scrollLeft = ref(0);
const scrollWidth = ref(0);
const clientWidth = ref(0);
const scrollbarOpacity = ref(0);
const isPointerInsideScroller = ref(false);
const isPointerInsideThumb = ref(false);
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let scheduledSyncFrame = 0;
let activeScrollbarPointerId: number | undefined;
let scrollbarDragStartX = 0;
let scrollbarDragStartScrollLeft = 0;
let attachedScroller: HTMLElement | null = null;
let hideScrollbarTimeout = 0;
let opacityAnimationTimeout = 0;

const showHorizontalScrollbar = computed(() =>
  scrollWidth.value - clientWidth.value > 1
);

// DOM 的 clientWidth 不是响应式数据，随容器尺寸一起同步轨道宽度。
const horizontalTrackWidth = ref(0);

const horizontalThumbWidth = computed(() => {
  if (!showHorizontalScrollbar.value || horizontalTrackWidth.value <= 0 || clientWidth.value <= 0 || scrollWidth.value <= 0) {
    return 0;
  }

  const scaledWidth = (horizontalTrackWidth.value * clientWidth.value) / scrollWidth.value;

  return Math.min(horizontalTrackWidth.value, Math.max(getScrollbarThumbMinWidth(), scaledWidth));
});

const horizontalThumbOffset = computed(() => {
  if (!showHorizontalScrollbar.value) {
    return 0;
  }

  const maxScrollLeft = scrollWidth.value - clientWidth.value;
  const maxThumbOffset = horizontalTrackWidth.value - horizontalThumbWidth.value;

  if (maxScrollLeft <= 0 || maxThumbOffset <= 0) {
    return 0;
  }

  return (scrollLeft.value / maxScrollLeft) * maxThumbOffset;
});

const horizontalThumbStyle = computed(() => ({
  width: `${horizontalThumbWidth.value}px`,
  transform: `translateX(${horizontalThumbOffset.value}px)`,
  opacity: scrollbarOpacity.value.toFixed(3)
}));

/**
 * 读取滚动条滑块最小宽度，保持脚本计算与样式来源一致。
 */
function getScrollbarThumbMinWidth(): number {
  if (!scrollbarElement.value) {
    return 0;
  }

  const thumbMinWidth = getComputedStyle(scrollbarElement.value)
    .getPropertyValue('--workbench-scrollbar-thumb-min-width')
    .trim();
  const value = Number.parseFloat(thumbMinWidth);

  if (Number.isNaN(value)) {
    return 0;
  }

  if (thumbMinWidth.endsWith('rem')) {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return value * rootFontSize;
  }

  return value;
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
  const value = Number.parseFloat(fadeOutDelay);

  if (Number.isNaN(value)) {
    return 0;
  }

  if (fadeOutDelay.endsWith('ms')) {
    return value;
  }

  if (fadeOutDelay.endsWith('s')) {
    return value * 1000;
  }

  return value;
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
  const value = Number.parseFloat(fadeDuration);

  if (Number.isNaN(value)) {
    return 0;
  }

  if (fadeDuration.endsWith('ms')) {
    return value;
  }

  if (fadeDuration.endsWith('s')) {
    return value * 1000;
  }

  return value;
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
  const value = Number.parseFloat(visibleOpacity);

  return Number.isNaN(value) ? 0.5 : value;
}

/**
 * 同步滚动容器尺寸，用于计算自定义横向滚动条的显示状态与滑块位置。
 */
function syncScrollerMetrics(): void {
  const scroller = attachedScroller;

  if (!scroller) {
    scrollLeft.value = 0;
    scrollWidth.value = 0;
    clientWidth.value = 0;
    horizontalTrackWidth.value = 0;
    hideScrollbarImmediately();
    return;
  }

  scrollLeft.value = scroller.scrollLeft;
  scrollWidth.value = scroller.scrollWidth;
  clientWidth.value = scroller.clientWidth;
  horizontalTrackWidth.value = scrollbarElement.value?.clientWidth || scroller.clientWidth;

  if (!showHorizontalScrollbar.value) {
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

  if (!showHorizontalScrollbar.value) {
    return;
  }

  animateScrollbarOpacity(getScrollbarVisibleOpacity());
}

/**
 * 在鼠标离开滚动区域后延迟隐藏滚动条，形成自然淡出效果。
 */
function scheduleHideScrollbar(): void {
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
 * 将自定义横向滚动条绑定到当前滚动容器上。
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
 * 根据指针位移计算滚动位置，实现自定义横向滚动条拖拽。
 */
function handleWindowPointerMove(event: PointerEvent): void {
  const scroller = attachedScroller;

  if (activeScrollbarPointerId !== event.pointerId || !scroller) {
    return;
  }

  const maxScrollLeft = scrollWidth.value - clientWidth.value;
  const maxThumbOffset = horizontalTrackWidth.value - horizontalThumbWidth.value;

  if (maxScrollLeft <= 0 || maxThumbOffset <= 0) {
    return;
  }

  const deltaX = event.clientX - scrollbarDragStartX;
  const nextScrollLeft = scrollbarDragStartScrollLeft + ((deltaX / maxThumbOffset) * maxScrollLeft);

  scroller.scrollLeft = Math.max(0, Math.min(maxScrollLeft, nextScrollLeft));
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

  if (!showHorizontalScrollbar.value || !scroller) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  showScrollbar();
  activeScrollbarPointerId = event.pointerId;
  scrollbarDragStartX = event.clientX;
  scrollbarDragStartScrollLeft = scroller.scrollLeft;
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
watch(showHorizontalScrollbar, (hasScrollableContent) => {
  if (hasScrollableContent) {
    return;
  }

  hideScrollbarImmediately();
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
    v-show="showHorizontalScrollbar"
    ref="scrollbarElement"
    class="scrollbar-horizontal"
    :class="{ 'scrollbar-horizontal--interactive': scrollbarOpacity > 0.01 }"
    aria-hidden="true"
  >
    <button
      ref="scrollbarThumbElement"
      type="button"
      tabindex="-1"
      class="scrollbar-horizontal__thumb"
      :style="horizontalThumbStyle"
      @pointerenter="handleScrollbarThumbPointerEnter"
      @pointerleave="handleScrollbarThumbPointerLeave"
      @pointerdown="handleScrollbarThumbPointerDown"
    />
  </div>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.scrollbar-horizontal {
  --workbench-scrollbar-fade-out-delay: #{$scrollbar-fade-out-delay};
  --workbench-scrollbar-fade-duration: #{$scrollbar-fade-duration};
  --workbench-scrollbar-thumb-opacity: #{$scrollbar-thumb-opacity};
  --workbench-scrollbar-thumb-hover-opacity: #{$scrollbar-thumb-hover-opacity};
  --workbench-scrollbar-thumb-active-opacity: #{$scrollbar-thumb-active-opacity};
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: var(--workbench-scrollbar-hit-height);
  pointer-events: none;
}

.scrollbar-horizontal__thumb {
  position: absolute;
  bottom: 0;
  left: 0;
  width: var(--workbench-scrollbar-thumb-min-width);
  height: var(--workbench-scrollbar-thumb-height);
  min-width: var(--workbench-scrollbar-thumb-min-width);
  padding: 0;
  border: 0;
  border-radius: 0;
  background: var(--workbench-scrollbar-thumb);
  box-shadow: none;
  pointer-events: none;
  cursor: default;
  will-change: opacity;
  transition: background-color $scrollbar-fade-duration $scrollbar-fade-easing;
}

.scrollbar-horizontal--interactive .scrollbar-horizontal__thumb {
  pointer-events: auto;
}

.scrollbar-horizontal__thumb:hover {
  background: var(--workbench-scrollbar-thumb-hover);
}

.scrollbar-horizontal__thumb:active {
  background: var(--workbench-scrollbar-thumb-active);
}
</style>
