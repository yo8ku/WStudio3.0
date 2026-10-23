<!--
  文件说明：提供标签页重命名弹窗，负责输入名称并提交或取消重命名操作。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import WsInput from '@/components/WsInput/WsInput.vue';
import WorkbenchDialog from '@/components/workbench/WorkbenchDialog.vue';

interface RenameTabDialogProps {
  modelValue: boolean;
  initialName: string;
}

const props = defineProps<RenameTabDialogProps>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  save: [name: string];
}>();

const draftName = ref(props.initialName);
const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});
const canSave = computed(() => draftName.value.trim().length > 0);
const fieldProps = {
  density: 'compact',
  hideDetails: true,
  variant: 'outlined'
} as const;
const actionButtonProps = {
  variant: 'text'
} as const;
const saveButtonProps = {
  color: 'primary',
  variant: 'text'
} as const;

/** 打开弹窗时同步当前标签名称并选中输入内容。 */
watch(
  () => [props.modelValue, props.initialName] as const,
  ([visible, initialName]) => {
    if (visible) {
      draftName.value = initialName;
    }
  },
  { immediate: true }
);

/** 提交非空标签名称。 */
function handleSave(): void {
  const name = draftName.value.trim();
  if (!name) {
    return;
  }

  emit('save', name);
  emit('update:modelValue', false);
}

/** 关闭弹窗且不修改标签名称。 */
function handleCancel(): void {
  emit('update:modelValue', false);
}
</script>

<template>
  <WorkbenchDialog v-model="isOpen" title="重命名标签页" persistent>
    <WsInput
      v-model="draftName"
      v-bind="fieldProps"
      autofocus
      @keyup.enter="handleSave"
    />

    <template #actions>
      <v-spacer />
      <v-btn v-bind="actionButtonProps" @click="handleCancel">取消</v-btn>
      <v-btn v-bind="saveButtonProps" :disabled="!canSave" @click="handleSave">保存</v-btn>
    </template>
  </WorkbenchDialog>
</template>
