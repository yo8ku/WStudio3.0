<!-- 文件说明：统一承载编辑器右键菜单及其子菜单的 Vuetify 浮层配置。 -->
<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: boolean;
  contentClass?: string;
  target?: [number, number];
  submenu?: boolean;
  closeOnContentClick?: boolean;
}>(), {
  closeOnContentClick: true,
  submenu: false,
  target: undefined
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});

const menuProps = computed(() => props.submenu
  ? {
      closeDelay: 120,
      closeOnContentClick: props.closeOnContentClick,
      openDelay: 0,
      openOnHover: true,
      submenu: true,
      transition: false
    } as const
  : {
      closeOnContentClick: props.closeOnContentClick,
      locationStrategy: 'connected',
      location: 'bottom start',
      openOnClick: false,
      origin: 'top left',
      scrim: false,
      transition: false
    } as const);
</script>

<template>
  <v-menu
    v-model="visible"
    v-bind="menuProps"
    :content-class="['ws-menu', contentClass].filter(Boolean).join(' ')"
    :target="props.submenu ? undefined : target"
  >
    <template v-if="$slots.activator" #activator="{ props: activatorProps }">
      <slot name="activator" :props="activatorProps" />
    </template>
    <slot />
  </v-menu>
</template>
