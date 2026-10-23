/** 文件说明：管理编辑器字体回退列表与字号，并同步设置窗口和工作台编辑器。 */
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { appSettingsApi } from '@/api/appSettings';
import { APP_SETTING_KEYS, type AppSettingChangedEvent } from '@/types/appSettings';

const EDITOR_FONT_FAMILIES_KEY = APP_SETTING_KEYS.editorFontFamilies;
const EDITOR_FONT_SIZE_KEY = APP_SETTING_KEYS.editorFontSize;
const DEFAULT_EDITOR_FONT_FAMILIES = ['Arial'];
const DEFAULT_EDITOR_FONT_SIZE = '14';
const MAX_EDITOR_FONT_SIZE = 30;
const LEGACY_FONT_FAMILY_ALIASES: Readonly<Record<string, string>> = {
  'system-ui': 'Arial'
};

function normalizeFontFamilies(fontFamilies: readonly unknown[]): string[] {
  const normalized = fontFamilies
    .filter((fontFamily): fontFamily is string => typeof fontFamily === 'string')
    .map(fontFamily => fontFamily.trim())
    .map(fontFamily => LEGACY_FONT_FAMILY_ALIASES[fontFamily] ?? fontFamily)
    .filter(Boolean);
  return [...new Set(normalized)];
}

function parseFontFamilies(serialized: string | null): string[] {
  if (!serialized) return [...DEFAULT_EDITOR_FONT_FAMILIES];

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [...DEFAULT_EDITOR_FONT_FAMILIES];
    const fontFamilies = normalizeFontFamilies(parsed);
    return fontFamilies.length > 0 ? fontFamilies : [...DEFAULT_EDITOR_FONT_FAMILIES];
  } catch {
    return [...DEFAULT_EDITOR_FONT_FAMILIES];
  }
}

function normalizeFontSize(value: string | number): string {
  const digits = String(value).replace(/\D/gu, '').slice(0, 3);
  if (!digits) return DEFAULT_EDITOR_FONT_SIZE;
  return String(Math.min(Number(digits), MAX_EDITOR_FONT_SIZE));
}

function parseFontSize(serialized: string | null): string {
  return normalizeFontSize(serialized ?? DEFAULT_EDITOR_FONT_SIZE);
}

export const useEditorSettingsStore = defineStore('editorSettings', () => {
  const selectedFontFamilies = ref<string[]>([...DEFAULT_EDITOR_FONT_FAMILIES]);
  const editorFontSize = ref(DEFAULT_EDITOR_FONT_SIZE);
  const initialized = ref(false);
  let disposeSettingsListener: (() => void) | undefined;
  let initializationPromise: Promise<void> | undefined;

  const editorFontFamily = computed(() => selectedFontFamilies.value[0] ?? DEFAULT_EDITOR_FONT_FAMILIES[0]);

  function applySerializedFontFamilies(serialized: string | null): void {
    selectedFontFamilies.value = parseFontFamilies(serialized);
  }

  function applySerializedFontSize(serialized: string | null): void {
    editorFontSize.value = parseFontSize(serialized);
  }

  function handleSettingsChanged(event: AppSettingChangedEvent): void {
    if (event.key === EDITOR_FONT_FAMILIES_KEY) {
      applySerializedFontFamilies(event.value);
    }
    if (event.key === EDITOR_FONT_SIZE_KEY) {
      applySerializedFontSize(event.value);
    }
  }

  async function initialize(): Promise<void> {
    if (initialized.value) return;
    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
      disposeSettingsListener = appSettingsApi.onChanged(handleSettingsChanged);
      const [serializedFontFamilies, serializedFontSize] = await Promise.all([
        appSettingsApi.get(EDITOR_FONT_FAMILIES_KEY),
        appSettingsApi.get(EDITOR_FONT_SIZE_KEY)
      ]);
      applySerializedFontFamilies(serializedFontFamilies);
      applySerializedFontSize(serializedFontSize);
      initialized.value = true;
    })();

    try {
      await initializationPromise;
    } finally {
      initializationPromise = undefined;
    }
  }

  function setEditorFontSize(value: string | number): void {
    const digits = String(value).replace(/\D/gu, '').slice(0, 3);
    if (!digits) return;
    const normalized = String(Math.min(Number(digits), MAX_EDITOR_FONT_SIZE));
    if (editorFontSize.value === normalized) return;
    editorFontSize.value = normalized;
    void appSettingsApi.set(EDITOR_FONT_SIZE_KEY, normalized);
  }

  function persistFontFamilies(): void {
    void appSettingsApi.set(
      EDITOR_FONT_FAMILIES_KEY,
      JSON.stringify(selectedFontFamilies.value)
    );
  }

  function addFontFamily(fontFamily: string): void {
    const normalizedFontFamily = fontFamily.trim();
    if (!normalizedFontFamily || selectedFontFamilies.value.includes(normalizedFontFamily)) return;
    selectedFontFamilies.value = [...selectedFontFamilies.value, normalizedFontFamily];
    persistFontFamilies();
  }

  function removeFontFamily(index: number): void {
    if (selectedFontFamilies.value.length <= 1 || index < 0 || index >= selectedFontFamilies.value.length) {
      return;
    }
    selectedFontFamilies.value = selectedFontFamilies.value.filter((_, itemIndex) => itemIndex !== index);
    persistFontFamilies();
  }

  function moveFontFamily(sourceIndex: number, targetIndex: number): void {
    if (
      sourceIndex < 0
      || sourceIndex >= selectedFontFamilies.value.length
      || targetIndex < 0
      || targetIndex > selectedFontFamilies.value.length
      || sourceIndex === targetIndex
      || sourceIndex + 1 === targetIndex
    ) {
      return;
    }

    const nextFontFamilies = [...selectedFontFamilies.value];
    const [fontFamily] = nextFontFamilies.splice(sourceIndex, 1);
    const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    if (fontFamily === undefined) return;
    nextFontFamilies.splice(insertionIndex, 0, fontFamily);
    selectedFontFamilies.value = nextFontFamilies;
    persistFontFamilies();
  }

  function dispose(): void {
    disposeSettingsListener?.();
    disposeSettingsListener = undefined;
    initialized.value = false;
  }

  return {
    selectedFontFamilies,
    editorFontFamily,
    editorFontSize,
    initialized,
    initialize,
    setEditorFontSize,
    addFontFamily,
    removeFontFamily,
    moveFontFamily,
    dispose
  };
});
