<script setup lang="ts">
/** 文件说明：作为账号菜单的假二级面板展示账号信息，并提供返回、退出操作。 */
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import { useAccountStore } from '@/store/account';

const props = defineProps<{
  accountHash: string | null;
}>();

const emit = defineEmits<{ back: []; close: [] }>();
const accountStore = useAccountStore();
const { accounts } = storeToRefs(accountStore);
const account = computed(() => accounts.value.find(value => value.accountHash === props.accountHash) ?? null);
const accountName = computed(() => account.value?.name || account.value?.email || '账号');
const avatarFailed = ref(false);
const confirmOpen = ref(false);
const loggingOut = ref(false);
const logoutError = ref('');

watch(() => props.accountHash, () => {
  avatarFailed.value = false;
  logoutError.value = '';
  confirmOpen.value = false;
});

function requestLogout(): void {
  if (account.value && !loggingOut.value) confirmOpen.value = true;
}

async function confirmLogout(): Promise<void> {
  const current = account.value;
  if (!current || loggingOut.value) return;
  loggingOut.value = true;
  logoutError.value = '';
  try {
    await accountStore.logout(current.accountHash);
    emit('close');
  } catch {
    logoutError.value = '退出登录失败，请重试。';
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <section class="account-panel" aria-label="账号面板">
    <header class="account-panel__header">
      <!-- S = WsIconButton -->
      <WsIconButton
        icon="icon icon-arrow-back"
        label=""
        :ripple="false"
        variant="text"
        @click="emit('back')"
      />
      <!-- E = WsIconButton -->
      <h2 class="account-panel__title">账号</h2>
      <!-- S = WsIconButton -->
      <WsIconButton
        class="account-panel__logout"
        density="comfortable"
        icon="icon icon-sign-out"
        label="退出登录"
        tooltip="退出登录"
        :disabled="!account || loggingOut"
        :aria-busy="loggingOut"
        :ripple="false"
        variant="text"
        @click="requestLogout"
      />
      <!-- E = WsIconButton -->
    </header>

    <section v-if="account && !confirmOpen" class="account-panel__content" aria-label="账号信息">
      <div class="account-panel__identity">
        <img
          v-if="account.avatarUrl && !avatarFailed"
          class="account-panel__avatar"
          :src="account.avatarUrl"
          alt="用户头像"
          referrerpolicy="no-referrer"
          @error="avatarFailed = true"
        />
        <span v-else class="account-panel__avatar account-panel__avatar--fallback icon icon-user" aria-hidden="true" />
        <div class="account-panel__identity-copy">
          <strong>{{ accountName }}</strong>
          <span>{{ account.email || '未提供邮箱' }}</span>
        </div>
      </div>

      <dl class="account-panel__details">
        <div>
          <dt>登录方式</dt>
          <dt>{{ account.provider === 'google' ? 'Google' : account.provider }}</dt>
        </div>
        <div>
          <dt>账号状态</dt>
          <dt>已登录</dt>
        </div>
      </dl>

      <p v-if="logoutError" class="account-panel__error" role="alert">{{ logoutError }}</p>
    </section>
    <section v-else-if="account" class="account-panel__confirm" aria-label="退出登录确认">
      <h3>退出登录</h3>
      <p class="account-panel__confirm-message">
        确定要退出“{{ accountName }}”吗？退出后将移除本机保存的该账号会话。
      </p>
      <div class="account-panel__actions">
        <v-btn variant="text" :disabled="loggingOut" @click="confirmOpen = false">取消</v-btn>
        <v-btn color="error" :loading="loggingOut" @click="confirmLogout">退出登录</v-btn>
      </div>
      <p v-if="logoutError" class="account-panel__error" role="alert">{{ logoutError }}</p>
    </section>
    <p v-else class="account-panel__empty" role="status">账号信息已更新，请返回菜单后重试。</p>
  </section>
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;

.account-panel__content {
  display: grid;
  gap: $spacing-md;
  padding: $spacing-sm;
}

.account-panel {
  min-width: $account-menu-width;
  max-width: min($account-menu-max-width, 90vw);
  color: var(--ws-foreground);
}

.account-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $spacing-2xs;
  min-height: 2.5rem;
  padding: $spacing-2xs;
  border-bottom: 1px solid var(--ws-border);
}

.account-panel__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: $font-size-sm;
  text-align: center;
}

.account-panel__identity {
  display: flex;
  align-items: center;
  gap: $spacing-sm;
}

.account-panel__avatar {
  flex: 0 0 auto;
  width: 3.5rem;
  height: 3.5rem;
  object-fit: cover;
  border-radius: 50%;
}

.account-panel__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--ws-button-secondaryBackground);
  color: var(--ws-foreground);
  font-size: $font-size-lg;
}

.account-panel__identity-copy {
  display: grid;
  min-width: 0;
  gap: $spacing-2xs;
}

.account-panel__identity-copy strong,
.account-panel__identity-copy span {
  overflow-wrap: anywhere;
}

.account-panel__identity-copy span,
.account-panel__details dt {
  color: var(--ws-descriptionForeground);
  font-size: $font-size-xs;
}

.account-panel__details {
  display: grid;
  gap: $spacing-xs;
  margin: 0;
}

.account-panel__details div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: $spacing-md;
  padding-block: $spacing-2xs;
  border-bottom: 1px solid var(--ws-border);
}

.account-panel__details dd {
  margin: 0;
  color: var(--ws-foreground);
  text-align: end;
}

.account-panel__error {
  margin: 0;
  color: var(--ws-errorForeground);
  font-size: $font-size-xs;
}

.account-panel__empty,
.account-panel__confirm-message {
  margin: 0;
  padding: $spacing-sm;
  color: var(--ws-descriptionForeground);
  line-height: 1.5;
}

.account-panel__confirm h3 {
  margin: 0;
  padding: $spacing-sm $spacing-sm 0;
  font-size: $font-size-sm;
}

.account-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: $spacing-xs;
  padding: 0 $spacing-sm $spacing-sm;
}

:deep(.account-panel__logout) {
  color: var(--ws-errorForeground);
}
</style>
