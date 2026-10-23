/**
 * 文件说明：定义 AI 全局连接配置和连接测试在渲染进程、IPC 与主进程间共享的契约。
 */
import type { AiConnectedModel } from './aiModel';

/** 供受控 AI 连接桥接回填设置窗口的连接配置。 */
export interface AiConnectionSettings {
  apiEndpoint: string;
  apiKey: string;
  hasApiKey: boolean;
}

/** 更新全局连接配置时允许提交的字段。 */
export interface UpdateAiConnectionSettingsRequest {
  apiEndpoint: string;
  apiKey?: string;
}

/** 连接测试对渲染进程公开的唯一结果语义。 */
export type AiConnectionTestResult =
  | { success: true; message: '连接成功'; model: AiConnectedModel }
  | { success: false; message: '连接失败' };
