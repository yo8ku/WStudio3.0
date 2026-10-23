<script setup lang="ts">
/** 文件说明：在 WStudio 设置中展示当前账号身份和登录方式。 */
import { storeToRefs } from 'pinia';
import { ref, watch } from 'vue';
import { useAccountStore } from '@/store/account';
import SettingsOptionList from '@/components/workbench/SettingsOptionList.vue';
import SettingsOptionItem from '@/components/workbench/SettingsOptionItem.vue';
import WsIconButton from '@/components/WsIconButton/WsIconButton.vue';
const { user } = storeToRefs(useAccountStore());
const accountStore = useAccountStore();
const imageFailed = ref(false);
const loggingOut = ref(false);
const logoutError = ref('');
watch(() => user.value?.avatarUrl, () => { imageFailed.value = false; });

async function logout(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  logoutError.value = '';
  try {
    await accountStore.logout();
  } catch {
    logoutError.value = '退出登录失败，请重试。';
  } finally {
    loggingOut.value = false;
  }
}

function requestLogin(): void {
  accountStore.requestLogin();
}
</script>

<template>
  <!-- S = SettingsOptionList -->
  <SettingsOptionList title="个人资料" list-label="个人资料">
    <template #title-actions>
      <WsIconButton
        class="logout-button"
        icon="icon icon-sign-out"
        label="退出登录"
        text="退出登录"
        :disabled="!user || loggingOut"
        :aria-busy="loggingOut"
        @click="logout"
      />
    </template>
    <!-- S = SettingsOptionItem -->
    <SettingsOptionItem title="头像" description="来自当前 Google 账号。">
      <img v-if="user?.avatarUrl && !imageFailed" class="account-preferences__avatar" :src="user.avatarUrl" alt="用户头像" referrerpolicy="no-referrer" @error="imageFailed = true" />
      <span v-else class="icon icon-user" aria-label="默认用户头像" />
    </SettingsOptionItem>
    <SettingsOptionItem title="邮箱"><span>{{ user?.email || '未提供邮箱' }}</span></SettingsOptionItem>
    <SettingsOptionItem title="名称"><span>{{ user?.name || '未提供名称' }}</span></SettingsOptionItem>
    <SettingsOptionItem title="登录方式"><span>{{ user ? 'Google' : '尚未登录' }}</span></SettingsOptionItem>
    <SettingsOptionItem
      title="登录"
      description="打开账号登录窗口。"
      clickable
      @click="requestLogin"
    />
    <!-- E = SettingsOptionItem -->
  </SettingsOptionList>
  <p v-if="logoutError" class="account-preferences__error" role="alert">{{ logoutError }}</p>
  <!-- E = SettingsOptionList -->
</template>

<style lang="scss" scoped>
@use '@/assets/styles/variables' as *;
.account-preferences__avatar { width: $account-avatar-size; height: $account-avatar-size; object-fit: cover; border-radius: $radius-xs; }
.account-preferences__error { margin: $spacing-sm 0 0; color: var(--ws-errorForeground); font-size: $font-size-xs; }

:deep(.logout-button) {
  color: red;
}
</style>
