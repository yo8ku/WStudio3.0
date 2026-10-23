<!-- 文件说明：挂载全局通知出口并顺序消费 Pinia 通知队列。 -->
<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { storeToRefs } from 'pinia';

import BaseNotification from './BaseNotification.vue';
import { useNotificationStore } from '@/store/notification';

const notificationStore = useNotificationStore();
const { current } = storeToRefs(notificationStore);

/** 移除当前已关闭通知。 */
function dismissCurrent(): void {
  if (current.value) notificationStore.dismiss(current.value.id);
}

onMounted(() => notificationStore.initialize());
onBeforeUnmount(() => notificationStore.dispose());
</script>

<template>
  <!-- S = 应用通知 -->
  <BaseNotification
    v-if="current"
    :notification="current"
    @close="dismissCurrent"
  />
  <!-- E = 应用通知 -->
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;
</style>
