<!-- 文件说明：渲染工作区图片、视频和音频文件的安全媒体预览面板。 -->
<script setup lang="ts">
/**
 * 文件说明：将主进程验证后的媒体路径转换为受控协议地址，并选择对应媒体元素。
 */
import { computed } from 'vue';

import { resolveMediaSourceUrl } from '@/api/media';

const props = defineProps<{
  filePath: string;
  title: string;
  mediaMimeType: string;
}>();

const mediaSource = computed(() => resolveMediaSourceUrl(props.filePath));
const mediaKind = computed(() => props.mediaMimeType.split('/')[0]);

const mediaProps = {
  controls: true,
  preload: 'metadata'
} as const;
const panelProps = {
  color: 'transparent',
  elevation: 0
} as const;
const unsupportedAlertProps = {
  type: 'warning',
  variant: 'tonal'
} as const;
</script>

<template>
  <v-sheet
    class="docking-three-media-panel"
    v-bind="panelProps"
  >
    <img
      v-if="mediaKind === 'image'"
      class="docking-three-media-panel__image"
      :src="mediaSource"
      :alt="title"
    />
    <video
      v-else-if="mediaKind === 'video'"
      class="docking-three-media-panel__video"
      v-bind="mediaProps"
      :src="mediaSource"
    />
    <audio
      v-else-if="mediaKind === 'audio'"
      class="docking-three-media-panel__audio"
      v-bind="mediaProps"
      :src="mediaSource"
    />
    <v-alert
      v-else
      v-bind="unsupportedAlertProps"
      title="不支持的媒体类型"
    />
  </v-sheet>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.docking-three-media-panel {
  @include flex-center;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: $spacing-lg;
  overflow: auto;
  background: var(--ws-editor-background);
}

.docking-three-media-panel__image,
.docking-three-media-panel__video {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.docking-three-media-panel__audio {
  width: min(100%, 32rem);
}
</style>
