<script setup lang="ts">
/**
 * 文件说明：提供 Markdown 表格行列尺寸选择面板，并按指针位置动态扩展可选网格。
 */
import { computed, onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue';

interface TableSizeSelection {
  readonly rows: number;
  readonly columns: number;
}

interface TableSizeCell extends TableSizeSelection {
  readonly id: string;
}

const emit = defineEmits<{
  select: [selection: TableSizeSelection];
}>();

const DEFAULT_GRID_SIZE = 4;
const MAX_GRID_SIZE = 10;
const selectedRows = ref(1);
const selectedColumns = ref(1);
const visibleRows = ref(DEFAULT_GRID_SIZE);
const visibleColumns = ref(DEFAULT_GRID_SIZE);
const isSelecting = ref(false);
const gridStyle = computed<CSSProperties>(() => ({
  '--editor-table-picker-columns': visibleColumns.value
}));
const cells = computed<readonly TableSizeCell[]>(() => Array.from(
  { length: visibleRows.value * visibleColumns.value },
  (_, index) => {
    const row = Math.floor(index / visibleColumns.value) + 1;
    const column = (index % visibleColumns.value) + 1;
    return { id: `${row}-${column}`, rows: row, columns: column };
  }
));

/** 判断网格单元是否位于当前选择范围内。 */
function isSelected(cell: TableSizeCell): boolean {
  return cell.rows <= selectedRows.value && cell.columns <= selectedColumns.value;
}

/** 根据当前指针位置更新选择范围，并在触及边缘时扩展网格。 */
function updateSelection(cell: TableSizeCell): void {
  selectedRows.value = cell.rows;
  selectedColumns.value = cell.columns;
  if (cell.rows === visibleRows.value && visibleRows.value < MAX_GRID_SIZE) {
    visibleRows.value += 1;
  }
  if (cell.columns === visibleColumns.value && visibleColumns.value < MAX_GRID_SIZE) {
    visibleColumns.value += 1;
  }
}

/** 开始指针拖选并记录起始尺寸。 */
function startSelection(cell: TableSizeCell, event: PointerEvent): void {
  event.preventDefault();
  isSelecting.value = true;
  updateSelection(cell);
}

/** 在指针松开时提交最终行列选择。 */
function finishSelection(cell: TableSizeCell): void {
  if (!isSelecting.value) {
    return;
  }
  isSelecting.value = false;
  updateSelection(cell);
  emit('select', { rows: cell.rows, columns: cell.columns });
}

/** 通过键盘触发的原生点击提交当前尺寸。 */
function selectTableSizeByKeyboard(cell: TableSizeCell, event: MouseEvent): void {
  if (event.detail === 0) {
    emit('select', { rows: cell.rows, columns: cell.columns });
  }
}

/** 在面板外松开指针时取消未完成的拖选。 */
function cancelSelection(): void {
  isSelecting.value = false;
}

onMounted(() => window.addEventListener('pointerup', cancelSelection));
onBeforeUnmount(() => window.removeEventListener('pointerup', cancelSelection));
</script>

<template>
  <section class="table-size-picker" aria-label="选择表格尺寸">
    <div
      class="table-size-picker__grid"
      :style="gridStyle"
    >
      <button
        v-for="cell in cells"
        :key="cell.id"
        :aria-label="`${cell.rows} 行 ${cell.columns} 列`"
        class="table-size-picker__cell"
        :class="{ 'table-size-picker__cell--selected': isSelected(cell) }"
        type="button"
        @click="selectTableSizeByKeyboard(cell, $event)"
        @focus="updateSelection(cell)"
        @pointerdown="startSelection(cell, $event)"
        @pointerenter="updateSelection(cell)"
        @pointerup="finishSelection(cell)"
      />
    </div>
    <output class="table-size-picker__size">{{ selectedColumns }} x {{ selectedRows }}</output>
  </section>
</template>

<style lang="scss" scoped>
@use '../../src/assets/styles/variables' as variables;

.table-size-picker {
  display: grid;
  gap: variables.$spacing-2xs;
  width: fit-content;
  padding: variables.$spacing-2xs;
  border: variables.$editor-table-border-width solid var(--ws-editor-tableBorder);
  border-radius: variables.$radius-xs;
  color: var(--ws-foreground);
  background: var(--ws-menu-background);
}

.table-size-picker__grid {
  display: grid;
  grid-template-columns: repeat(var(--editor-table-picker-columns), variables.$editor-table-picker-cell-size);
  gap: variables.$editor-table-picker-cell-gap;
}

.table-size-picker__cell {
  width: variables.$editor-table-picker-cell-size;
  height: variables.$editor-table-picker-cell-size;
  padding: 0;
  border: variables.$editor-table-border-width solid var(--ws-editor-tableBorder);
  border-radius: variables.$radius-2px;
  background: transparent;
  cursor: pointer;
}

.table-size-picker__cell--selected {
  border-color: var(--ws-focusBorder);
  background: var(--ws-button-hoverBackground);
}

.table-size-picker__size {
  min-height: variables.$editor-context-menu-item-height;
  font-size: variables.$font-editor-context-menu-font-size;
  line-height: variables.$editor-context-menu-item-height;
  text-align: center;
}
</style>
