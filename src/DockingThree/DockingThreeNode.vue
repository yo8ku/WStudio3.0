<script setup lang="ts">
/**
 * 文件说明：递归渲染停靠布局树，并处理分割条拖拽调整尺寸�? */
import { computed, ref } from 'vue';

import DockingThreeGroup from '@/DockingThree/DockingThreeGroup.vue';
import DockingThreeSplitHandle from '@/DockingThree/DockingThreeSplitHandle.vue';
import type {
  DockingThreeNode as DockingThreeNodeShape,
  DockingThreeSplitNode
} from '@/DockingThree/types';
import { useDockingThreeStore } from '@/store/dockingThree';

defineOptions({
  name: 'DockingThreeNode'
});

const props = withDefaults(defineProps<{
  node: DockingThreeNodeShape;
  preview?: boolean;
  previewLayout?: boolean;
  topEdge?: boolean;
}>(), {
  preview: false,
  previewLayout: false,
  topEdge: true
});

const dockingThreeStore = useDockingThreeStore();
const activeHandleKey = ref<string>();

/**
 * 判断节点本身或其子树中是否仍有可见分组，用于过滤已收起区域�? */
function isRenderableNode(node: DockingThreeNodeShape): boolean {
  if (node.type === 'group') {
    return dockingThreeStore.isGroupVisible(node.id);
  }

  return node.children.some((child) => isRenderableNode(child));
}

/**
 * 基于当前分割节点计算实际可见子项及其尺寸�? */
const allChildren = computed(() => {
  if (props.node.type === 'group') {
    return [];
  }

  const split = props.node;

  return split.children
    .map((child, index) => ({
      child,
      index,
      size: split.sizes[index] ?? 1
    }));
});

const visibleChildren = computed(() => allChildren.value.filter((entry) => isRenderableNode(entry.child)));

function resolveVisibleIndex(childIndex: number): number {
  return visibleChildren.value.findIndex((entry) => entry.index === childIndex);
}

/**
 * 判断当前分割是否为根横向布局，用于锁定左右侧边栏宽度。
 */
const isRootHorizontalSplit = computed(() =>
  props.node.type === 'split' && props.node.id === 'dock-split-root' && props.node.axis === 'horizontal'
);

/**
 * 将分割权重转成子节点容器�?flex 样式�? */
function getChildStyle(size: number, childIndex: number) {
  // A split with a single visible branch must occupy the whole surface. The
  // persisted size array can still contain ratios for hidden/removed siblings;
  // reusing those values would leave an empty half of the sidebar.
  if (visibleChildren.value.length === 1) {
    return {
      flex: '1 1 0',
      minWidth: '0',
      minHeight: '0'
    };
  }

  if (isRootHorizontalSplit.value) {
    if (childIndex === 0 || childIndex === 2) {
      return {
        flex: `0 0 ${size}px`,
        minWidth: `${size}px`,
        minHeight: '0'
      };
    }

    return {
      flex: '1 1 0',
      minWidth: '0',
      minHeight: '0'
    };
  }

  return {
    flexBasis: '0px',
    flexGrow: String(size),
    minWidth: '0',
    minHeight: '0'
  };
}

/**
 * 生成当前分割条的唯一 key，便于记录激活态�? */
function getHandleKey(
  splitId: string,
  leftIndex: number,
  rightIndex: number
): string {
  return `${splitId}:${leftIndex}:${rightIndex}`;
}

/**
 * 判断指定分割条是否正在被拖拽调整�? */
function isActiveHandle(
  splitId: string,
  leftIndex: number,
  rightIndex: number
): boolean {
  return activeHandleKey.value === getHandleKey(splitId, leftIndex, rightIndex);
}

/**
 * 递归计算子节点是否仍贴着当前布局子树顶部。
 * 横向分割保持同一顶部上下文，纵向分割仅首个可见子项保留顶部标记。
 */
function resolveChildTopEdge(visibleIndex: number): boolean {
  if (props.node.type === 'group') {
    return props.topEdge;
  }

  if (props.node.axis === 'horizontal') {
    return props.topEdge;
  }

  return props.topEdge && visibleIndex === 0;
}

/**
 * 启动分割条拖拽，并把尺寸变化量交�?Store 统一更新�? */
