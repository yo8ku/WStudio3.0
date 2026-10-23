<script setup lang="ts">
/** 文件说明：展示第三方登录选项，在凭据保存成功或已验证会话恢复后自动关闭弹窗。 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import WsDialog from '@/components/WsDialog/WsDialog.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import { loginApi } from '@/login/api';
import type { LoginReceipt } from '@/login/types';
import { useAccountStore } from '@/store/account';

const props = defineProps<{
  modelValue: boolean;
  /** 打开弹窗时是否允许已有会话直接完成恢复。显式追加账号登录需要关闭它。 */
  restoreExisting?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const isOpen = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
});
const providers = [
  { id: 'google', icon: 'icon icon-google', label: '使用 Google 继续', unavailable: false },
  { id: 'github', icon: 'icon icon-github', label: '使用 GitHub 继续', unavailable: false },
  { id: 'apple', icon: 'icon icon-apple', label: '使用 Apple 继续', unavailable: true }
] as const;
const providerButtonProps = {
  density: 'comfortable',
  variant: 'outlined',
  ripple: false
} as const;
const loginState = ref<'idle' | 'waiting' | 'success' | 'error'>('idle');
const loginMessage = ref('');
const activeAttemptId = ref<string>();
let loginRequestId = 0;

function providerLabel(provider: 'google' | 'github'): string {
  return provider === 'github' ? 'GitHub' : 'Google';
}

function errorMessage(error: unknown, provider: 'google' | 'github'): string {
  const label = providerLabel(provider);
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const code = text.match(/LOGIN_[A-Z0-9_]+/)?.[0] ?? '';
  if (code === 'LOGIN_AUTHORIZATION_DENIED') return `已取消 ${label} 授权。`;
  if (code === 'LOGIN_BROWSER_OPEN_FAILED') return '无法打开浏览器，请重试。';
  if (code === 'LOGIN_AUTHORIZATION_CODE_INVALID') return `${label} 授权码已失效，请重新登录。`;
  if (code === 'LOGIN_SERVER_REQUEST_FAILED') return '服务暂时不可用，请稍后重试。';
  if (code === 'LOGIN_ACCOUNT_DISABLED') return '该账号已停用，请联系服务管理员。';
  if (code === 'LOGIN_TIMEOUT') return '登录已超时，请重新授权。';
  if (code === 'LOGIN_CANCELLED') return '登录已取消。';
  if (code === 'LOGIN_RATE_LIMITED') return '登录请求过于频繁，请稍后重试。';
  if (code === 'LOGIN_ACCOUNT_LIMIT') return '最多同时登录 3 个账号。';
  return `${label} 登录失败，请重试。`;
}

/** 原生宿主已保存并确认会话后，通知父组件关闭登录弹窗。 */
function showSuccess(receipt: LoginReceipt): void {
  useAccountStore().accept(receipt);
  loginState.value = 'success';
  loginMessage.value = receipt.provider === 'google' ? 'Google 登录成功。' : '登录成功。';
  isOpen.value = false;
}

async function beginProvider(provider: 'google' | 'github'): Promise<void> {
  if (loginState.value === 'waiting') return;
  const requestId = ++loginRequestId;
  loginState.value = 'waiting';
  const label = providerLabel(provider);
  loginMessage.value = `正在打开 ${label} 授权页面…`;
  try {
    const attempt = provider === 'github'
      ? await loginApi.beginGithub()
      : await loginApi.beginGoogle();
    if (requestId !== loginRequestId) {
      await loginApi.cancel(attempt.attemptId).catch(() => undefined);
      return;
    }
    activeAttemptId.value = attempt.attemptId;
    loginMessage.value = `等待 ${label} 授权，请在浏览器中完成登录。`;
    const receipt = await loginApi.wait(attempt.attemptId);
    if (requestId !== loginRequestId) return;
    showSuccess(receipt);
  } catch (error: unknown) {
    if (requestId !== loginRequestId) return;
    loginState.value = 'error';
    loginMessage.value = errorMessage(error, provider);
  } finally {
    if (requestId === loginRequestId) activeAttemptId.value = undefined;
  }
}

function beginGoogle(): Promise<void> {
  return beginProvider('google');
}

function beginGithub(): Promise<void> {
  return beginProvider('github');
}

function isProviderDisabled(provider: (typeof providers)[number]): boolean {
  return provider.unavailable === true || loginState.value === 'waiting';
}

