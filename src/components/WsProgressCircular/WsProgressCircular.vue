<script setup lang="ts">
/**
 * 文件说明：封装 Vuetify 环状进度组件，统一加载状态的尺寸、粗细与无障碍标签。
 */
interface WsProgressCircularProps {
  color?: string;
  indeterminate?: boolean;
  size?: number | string;
  width?: number | string;
  ariaLabel?: string;
}

const props = withDefaults(defineProps<WsProgressCircularProps>(), {
  indeterminate: true,
  size: 16,
  width: 2,
  ariaLabel: '加载中'
});

</script>

<template>
  <v-progress-circular
    class="ws-progress-circular"
    :aria-label="props.ariaLabel"
    :color="props.color"
    :indeterminate="props.indeterminate"
    :size="props.size"
    :width="props.width"
  />
</template>

<style lang="scss" scoped>
.ws-progress-circular {
  display: block;
  flex: 0 0 auto;
}
</style>
