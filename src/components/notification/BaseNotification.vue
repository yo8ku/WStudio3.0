<!-- 文件说明：使用统一结构渲染普通、警告和错误三类应用通知。 -->
<script setup lang="ts">
import { computed } from 'vue';

const alertIcon = 'icon icon-circle-alert';
const closeIcon = 'icon icon-close';
const errorIcon = 'icon icon-error';
const warningIcon = 'icon icon-warning';
import type { ApplicationNotification } from './types';

const props = defineProps<{
  notification: ApplicationNotification;
}>();

const emit = defineEmits<{
  close: [];
}>();

const notificationConfig = computed(() => ({
  color: props.notification.type === 'error'
    ? 'error'
    : props.notification.type === 'warning'
      ? 'warning'
      : 'surface',
  timeout: props.notification.duration,
  location: 'top end' as const,
  variant: 'flat' as const
}));

const icon = computed(() => {
  if (props.notification.type === 'error') return errorIcon;
  if (props.notification.type === 'warning') return warningIcon;
  return alertIcon;
});

const closeButtonProps = {
  icon: true,
  size: 'small',
  variant: 'text'
} as const;

/** 处理 Snackbar 自动关闭或手动关闭。 */
function handleVisibilityChange(visible: boolean): void {
  if (!visible) emit('close');
}
</script>

<template>
  <v-snackbar
    :key="notification.id"
    v-bind="notificationConfig"
    class="application-notification rounded-0"
    :model-value="true"
    @update:model-value="handleVisibilityChange"
  >
    <section
      class="application-notification__content"
      :aria-label="notification.title || notification.source || '应用通知'"
    >
      <span
        aria-hidden="true"
        class="application-notification__icon"
        :class="icon"
      />
      <span class="application-notification__body">
        <strong v-if="notification.title || notification.source">
          {{ notification.title || notification.source }}
        </strong>
        <span>{{ notification.message }}</span>
      </span>
      <v-btn
        v-bind="closeButtonProps"
        aria-label="关闭通知"
        @click="emit('close')"
      >
        <span
          aria-hidden="true"
          class="application-notification__close-icon"
          :class="closeIcon"
        />
      </v-btn>
    </section>
  </v-snackbar>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/mixins' as *;
@use '@/assets/styles/variables' as *;

.application-notification {
  max-width: $notification-max-width;
  z-index: $notification-z-index;
}

.application-notification__content {
  @include flex-align-center;
  gap: $spacing-sm;
  width: 100%;
}

.application-notification__icon,
.application-notification__close-icon {
  display: block;
  flex: none;
  line-height: 1;
}

.application-notification__icon {
  width: $notification-icon-size;
  height: $notification-icon-size;
}

.application-notification__close-icon {
  width: $notification-close-icon-size;
  height: $notification-close-icon-size;
}

.application-notification__body {
  @include flex-column;
  flex: 1;
  min-width: 0;
  font-size: $font-size-sm;
  overflow-wrap: anywhere;
}

.application-notification__body strong {
  font-size: $font-size-xs;
}
</style>
