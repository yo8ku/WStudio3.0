<!-- 组合 WStudio 主工作台和全局应用级通知出口。 -->
<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import { getWindowMode } from '@/utils/windowMode';
import { loadWindowView } from './views/windowView';

const WindowView = defineAsyncComponent(loadWindowView);
const NotificationHost = defineAsyncComponent(() => import('@/components/notification/NotificationHost.vue'));
const PluginDialogHost = defineAsyncComponent(() => import('@/components/workbench/PluginDialogHost.vue'));

const isBlankWindow = getWindowMode() === 'blank';
</script>

<template>
  <template v-if="isBlankWindow">
    <WindowView />
  </template>
  <template v-else>
    <WindowView />
    <NotificationHost />
    <PluginDialogHost />
  </template>
</template>
