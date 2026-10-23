<script setup lang="ts">
/** 文件说明：显示当前账号头像；未登录时打开授权弹窗，已登录时提供账号菜单、切换和二级面板。 */
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
import WsMenu from '@/components/WsMenu/WsMenu.vue';
import AccountPanel from '@/components/AccountPanel/AccountPanel.vue';
import { useAccountStore } from '@/store/account';

const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ login: [] }>();
const accountStore = useAccountStore();
const { user, accounts, activeAccountHash, canLogin } = storeToRefs(accountStore);
const menuOpen = ref(false);
const accountPanelOpen = ref(false);
const selectedAccountHash = ref<string | null>(null);
const target = ref<HTMLElement | null>(null);
const failedAvatarHashes = ref<string[]>([]);
const switchingAccountHash = ref<string | null>(null);
const avatarUrl = computed(() => user.value && !failedAvatarHashes.value.includes(user.value.accountHash)
  ? user.value.avatarUrl
  : '');
const buttonProps = { density: 'comfortable', variant: 'text', ripple: false } as const;
const listProps = { density: 'compact', nav: false } as const;
const itemProps = { ripple: false } as const;
watch(() => accounts.value.map(account => `${account.accountHash}:${account.avatarUrl}`), () => {
  failedAvatarHashes.value = [];
});
watch(() => props.disabled, disabled => { if (disabled) menuOpen.value = false; });
watch(user, value => { if (!value) menuOpen.value = false; });
watch(menuOpen, open => { if (!open) accountPanelOpen.value = false; });

function avatarUrlFor(account: { accountHash: string; avatarUrl: string }): string {
  return failedAvatarHashes.value.includes(account.accountHash) ? '' : account.avatarUrl;
}

function markAvatarFailed(accountHash: string): void {
  if (!failedAvatarHashes.value.includes(accountHash)) failedAvatarHashes.value.push(accountHash);
}

/** 定位账号菜单；访客继续使用原有登录入口。 */
function clickAccount(event: MouseEvent): void {
  if (props.disabled) return;
  if (!user.value) { emit('login'); return; }
  target.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  menuOpen.value = !menuOpen.value;
}

function openLogin(): void {
  menuOpen.value = false;
  emit('login');
}

function openAccountPanel(accountHash: string): void {
  selectedAccountHash.value = accountHash;
  accountPanelOpen.value = true;
}

/** 账号行右侧的切换动作不打开二级面板。 */
async function switchAccount(accountHash: string, event: MouseEvent): Promise<void> {
  event.stopPropagation();
  if (accountHash === activeAccountHash.value || switchingAccountHash.value) return;
  switchingAccountHash.value = accountHash;
  try {
    await accountStore.selectAccount(accountHash);
  } catch {
    // 账号切换失败时保留当前账号和菜单状态，等待用户重试。
  } finally {
    switchingAccountHash.value = null;
  }
}
</script>

<template>
  <!-- S = WsIconButton -->
  <WsIconButton
    v-bind="buttonProps"
    class="workbench-login-button"
    :label="user ? (user.name || user.email || '账号') : '登录'"
    :tooltip="user?.name || user?.email || '登录'"
    :disabled="props.disabled"
    :aria-haspopup="user ? 'menu' : 'dialog'"
    :aria-expanded="menuOpen"

    @click="clickAccount"
  >
    <template #icon>
      <img v-if="avatarUrl" class="account-avatar" :src="avatarUrl" alt="" referrerpolicy="no-referrer" @error="user && markAvatarFailed(user.accountHash)" />
      <span v-else class="icon icon-user" />
    </template>
  </WsIconButton>
  <!-- E = WsIconButton -->
  <!-- S = WsMenu -->
  <WsMenu v-model:open="menuOpen" :target="target" content-class="account-menu">
    <!-- S = AccountPanel -->
    <AccountPanel
      v-if="accountPanelOpen"
      :account-hash="selectedAccountHash"
      @back="accountPanelOpen = false"
      @close="menuOpen = false"
    />
    <!-- E = AccountPanel -->
    <v-list v-else v-bind="listProps" class="account-menu__list" aria-label="账号菜单">
      <v-list-item
        v-for="account in accounts"
        :key="account.accountHash"
        v-bind="itemProps"
        :title="account.name || account.email || '账号'"
        :subtitle="account.email"
        :active="account.accountHash === activeAccountHash"
        class="account-menu__identity"
        @click="openAccountPanel(account.accountHash)"
      >
        <template #prepend>
          <img
            v-if="avatarUrlFor(account)"
            class="account-avatar account-avatar--menu"
            :src="avatarUrlFor(account)"
            alt="用户头像"
            referrerpolicy="no-referrer"
            @error="markAvatarFailed(account.accountHash)"
          />
          <span v-else class="account-avatar account-avatar--menu icon icon-user" aria-hidden="true" />
        </template>
        <template #append>
          <!-- S = WsIconButton -->
          <WsIconButton
            class="account-menu__switch"
            density="compact"
            icon="icon icon-refresh"
            :label="`切换到${account.name || account.email || '该账号'}`"
            :tooltip="account.accountHash === activeAccountHash ? '当前账号' : '切换账号'"
            :disabled="account.accountHash === activeAccountHash || switchingAccountHash !== null"
            :aria-busy="switchingAccountHash === account.accountHash"
            :ripple="false"
            variant="text"
            @click="switchAccount(account.accountHash, $event)"
          />
          <!-- E = WsIconButton -->
        </template>
      </v-list-item>
      <v-divider />
      <v-list-item
        v-bind="itemProps"
        title="登录其他账号"
        role="menuitem"
        :disabled="!canLogin"
        @click="canLogin && openLogin()"
      />
    </v-list>
  </WsMenu>
  <!-- E = WsMenu -->
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;
.account-avatar {
  display: block;
  width: $account-avatar-size;
  height: $account-avatar-size;
  object-fit: cover;
  border-radius: 50%;
}
.account-avatar--menu { margin-inline-end: $spacing-2xs; }
.account-menu__list { min-width: $account-menu-width; max-width: min($account-menu-max-width, 90vw); }
.account-menu__identity { align-items: center; }
.account-menu__identity :deep(.v-list-item__prepend),
.account-menu__identity :deep(.v-list-item__content) {
  align-self: center;
}
.account-menu__identity :deep(.v-list-item__prepend) { align-items: center; }
.account-menu__identity :deep(.v-list-item__content) { justify-content: center; }
.account-menu__identity :deep(.v-list-item-title) {font-size:0.9rem; overflow-wrap: anywhere; white-space: normal; }
.account-menu__identity :deep(.v-list-item-subtitle) {font-size:0.75rem; }
.account-menu__switch { flex: 0 0 auto; }
</style>
