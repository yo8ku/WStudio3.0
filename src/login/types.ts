/** 文件说明：定义登录模块与公开 SDK 共用的非敏感登录凭证及授权会话契约。 */
export interface LoginReceipt {
  receiptId: string;
  provider: 'google' | 'github';
  accountHash: string;
  email: string;
  name: string;
  avatarUrl: string;
  issuedAt: number;
  expiresAt: number;
  syncStatus: 'pending' | 'synced';
}

export interface LoginAttempt {
  attemptId: string;
  expiresAt: number;
}

/** 只公开非敏感会话元数据；WStudio Token 保存在原生宿主的系统凭据库。 */
export interface AuthenticationApi {
  beginGoogle(): Promise<LoginAttempt>;
  beginGithub(): Promise<LoginAttempt>;
  wait(attemptId: string): Promise<LoginReceipt>;
  cancel(attemptId: string): Promise<void>;
  logout(accountHash?: string): Promise<void>;
  getReceipts(): Promise<LoginReceipt[]>;
  selectAccount(accountHash: string): Promise<void>;
  getReceipt(): Promise<LoginReceipt | null>;
}
