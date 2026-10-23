/** Stores validated application shortcut bindings and synchronizes them across renderer windows. */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { appSettingsApi } from '@/api/appSettings';
import { APP_SETTING_KEYS, type AppSettingChangedEvent } from '@/types/appSettings';
import { shortcutDefinitions } from '@/utils/shortcutDefinitions';

const SHORTCUT_BINDINGS_KEY = APP_SETTING_KEYS.shortcutBindings;
const IMPLEMENTED_COMMANDS = new Set(
  shortcutDefinitions.filter(shortcut => shortcut.implemented).map(shortcut => shortcut.command)
);

function parseBindings(serialized: string | null): Record<string, string> {
  if (!serialized) return {};

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed).filter(([command, binding]) => (
        IMPLEMENTED_COMMANDS.has(command)
        && typeof binding === 'string'
        && binding.trim().length > 0
      ))
    );
  } catch {
    return {};
  }
}

export const useShortcutStore = defineStore('shortcuts', () => {
  const bindings = ref<Record<string, string>>({});
  const initialized = ref(false);
  let disposeSettingsListener: (() => void) | undefined;

  const initialize = async (): Promise<void> => {
    if (initialized.value) return;

    disposeSettingsListener = appSettingsApi.onChanged(handleSettingsChanged);
    bindings.value = parseBindings(await appSettingsApi.get(SHORTCUT_BINDINGS_KEY));
    initialized.value = true;
  };

  const getBinding = (command: string): string => {
    const definition = shortcutDefinitions.find(shortcut => shortcut.command === command);
    return bindings.value[command] ?? definition?.keybinding ?? '';
  };

  const setBinding = (command: string, binding: string): void => {
    if (!IMPLEMENTED_COMMANDS.has(command) || !binding.trim()) return;

    bindings.value = { ...bindings.value, [command]: binding.trim() };
    void appSettingsApi.set(SHORTCUT_BINDINGS_KEY, JSON.stringify(bindings.value));
  };

  function handleSettingsChanged(event: AppSettingChangedEvent): void {
    if (event.key === SHORTCUT_BINDINGS_KEY) bindings.value = parseBindings(event.value);
  }

  function dispose(): void {
    disposeSettingsListener?.();
    disposeSettingsListener = undefined;
    initialized.value = false;
  }

  return {
    bindings: computed(() => bindings.value),
    initialized,
    initialize,
    getBinding,
    setBinding,
    dispose
  };
});
