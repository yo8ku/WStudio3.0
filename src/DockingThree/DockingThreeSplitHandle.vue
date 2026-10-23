<script setup lang="ts">
/**
 * 文件说明：统一承载 DockingThree 分割手柄的命中区、视觉状态和轴向样式。
 */
import { computed } from 'vue';

import type { DockingThreeAxis } from '@/DockingThree/types';

defineOptions({
  name: 'DockingThreeSplitHandle'
});

const props = withDefaults(defineProps<{
  axis: DockingThreeAxis;
  active?: boolean;
  disabled?: boolean;
}>(), {
  active: false,
  disabled: false
});

const emit = defineEmits<{
  pointerdown: [event: PointerEvent];
}>();

const handleClasses = computed(() => ({
  'docking-three-split__handle--horizontal': props.axis === 'horizontal',
  'docking-three-split__handle--vertical': props.axis === 'vertical',
  'docking-three-split__handle--active': props.active,
  'docking-three-split__handle--disabled': props.disabled
}));
</script>

<template>
  <div
    class="docking-three-split__handle"
    :class="handleClasses"
    @pointerdown="emit('pointerdown', $event)"
  />
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.docking-three-split__handle {
  position: relative;
  flex: 0 0 0;
  background: transparent;
  overflow: visible;
  z-index: 3;
  touch-action: none;

  &::before {
    content: '';
    position: absolute;
    z-index: 1;
    background: var(--ws-border);
    opacity: 1;
    transition:
      opacity $docking-splitter-hover-duration ease,
      width $docking-splitter-hover-duration ease,
      height $docking-splitter-hover-duration ease,
      background $docking-splitter-hover-duration ease;
    transition-delay: 0s, 0s, 0s, 0s;
  }

  &::after {
    content: '';
    position: absolute;
    z-index: 0;
    background: transparent;
  }

  &--active::before {
    background: var(--ws-sash-activeBorder);
  }

  &--horizontal {
    width: 0;
    cursor: e-resize;

    &::before {
      top: 0;
      bottom: 0;
      left: 0;
      width: $docking-splitter-size;
      // 视觉线居中，4px 悬停宽度只向网页一侧延伸 2px。
      transform: translateX(-50%);
    }

    &::after {
      top: 0;
      bottom: 0;
      left: 0;
      width: $docking-splitter-hit-size;
      // 命中区也居中，网页另一侧保留完整的拖拽入口。
      transform: translateX(-50%);
    }

    &:hover::before {
      width: $docking-splitter-active-size;
      transition-delay:
        $docking-splitter-hover-delay,
        $docking-splitter-hover-delay,
        0s,
        $docking-splitter-hover-delay;
      background: var(--ws-sash-hoverBorder);
    }

    &.docking-three-split__handle--active::before {
      width: $docking-splitter-active-size;
      transition-delay: 0s, 0s, 0s, 0s;
      background: var(--ws-sash-activeBorder);
    }
  }

  &--vertical {
    height: 0;
    cursor: n-resize;

    &::before {
      top: 0;
      right: 0;
      left: 0;
      height: $docking-splitter-size;
      transform: none;
    }

    &::after {
      top: 50%;
      right: 0;
      left: 0;
      height: $docking-splitter-hit-size;
      transform: translateY(-50%);
    }

    &:hover::before {
      height: $docking-splitter-active-size;
      transition-delay:
        $docking-splitter-hover-delay,
        0s,
        $docking-splitter-hover-delay,
        $docking-splitter-hover-delay;
      background: var(--ws-sash-hoverBorder);
    }

    &.docking-three-split__handle--active::before {
      height: $docking-splitter-active-size;
      transition-delay: 0s, 0s, 0s, 0s;
      background: var(--ws-sash-activeBorder);
    }
  }

  &--disabled {
    pointer-events: none;

    &::before {
      transition-delay: 0s;
    }
  }
}
</style>