function beginResize(
  event: PointerEvent,
  split: DockingThreeSplitNode,
  leftIndex: number,
  rightIndex: number
): void {
  if (props.preview) {
    return;
  }

  const element = event.currentTarget as HTMLElement | null;
  const container = element?.parentElement;

  if (!element || !container) {
    return;
  }

  const bounds = container.getBoundingClientRect();
  const itemElements = Array.from(container.children).filter((child): child is HTMLElement =>
    child instanceof HTMLElement && child.classList.contains('docking-three-split__item')
  );
  const totalSize = split.axis === 'horizontal' ? bounds.width : bounds.height;
  const handleBounds = element.getBoundingClientRect();
  const startPointer = split.axis === 'horizontal'
    ? handleBounds.left + (handleBounds.width / 2)
    : handleBounds.top + (handleBounds.height / 2);
  const baselineLeftSize = split.sizes[leftIndex] ?? 1;
  const baselineRightSize = split.sizes[rightIndex] ?? 1;
  const visibleGrowTotal = visibleChildren.value.reduce((sum, entry) => sum + entry.size, 0);
  const visiblePixelTotal = itemElements.reduce((sum, itemElement) => {
    const itemBounds = itemElement.getBoundingClientRect();

    return sum + (split.axis === 'horizontal' ? itemBounds.width : itemBounds.height);
  }, 0);

  if (totalSize <= 0 || visibleGrowTotal <= 0 || visiblePixelTotal <= 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  element.setPointerCapture(event.pointerId);
  activeHandleKey.value = getHandleKey(split.id, leftIndex, rightIndex);

  const handlePointerMove = (moveEvent: PointerEvent) => {
    const nextPointer = split.axis === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
    const deltaPixels = nextPointer - startPointer;
    const deltaRatio = (deltaPixels * visibleGrowTotal) / visiblePixelTotal;
    dockingThreeStore.resizeSplitPair(
      split.id,
      leftIndex,
      rightIndex,
      deltaRatio,
      baselineLeftSize,
      baselineRightSize
    );
  };

  const finishResize = () => {
    activeHandleKey.value = undefined;
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('pointerup', handlePointerUp, true);
    document.removeEventListener('pointercancel', finishResize, true);
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  };

  const handlePointerUp = () => finishResize();

  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('pointercancel', finishResize, true);
}
</script>

<template>
  <DockingThreeGroup
    v-if="node.type === 'group'"
    :group="node"
    :preview="preview"
    :preview-layout="previewLayout"
    :top-edge="topEdge"
  />

  <div
    v-else
    class="docking-three-split"
    :class="{
      'docking-three-split--horizontal': node.axis === 'horizontal',
      'docking-three-split--vertical': node.axis === 'vertical',
      'docking-three-split--preview': preview
    }"
  >
    <!-- Render only visible branches. Using v-show here leaves hidden sidebar
         contexts in the flex layout and can reserve an empty half of the lane. -->
    <template v-for="entry in visibleChildren" :key="entry.child.id">
      <div
        class="docking-three-split__item"
        :class="{
          sideBar: entry.child.id === 'left-sidebar-lane' || entry.child.id === 'right-sidebar-lane',
          'sideBar--left': entry.child.id === 'left-sidebar-lane',
          'sideBar--right': entry.child.id === 'right-sidebar-lane'
        }"
        :style="getChildStyle(entry.size, entry.index)"
      >
        <DockingThreeNode
          :node="entry.child"
          :preview="preview"
          :preview-layout="previewLayout"
          :top-edge="resolveChildTopEdge(Math.max(0, resolveVisibleIndex(entry.index)))"
        />
      </div>

      <DockingThreeSplitHandle
        v-if="!preview
          && resolveVisibleIndex(entry.index) >= 0
          && resolveVisibleIndex(entry.index) < visibleChildren.length - 1"
        :axis="node.axis"
        :active="isActiveHandle(
          node.id,
          entry.index,
          visibleChildren[resolveVisibleIndex(entry.index) + 1]!.index
        )"
        :disabled="dockingThreeStore.isDragging"
        @pointerdown="beginResize(
          $event,
          node,
          entry.index,
          visibleChildren[resolveVisibleIndex(entry.index) + 1]!.index
        )"
      />
    </template>
  </div>
</template>

<style lang="scss" scoped>
.docking-three-split {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: transparent;
}

.docking-three-split--horizontal {
  flex-direction: row;
}

.docking-three-split--vertical {
  flex-direction: column;
}

.docking-three-split--preview {
  background: transparent;
}

.docking-three-split__item {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

//手柄背景色
</style>
