<!--
  文件说明：在可信工作台窗口中渲染插件声明式列表、输入和确认对话框。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';

import WsInput from '@/components/WsInput/WsInput.vue';
import WorkbenchDialog from '@/components/workbench/WorkbenchDialog.vue';
import WorkbenchListPickerDialog from '@/components/workbench/WorkbenchListPickerDialog.vue';
import { useDialogStore } from '@/store/dialog';

const dialogStore = useDialogStore();
const { current, submitting, error } = storeToRefs(dialogStore);
const promptValue = ref('');

const currentPick = computed(() => current.value?.kind === 'pick' ? current.value : undefined);
const currentPrompt = computed(() => current.value?.kind === 'prompt' ? current.value : undefined);
const currentConfirm = computed(() => current.value?.kind === 'confirm' ? current.value : undefined);

const promptProps = {
  density: 'compact',
  hideDetails: true,
  variant: 'outlined'
} as const;
const cancelButtonProps = { variant: 'text' } as const;

/** 在宿主组件挂载时开始接收请求，并在销毁时释放订阅。 */
dialogStore.start();

watch(currentPrompt, request => {
  promptValue.value = request?.options.value ?? '';
});

/** 返回当前列表选择项。 */
function confirmPick(itemId: string): void {
  void dialogStore.respond({ requestId: currentPick.value?.requestId ?? '', status: 'confirmed', value: itemId });
}

/** 返回当前文本输入值。 */
function confirmPrompt(): void {
  if (!currentPrompt.value) return;
  void dialogStore.respond({ requestId: currentPrompt.value.requestId, status: 'confirmed', value: promptValue.value });
}

/** 返回当前确认结果。 */
function confirmAction(): void {
  if (!currentConfirm.value) return;
  void dialogStore.respond({ requestId: currentConfirm.value.requestId, status: 'confirmed', value: true });
}

/** 处理通用窗口 Escape。 */
function cancelAction(): void {
  void dialogStore.cancelCurrent();
}

/** 让视图卸载时释放 IPC 订阅。 */
function handleUnmount(): void {
  dialogStore.stop();
}

onBeforeUnmount(handleUnmount);
</script>

<template>
  <template v-if="currentPick">
    <!-- S = 插件列表选择窗口 -->
    <WorkbenchListPickerDialog
      :model-value="true"
      :title="currentPick.options.title"
      :subtitle="currentPick.options.subtitle"
      :items="currentPick.options.items"
      :current-item-id="currentPick.options.currentItemId"
      :searchable="currentPick.options.searchable"
      :search-placeholder="currentPick.options.searchPlaceholder"
      :confirm-label="currentPick.options.confirmLabel"
      :pending="submitting"
      :error="error"
      @confirm="confirmPick"
      @update:model-value="value => !value && cancelAction()"
    />
    <!-- E = 插件列表选择窗口 -->
  </template>

  <template v-else-if="currentPrompt">
    <!-- S = 插件文本输入窗口 -->
    <WorkbenchDialog
      :model-value="true"
      :title="currentPrompt.options.title"
      :subtitle="currentPrompt.options.subtitle"
      persistent
      @keydown="event => event.key === 'Escape' && cancelAction()"
      @update:model-value="value => !value && cancelAction()"
    >
      <WsInput
        v-model="promptValue"
        v-bind="promptProps"
        :placeholder="currentPrompt.options.placeholder"
        :maxlength="200"
        autofocus
        @keydown.enter.prevent="confirmPrompt"
      />
      <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      <template #actions>
        <v-spacer />
        <v-btn v-bind="cancelButtonProps" :disabled="submitting" @click="cancelAction">取消</v-btn>
        <v-btn color="primary" variant="text" :loading="submitting" @click="confirmPrompt">
          {{ currentPrompt.options.confirmLabel ?? '确定' }}
        </v-btn>
      </template>
    </WorkbenchDialog>
    <!-- E = 插件文本输入窗口 -->
  </template>

  <template v-else-if="currentConfirm">
    <!-- S = 插件确认窗口 -->
    <WorkbenchDialog
      :model-value="true"
      :title="currentConfirm.options.title"
      persistent
      @keydown="event => event.key === 'Escape' && cancelAction()"
      @update:model-value="value => !value && cancelAction()"
    >
      <p class="plugin-dialog-host__message">{{ currentConfirm.options.message }}</p>
      <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      <template #actions>
        <v-spacer />
        <v-btn v-bind="cancelButtonProps" :disabled="submitting" @click="cancelAction">取消</v-btn>
        <v-btn
          :color="currentConfirm.options.destructive ? 'error' : 'primary'"
          variant="text"
          :loading="submitting"
          @click="confirmAction"
        >{{ currentConfirm.options.confirmLabel ?? '确定' }}</v-btn>
      </template>
    </WorkbenchDialog>
    <!-- E = 插件确认窗口 -->
  </template>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.plugin-dialog-host__message {
  margin: 0;
  color: var(--ws-foreground);
  line-height: $workbench-dialog-line-height;
}
</style>