async function cancelActiveAttempt(): Promise<void> {
  const attemptId = activeAttemptId.value;
  loginRequestId += 1;
  activeAttemptId.value = undefined;
  if (!attemptId) return;
  try {
    await loginApi.cancel(attemptId);
  } catch {
    // The native flow may already have completed while the dialog was closing.
  }
}

/** 每次重新打开都使旧的授权等待失效，避免关闭浏览器后残留 waiting 状态。 */
function resetForOpen(): void {
  const staleAttemptId = activeAttemptId.value;
  loginRequestId += 1;
  activeAttemptId.value = undefined;
  loginState.value = 'idle';
  loginMessage.value = '';
  if (staleAttemptId) {
    void loginApi.cancel(staleAttemptId).catch(() => undefined);
  }

  const requestId = loginRequestId;
  if (props.restoreExisting !== false) {
    void loginApi.getReceipt().then(receipt => {
      if (receipt && requestId === loginRequestId && props.modelValue) showSuccess(receipt);
    }).catch(() => undefined);
  }
}

watch(() => props.modelValue, (open, wasOpen) => {
  if (open && !wasOpen) {
    resetForOpen();
  }
  if (!open && wasOpen) void cancelActiveAttempt();
});

onBeforeUnmount(() => {
  void cancelActiveAttempt();
});
</script>

<template>
  <!-- S = WsDialog -->
  <WsDialog
    v-model="isOpen"
    class="login-dialog"
    title=""
    close-label="关闭"
    aria-modal="true"
    aria-label="登陆"
    :dismissible="false"
    @close="cancelActiveAttempt"
  >
    <section class="login-dialog__options" aria-label="登陆方式">
      <img class="login-dialog__logo" src="/wslog3.png" alt="WStudio" />
      <!-- S = WsIconButton -->
      <WsIconButton
        v-for="provider in providers"
        :key="provider.id"
        v-bind="providerButtonProps"
        class="login-dialog__provider"
        :icon="provider.icon"
        :label="provider.label"
        :text="provider.label"
        icon-position="start"
        :disabled="isProviderDisabled(provider)"
        :aria-busy="!provider.unavailable && loginState === 'waiting'"
        @click="provider.id === 'google' ? beginGoogle() : provider.id === 'github' ? beginGithub() : undefined"
      />
      <!-- E = WsIconButton -->
      <p
        v-if="loginMessage"
        class="login-dialog__message"
        :class="`login-dialog__message--${loginState}`"
        role="status"
        aria-live="polite"
      >
        {{ loginMessage }}
      </p>
    </section>
  </WsDialog>
  <!-- E = WsDialog -->
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

// WsDialog 的默认最小宽度由弹窗表面覆盖，以适配窄窗口。
:global(.ws-dialog.login-dialog) {
  min-width: 0;
  border-radius: $radius-xs;
  height: 20rem;
  width: 22rem;
}

:global(.ws-dialog.login-dialog .ws-dialog__header) {
  background: transparent;
  border-bottom: none;
  min-height: 0;
}

.login-dialog__options {
  display: grid;
  gap: $spacing-sm;
  user-select: none;
}

.login-dialog__logo {
  display: block;
  width: $login-dialog-logo-size;
  max-width: 100%;
  height: auto;
  justify-self: center;
  object-fit: contain;
  margin-bottom: $spacing-md;
}

// WsIconButton 经 tooltip 插槽渲染按钮，样式由选项布局容器穿透至实际按钮。
.login-dialog__options :deep(.login-dialog__provider.ws-icon-button) {
  width: 100%;
  min-width: 0;
  height: $spacing-xl;
  border: $input-border-width solid var(--ws-border);
  border-radius: $radius-xs;
  color: var(--ws-foreground);
  font-size: $font-size-sm;
}

.login-dialog__options :deep(.login-dialog__provider:hover),
.login-dialog__options :deep(.login-dialog__provider:focus-visible) {
  color: var(--ws-button-hoverForeground);
  background: var(--ws-button-hoverBackground);
}

.login-dialog__options :deep(.ws-icon-button__icon) {
  font-size: $font-size-lg;
}

.login-dialog__message {
  margin: $spacing-xs 0 0;
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
  line-height: 1.4;
  text-align: center;
}

.login-dialog__message--success {
  color: $error-color;
}

.login-dialog__message--error {
    color: $error-color;
}
</style>
