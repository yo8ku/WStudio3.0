/**
 * 文件说明：管理主题解析、应用以及工作区视觉偏好状态。
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';

import { applyResolvedThemeToVuetify } from '@theme/adapters/vuetify';
import { applyThemeVariantToElement } from '@theme/core/cssVars';
import { createThemeRegistry, loadThemeRegistry } from '@theme/core/registry';
import { loadThemePackageManifests } from '@theme/core/manifestLoader';
import { resolveTheme, type ResolveThemeOptions } from '@theme/core/resolver';
import type { ResolvedTheme, ThemeAppearance, ThemeRegistry } from '@theme/core/types';
import { DEFAULT_MODERN_UI_ENABLED } from '@/UIStyles/ModernUI/persistence';
import { vuetify } from '@/plugins/vuetify';
import { themeApi } from '@/api/theme';
import { appSettingsApi } from '@/api/appSettings';
import { APP_SETTING_KEYS, type AppSettingChangedEvent } from '@/types/appSettings';
import type { UserThemeEntry } from '@theme/core/types';

export interface InitializeThemeSystemOptions {
  themeId?: string | null;
  preferredAppearance?: ThemeAppearance;
}

export const useThemeStore = defineStore('theme', () => {
  const registry = shallowRef<ThemeRegistry | null>(null);
  const activeTheme = shallowRef<ResolvedTheme | null>(null);
  const initialized = ref(false);
  const initializing = ref(false);
  const initializationError = ref<string | null>(null);
  const modernUiEnabled = ref(DEFAULT_MODERN_UI_ENABLED);
  let storageSyncRegistered = false;
  let pendingThemeSync: string | null | undefined;
  let pendingModernUiValue: boolean | undefined;

  const availableThemes = computed(() => registry.value?.themes ?? []);
  const activeThemeId = computed(() => activeTheme.value?.descriptor.id ?? null);
  const activeAppearance = computed(() => activeTheme.value?.loaded.variant.type ?? null);
  const activeThemeLabel = computed(() => activeTheme.value?.loaded.variant.displayName ?? null);
  const pathNavigationProjectGradientEnabled = computed(() =>
    activeTheme.value?.loaded.variant.effects.pathNavigation.projectGradient ?? false
  );

  async function initializeThemeSystem(
    options: InitializeThemeSystemOptions = {}
  ): Promise<ResolvedTheme> {
    initializing.value = true;
    initializationError.value = null;
    registerPersistedSettingsSync();

    try {
      const [persistedThemeId, persistedModernUi, userThemes, manifests] = await Promise.all([
        appSettingsApi.get(APP_SETTING_KEYS.activeThemeId),
        appSettingsApi.get(APP_SETTING_KEYS.modernUiEnabled),
        themeApi.listUserThemes(),
        loadThemePackageManifests()
      ]);
      const initialModernUiEnabled = persistedModernUi === null
        ? DEFAULT_MODERN_UI_ENABLED
        : persistedModernUi !== 'false';
      modernUiEnabled.value = pendingModernUiValue ?? initialModernUiEnabled;
      const themeRegistry = createThemeRegistry(manifests, userThemes);
      registry.value = themeRegistry;
      const requestedThemeId = pendingThemeSync !== undefined
        ? pendingThemeSync
        : normalizeThemeId(options.themeId) ?? normalizeThemeId(persistedThemeId);
      const resolvedTheme = await applyResolvedTheme(themeRegistry, {
        themeId: requestedThemeId,
        preferredAppearance: options.preferredAppearance ?? 'dark'
      }, false);

      if (pendingThemeSync === undefined && persistedThemeId !== resolvedTheme.descriptor.id) {
        await appSettingsApi.set(APP_SETTING_KEYS.activeThemeId, resolvedTheme.descriptor.id);
      }

      initialized.value = true;

      // Drain changes received while the initial settings snapshot was loading.
      // Keep initialization active so events arriving during a theme sync are queued too.
      while (pendingThemeSync !== undefined || pendingModernUiValue !== undefined) {
        const pendingThemeId = pendingThemeSync;
        const pendingModernUi = pendingModernUiValue;
        pendingThemeSync = undefined;
        pendingModernUiValue = undefined;

        if (pendingModernUi !== undefined) {
          modernUiEnabled.value = pendingModernUi;
        }
        if (pendingThemeId !== undefined && pendingThemeId !== activeThemeId.value) {
          await syncThemeFromSettings(pendingThemeId);
        }
      }

      return activeTheme.value ?? resolvedTheme;
    } catch (error) {
      initializationError.value =
        error instanceof Error ? error.message : 'Failed to initialize the theme system.';

      throw error;
    } finally {
      initializing.value = false;
    }
  }

  async function setActiveTheme(
    themeId: string,
    preferredAppearance?: ThemeAppearance
  ): Promise<ResolvedTheme> {
    const themeRegistry = await ensureRegistryLoaded();

    const resolvedTheme = await applyResolvedTheme(themeRegistry, {
      themeId,
      preferredAppearance
    });

    if (resolvedTheme.descriptor.source === 'builtin') {
      try {
        await themeApi.materializeBuiltin({
          category: resolvedTheme.descriptor.category,
          fileName: getThemeFileName(resolvedTheme.descriptor.file, resolvedTheme.descriptor.id),
          variant: resolvedTheme.loaded.variant
        });
      } catch (error) {
        console.warn('Failed to materialize the selected built-in theme.', error);
      }
    }

    return resolvedTheme;
  }

  /** 重新扫描用户主题目录，并在当前主题仍可用时立即重新应用。 */
  async function refreshUserThemes(): Promise<void> {
    try {
      const userThemes = await themeApi.listUserThemes();
      const themeRegistry = await loadThemeRegistry(userThemes);
      const currentThemeId = activeThemeId.value;
      registry.value = themeRegistry;

      if (currentThemeId) {
        await applyResolvedTheme(themeRegistry, { themeId: currentThemeId }, false);
      }
    } catch (error) {
      initializationError.value = error instanceof Error
        ? error.message
        : 'Failed to refresh user themes.';
    }
  }

  async function resetToDefaultTheme(
    preferredAppearance: ThemeAppearance = 'dark'
  ): Promise<ResolvedTheme> {
    await appSettingsApi.remove(APP_SETTING_KEYS.activeThemeId);

    const themeRegistry = await ensureRegistryLoaded();

    return applyResolvedTheme(themeRegistry, {
      preferredAppearance
    });
  }

  /** 更新并持久化工作区 Modern UI 外观偏好。 */
  function setModernUiEnabled(enabled: boolean): void {
    modernUiEnabled.value = enabled;
    void appSettingsApi.set(APP_SETTING_KEYS.modernUiEnabled, String(enabled));
  }

  async function ensureRegistryLoaded(
    userThemes?: readonly UserThemeEntry[]
  ): Promise<ThemeRegistry> {
    if (registry.value && userThemes === undefined) {
      return registry.value;
    }

    registry.value = await loadThemeRegistry(userThemes ?? await themeApi.listUserThemes());

    return registry.value;
  }

  async function applyResolvedTheme(
    themeRegistry: ThemeRegistry,
    options: ResolveThemeOptions,
    persist = true
  ): Promise<ResolvedTheme> {
    const resolvedTheme = await resolveTheme(themeRegistry, options);

    if (typeof document !== 'undefined') {
      applyThemeVariantToElement(resolvedTheme.loaded.variant, document.documentElement);
    }

    applyResolvedThemeToVuetify(vuetify.theme, resolvedTheme);
    if (persist) {
      await appSettingsApi.set(APP_SETTING_KEYS.activeThemeId, resolvedTheme.descriptor.id);
    }
    activeTheme.value = resolvedTheme;

    return resolvedTheme;
  }

  /** 注册同源窗口间的主题与工作区外观设置同步监听。 */
  function registerPersistedSettingsSync(): void {
    if (storageSyncRegistered || typeof window === 'undefined') {
      return;
    }

    appSettingsApi.onChanged(handlePersistedSettingStorageChange);
    storageSyncRegistered = true;
  }

  /** 按持久化键同步其他窗口提交的主题与工作区外观设置。 */
  function handlePersistedSettingStorageChange(event: AppSettingChangedEvent): void {
    if (event.key === APP_SETTING_KEYS.modernUiEnabled) {
      const enabled = event.value !== 'false';
      if (initializing.value) {
        pendingModernUiValue = enabled;
      } else {
        modernUiEnabled.value = enabled;
      }
      return;
    }

    if (event.key !== APP_SETTING_KEYS.activeThemeId) {
      return;
    }

    const themeId = normalizeThemeId(event.value);

    if (initializing.value) {
      pendingThemeSync = themeId;
      return;
    }

    if (themeId === activeThemeId.value) {
      return;
    }

    void syncThemeFromSettings(themeId);
  }

  /** 应用跨窗口主题变化，避免再次写入存储形成同步回路。 */
  async function syncThemeFromSettings(themeId: string | null): Promise<void> {
    try {
      const themeRegistry = await ensureRegistryLoaded();
      await applyResolvedTheme(
        themeRegistry,
        themeId ? { themeId } : {},
        false
      );
    } catch (error) {
      initializationError.value =
        error instanceof Error ? error.message : 'Failed to synchronize the active theme.';
    }
  }

  return {
    registry,
    activeTheme,
    availableThemes,
    activeThemeId,
    activeAppearance,
    activeThemeLabel,
    pathNavigationProjectGradientEnabled,
    initialized,
    initializing,
    initializationError,
    modernUiEnabled,
    initializeThemeSystem,
    setActiveTheme,
    refreshUserThemes,
    resetToDefaultTheme,
    setModernUiEnabled
  };
});

function normalizeThemeId(themeId: string | null | undefined): string | null {
  if (typeof themeId !== 'string') {
    return null;
  }

  const normalized = themeId.trim();

  return normalized.length > 0 ? normalized : null;
}

/** 从内置贡献路径提取安全文件名，供用户主题物化使用。 */
function getThemeFileName(filePath: string, fallbackId: string): string {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop();
  return fileName?.endsWith('.json') ? fileName : `${fallbackId}.json`;
}
