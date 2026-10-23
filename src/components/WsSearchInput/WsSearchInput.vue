<!-- 文件说明：封装可复用的搜索输入框，统一输入样式并开放左右内部插槽。 -->
<script setup lang="ts">
import { computed, useAttrs } from 'vue';

import WsInput from '@/components/WsInput/WsInput.vue';

/** 通用搜索输入框的常用交互属性。其他 Vuetify 属性通过 attrs 透传。 */
interface WsSearchInputProps {
  autofocus?: boolean;
  clearable?: boolean;
  disabled?: boolean;
  loading?: boolean | string;
  placeholder?: string;
  readonly?: boolean;
}

const props = withDefaults(defineProps<WsSearchInputProps>(), {
  autofocus: false,
  clearable: false,
  disabled: false,
  loading: false,
  readonly: false
});

const modelValue = defineModel<string>({ default: '' });

defineOptions({ inheritAttrs: false });

const attrs = useAttrs();
const defaultSearchInputProps = {
  singleLine: true,
  type: 'search'
} as const;

/** 合并基础搜索配置与调用方传入的 Vuetify 属性。 */
const resolvedSearchInputProps = computed(() => ({
  ...defaultSearchInputProps,
  ...attrs,
  autofocus: props.autofocus,
  clearable: props.clearable,
  disabled: props.disabled,
  loading: props.loading,
  placeholder: props.placeholder,
  readonly: props.readonly
}));
</script>

<template>
  <WsInput
    v-bind="resolvedSearchInputProps"
    v-model="modelValue"
    class="ws-search-input"
  >
    <template v-if="$slots['prepend-inner']" #prepend-inner="slotProps">
      <slot name="prepend-inner" v-bind="slotProps" />
    </template>

    <template v-if="$slots['append-inner']" #append-inner="slotProps">
      <slot name="append-inner" v-bind="slotProps" />
    </template>
  </WsInput>
</template>

<style lang="scss" scoped>
.ws-search-input {
  width: 100%;
}
</style>
