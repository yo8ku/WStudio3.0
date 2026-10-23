/** Renderer-side bridge for SQLite-backed application preferences. */
import type {
  AppSettingChangedEvent,
  AppSettingKey
} from '@/types/appSettings';

import { isTauriRuntime, nativeApi } from './native';

export const appSettingsApi = {
  get(key: AppSettingKey): Promise<string | null> {
    return nativeApi.appSettings.get(key);
  },

  set(key: AppSettingKey, value: string): Promise<void> {
    return nativeApi.appSettings.set(key, value);
  },

  remove(key: AppSettingKey): Promise<void> {
    return nativeApi.appSettings.remove(key);
  },

  onChanged(listener: (event: AppSettingChangedEvent) => void): () => void {
    return nativeApi.appSettings.onChanged(listener);
  }
};

/** One-time compatibility migration from the old renderer localStorage keys. */
export async function migrateLegacyAppSettings(keys: readonly AppSettingKey[]): Promise<void> {
  if (!isTauriRuntime()) return;

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return;
  }

  const legacyEntries = keys.flatMap(key => {
    const value = storage.getItem(key);
    return value === null ? [] : [{ key, value }];
  });
  await Promise.all(legacyEntries.map(async ({ key, value }) => {
    const current = await appSettingsApi.get(key);
    if (current === null) await appSettingsApi.set(key, value);
    storage.removeItem(key);
  }));
}
