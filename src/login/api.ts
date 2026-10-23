/** 文件说明：提供登录领域对原生登录命令的统一访问入口。 */
import { nativeApi } from '@/api/native';
import type { AuthenticationApi } from './types';

export const loginApi: AuthenticationApi = {
  beginGoogle: () => nativeApi.login.beginGoogle(),
  beginGithub: () => nativeApi.login.beginGithub(),
  wait: (attemptId) => nativeApi.login.wait(attemptId),
  cancel: (attemptId) => nativeApi.login.cancel(attemptId),
  logout: (accountHash) => nativeApi.login.logout(accountHash),
  getReceipts: () => nativeApi.login.getReceipts(),
  selectAccount: (accountHash) => nativeApi.login.selectAccount(accountHash),
  getReceipt: () => nativeApi.login.getReceipt()
};
