<script setup lang="ts">
/**
 * 文件说明：提供不依赖组件库的应用内消息提示，负责位置、计时、悬停暂停和手动关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const closeIcon = 'icon icon-close';
const errorIcon = 'icon icon-msg-circle-close';
const infoIcon = 'icon icon-msg-circle-info';
const successIcon = 'icon icon-msg-circle-check';
const warningIcon = 'icon icon-warning';
import type { MessageLocation, MessageType } from './types';

interface MessageProps {
  modelValue: boolean;
  message: string;
  showIcon?: boolean;
  icon?: string;
  iconLabel?: string;
  location?: MessageLocation;
  type?: MessageType;
  closable?: boolean;
  duration?: number;
  multiLine?: boolean;
}

const props = withDefaults(defineProps<MessageProps>(), {
  showIcon: true,
  icon: undefined,
  iconLabel: '消息图标',
  location: 'top',
  type: 'info',
  closable: false,
  duration: 4_000,
  multiLine: false
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

defineOptions({ inheritAttrs: false });

const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});
const isHovered = ref(false);
const remainingDuration = ref(0);
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let timerStartedAt = 0;

const hostClasses = computed(() => [
  'ws-message-host',
  `ws-message-host--${props.location}`
]);
const messageClasses = computed(() => [
  'ws-message',
  `ws-message--${props.type}`,
  { 'ws-message--multi-line': props.multiLine }
]);
const resolvedIcon = computed(() => {
  if (!props.showIcon) {
    return undefined;
  }

  if (props.icon) {
    return props.icon;
  }

  switch (props.type) {
    case 'error':
      return errorIcon;
    case 'success':
      return successIcon;
    case 'warning':
      return warningIcon;
    case 'info':
    case 'normal':
    default:
      return infoIcon;
  }
});
const resolvedIconLabel = computed(() => {
  if (props.icon) {
    return props.iconLabel;
  }

  switch (props.type) {
    case 'error':
      return '错误消息';
    case 'success':
      return '成功消息';
    case 'warning':
      return '警告消息';
    case 'info':
    case 'normal':
    default:
      return '信息消息';
  }
});

/** 清除当前自动关闭计时器。 */
function clearCloseTimer(): void {
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

/** 从当前剩余时间开始自动关闭消息。duration <= 0 表示常驻。 */
function startCloseTimer(duration = remainingDuration.value): void {
  clearCloseTimer();
  if (!props.modelValue || duration <= 0) {
    return;
  }

  remainingDuration.value = duration;
  timerStartedAt = Date.now();
  closeTimer = setTimeout(() => {
    remainingDuration.value = 0;
    closeTimer = undefined;
    isOpen.value = false;
  }, duration);
}

/** 显示消息时重置持续时间，重新打开同一消息也会重新计时。 */
function resetCloseTimer(): void {
  remainingDuration.value = props.duration;
  startCloseTimer(props.duration);
}

/** 悬停时暂停计时，避免用户查看消息时消息自动消失。 */
function pauseCloseTimer(): void {
  if (isHovered.value || closeTimer === undefined) {
    return;
  }

  isHovered.value = true;
  remainingDuration.value = Math.max(
    0,
    remainingDuration.value - (Date.now() - timerStartedAt)
  );
  clearCloseTimer();
}

/** 离开消息后继续使用暂停前的剩余时间。 */
function resumeCloseTimer(): void {
  if (!isHovered.value) {
    return;
  }

  isHovered.value = false;
  startCloseTimer();
}

/** 手动关闭消息并同步外部 v-model。 */
function closeMessage(): void {
  clearCloseTimer();
  isOpen.value = false;
}

watch(
  () => props.modelValue,
  visible => {
    if (visible) {
      resetCloseTimer();
      return;
    }

    clearCloseTimer();
    isHovered.value = false;
  }
);

watch(() => props.duration, () => {
  if (props.modelValue && !isHovered.value) {
    resetCloseTimer();
  }
});

onMounted(() => {
  if (props.modelValue) {
    resetCloseTimer();
  }
});

onBeforeUnmount(() => {
  clearCloseTimer();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      v-bind="$attrs"
      :class="hostClasses"
      aria-live="polite"
    >
      <article
        :class="messageClasses"
        :role="props.type === 'error' ? 'alert' : 'status'"
        @pointerenter="pauseCloseTimer"
        @pointerleave="resumeCloseTimer"
      >
        <span
          v-if="resolvedIcon"
          :aria-label="resolvedIconLabel"
          class="ws-message__icon"
          role="img"
          :class="resolvedIcon"
        />
        <p class="ws-message__text">{{ props.message }}</p>
        <button
          v-if="props.closable"
          aria-label="关闭消息"
          class="ws-message__close"
          type="button"
          @click="closeMessage"
        >
          <span
            aria-hidden="true"
            class="ws-message__close-icon"
            :class="closeIcon"
          />
        </button>
      </article>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.ws-message-host {
  position: fixed;
  inset: 0;
  z-index: $notification-z-index;
  display: flex;
  padding: $spacing-sm;
  pointer-events: none;
}

.ws-message-host--top,
.ws-message-host--top-left,
.ws-message-host--top-right {
  align-items: flex-start;
}

.ws-message-host--bottom,
.ws-message-host--bottom-left,
.ws-message-host--bottom-right {
  align-items: flex-end;
}

.ws-message-host--top,
.ws-message-host--bottom {
  justify-content: center;
}

.ws-message-host--top-left,
.ws-message-host--bottom-left {
  justify-content: flex-start;
}

.ws-message-host--top-right,
.ws-message-host--bottom-right {
  justify-content: flex-end;
}

.ws-message {
  display: flex;
  align-items: center;
  gap: $spacing-sm;
  width: fit-content;
  max-width: min($notification-max-width, calc(100vw - #{$spacing-lg}));
  min-height: 1rem;
  padding:$spacing-2xs $spacing-sm;
  border: $input-border-width solid var(--ws-message-border, transparent);
  border-radius: $radius-xs;
  color: var(--ws-message-foreground, var(--ws-foreground));
  background: var(--ws-message-background, var(--ws-backgroundAccent));
  box-shadow: 0 $spacing-2xs $spacing-sm rgb(0 0 0 / 0.18);
  line-height: 1.4;
  font-size: 0.8rem;
  pointer-events: auto;
}

.ws-message--multi-line {
  align-items: flex-start;
}

.ws-message__icon {
  display: block;
  flex: 0 0 auto;
  width: $icon-size-width;
  height: $icon-size-height;
  color: inherit;
  font-size: $notification-icon-size;
  line-height: 1;
}

.ws-message__close-icon {
  display: block;
  width: 100%;
  height: 100%;
  line-height: 1;
}

.ws-message--info .ws-message__icon,
.ws-message--normal .ws-message__icon {
  color: var(--ws-message-infoForeground,#458edb);
}

.ws-message--success .ws-message__icon {
  color: var(--ws-message-successForeground, #2fb158);
}

.ws-message--warning .ws-message__icon {
  color: var(--ws-message-warningForeground, #b57a1e);
}

.ws-message--error .ws-message__icon {
  color: var(--ws-message-errorForeground,#ff0202);
}

.ws-message__text {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-line;
}

.ws-message__close {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: $icon-size-width + $spacing-xs;
  height: $icon-size-height + $spacing-xs;
  padding: $spacing-2xs;
  border: 0;
  border-radius: $radius-xs;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.ws-message__close:hover,
.ws-message__close:focus-visible {
  background: rgb(255 255 255 / 0.12);
  outline: none;
}
</style>
