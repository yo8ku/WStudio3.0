/**
 * 文件说明：封装渲染进程对用户主题扫描和内置主题物化能力的 IPC 调用。
 */

import type { ThemeMaterializeBuiltinRequest } from '@/types/ipc';
import type { UserThemeEntry } from '@theme/core/types';

import { nativeApi } from './native';

export const themeApi = {
  /** 读取主进程扫描并校验后的用户主题。 */
  listUserThemes(): Promise<UserThemeEntry[]> {
    return nativeApi.theme.listUserThemes();
  },

  /** 将已校验的内置主题首次写入用户主题目录。 */
  materializeBuiltin(request: ThemeMaterializeBuiltinRequest): Promise<UserThemeEntry> {
    return nativeApi.theme.materializeBuiltin(request);
  }
};
