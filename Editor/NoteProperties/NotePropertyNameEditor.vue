<script setup lang="ts">
/**
 * 文件说明：提供笔记属性名称的双击编辑、校验、保存和取消交互。
 */
import { nextTick, ref } from 'vue';

import {
  isValidNotePropertyName,
  normalizeNotePropertyName
} from '@editor/NoteProperties/notePropertyDefinitions';

/** 属性名称编辑器需要的当前名称和同级名称集合。 */
interface NotePropertyNameEditorProps {
  modelValue: string;
  existingNames: readonly string[];
}

const props = defineProps<NotePropertyNameEditorProps>();
const emit = defineEmits<{
  cancel: [];
  save: [value: string];
}>();

const editing = ref(false);
const draft = ref('');
const inputHandle = ref<{ focus: () => void }>();

const inputProps = {
  density: 'compact',
  hideDetails: true,
  singleLine: true,
  variant: 'plain'
} as const;

/** 判断当前草稿是否可以保存为属性名称。 */
function isDraftValid(): boolean {
  const nextName = normalizeNotePropertyName(draft.value);
  return isValidNotePropertyName(nextName)
    && !props.existingNames.some(name => name !== props.modelValue && name === nextName);
}

/** 双击属性名称后进入编辑状态并将光标置于输入框。 */
async function beginEditing(): Promise<void> {
  if (editing.value) {
    return;
  }

  editing.value = true;
  draft.value = props.modelValue;
  await nextTick();
  inputHandle.value?.focus();
}

/** 收集 Vuetify 输入组件的最小聚焦句柄。 */
function setInputHandle(instance: unknown): void {
  if (
    instance
    && typeof instance === 'object'
    && 'focus' in instance
    && typeof instance.focus === 'function'
  ) {
    inputHandle.value = instance as { focus: () => void };
    return;
  }

  inputHandle.value = undefined;
}

/** 保存合法属性名称；非法或重复名称保持编辑状态并等待修正。 */
function commitEditing(): void {
  if (!isDraftValid()) {
    inputHandle.value?.focus();
    return;
  }

  const nextName = normalizeNotePropertyName(draft.value);
  editing.value = false;
  emit('save', nextName);
}

/** 取消当前属性名称编辑并恢复原名称。 */
function cancelEditing(): void {
  editing.value = false;
  draft.value = '';
  emit('cancel');
}

/** 处理名称编辑框键盘提交和取消。 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    commitEditing();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelEditing();
  }
}

/** 输入框失焦时保存合法名称，非法名称恢复原值。 */
function handleFocusUpdate(focused: boolean): void {
  if (!focused && editing.value) {
    if (isDraftValid()) {
      commitEditing();
    } else {
      cancelEditing();
    }
  }
}
</script>

<template>
  <v-text-field
    v-if="editing"
    :ref="setInputHandle"
    v-model="draft"
    v-bind="inputProps"
    class="note-property-name-editor__input"
    :aria-label="`${props.modelValue} 属性名称`"
    @keydown="handleKeydown"
    @update:focused="handleFocusUpdate"
  />
  <span
    v-else
    class="note-property-name-editor__label"
    @dblclick.stop.prevent="beginEditing"
  >{{ props.modelValue }}</span>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.note-property-name-editor__label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  height: $note-properties-value-height;
  margin-inline-start: $note-properties-chip-gap;
  font-size: $note-properties-content-font-size;
  line-height: $note-properties-value-height;
  overflow-wrap: anywhere;
  cursor: text;
}

.note-property-name-editor__input {
  min-width: 0;
  height: $note-properties-value-height;
  margin-inline-start: $note-properties-chip-gap;
}

.note-property-name-editor__input :deep(.v-input__control),
.note-property-name-editor__input :deep(.v-field),
.note-property-name-editor__input :deep(.v-field__field) {
  height: $note-properties-value-height;
  min-height: $note-properties-value-height;
}

.note-property-name-editor__input :deep(.v-field__input) {
  min-height: $note-properties-value-height;
  padding: 0;
  font-size: $note-properties-content-font-size;
  line-height: $note-properties-value-height;
}

.note-property-name-editor__input :deep(.v-field__overlay) {
  display: none;
}
</style>
