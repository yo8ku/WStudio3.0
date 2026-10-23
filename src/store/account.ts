/** 文件说明：维护宿主账号列表与当前账号，通过原生 API 恢复会话，不在渲染进程保存 Token。 */
import { computed, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import { loginApi } from '@/login/api';
import type { LoginReceipt } from '@/login/types';

const MAX_ACCOUNTS = 3;

export const useAccountStore = defineStore('account', () => {
  const accounts = shallowRef<LoginReceipt[]>([]);
  const activeAccountHash = shallowRef<string | null>(null);
  const user = computed(() => {
    const receipt = accounts.value.find(value => value.accountHash === activeAccountHash.value)
      ?? accounts.value[0];
    return receipt ? {
      email: receipt.email,
      name: receipt.name,
      avatarUrl: receipt.avatarUrl,
      provider: receipt.provider,
      accountHash: receipt.accountHash
    } : null;
  });
  const canLogin = computed(() => accounts.value.length < MAX_ACCOUNTS);
  const loginRequestId = shallowRef(0);
  let revision = 0;

  function setAccounts(values: LoginReceipt[], active?: LoginReceipt | null): void {
    accounts.value = values.slice(0, MAX_ACCOUNTS);
    activeAccountHash.value = active?.accountHash
      ?? (accounts.value.some(value => value.accountHash === activeAccountHash.value)
        ? activeAccountHash.value
        : accounts.value[0]?.accountHash ?? null);
  }

  /** 将新登录账号追加到列表；重复账号更新凭据并置为当前账号。 */
  function addAccount(value: LoginReceipt): boolean {
    const next = accounts.value.filter(account => account.accountHash !== value.accountHash);
    if (next.length >= MAX_ACCOUNTS) return false;
    next.unshift(value);
    accounts.value = next;
    activeAccountHash.value = value.accountHash;
    return true;
  }

  /** 保留旧调用方的命名，成功登录时按多账号追加。 */
  function accept(value: LoginReceipt | null): void {
    revision += 1;
    if (value) addAccount(value);
    else setAccounts([]);
  }

  function requestLogin(): void {
    if (canLogin.value) loginRequestId.value += 1;
  }

  async function selectAccount(accountHash: string): Promise<void> {
    if (accountHash === activeAccountHash.value) return;
    await loginApi.selectAccount(accountHash);
    if (accounts.value.some(account => account.accountHash === accountHash)) {
      activeAccountHash.value = accountHash;
    }
  }

  async function logout(accountHash = activeAccountHash.value ?? undefined): Promise<void> {
    if (!accountHash) return;
    const wasActive = accountHash === activeAccountHash.value;
    await loginApi.logout(accountHash);
    accounts.value = accounts.value.filter(account => account.accountHash !== accountHash);
    if (wasActive) {
      const next = accounts.value[0];
      if (next) {
        await loginApi.selectAccount(next.accountHash);
        activeAccountHash.value = next.accountHash;
      } else {
        activeAccountHash.value = null;
      }
    }
  }

  /** 只接受经过宿主 /me 校验的会话，连接失败时保留已有状态。 */
  async function restore(): Promise<void> {
    const current = ++revision;
    try {
      const [values, active] = await Promise.all([
        loginApi.getReceipts(),
        loginApi.getReceipt()
      ]);
      if (current === revision) setAccounts(values, active);
    } catch {
      // 短暂网络故障不清除现有账号资料。
    }
  }

  return {
    accounts,
    activeAccountHash,
    user,
    canLogin,
    loginRequestId,
    accept,
    addAccount,
    requestLogin,
    selectAccount,
    restore,
    logout
  };
});
