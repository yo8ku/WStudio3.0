/** Stores validated note property types in the SQLite-backed app settings service. */
import { ref } from 'vue';
import { defineStore } from 'pinia';

import { appSettingsApi } from '@/api/appSettings';
import { APP_SETTING_KEYS, type AppSettingChangedEvent } from '@/types/appSettings';
import {
  isValidNotePropertyName,
  type NotePropertyKey
} from '../../Editor/NoteProperties/notePropertyDefinitions.ts';
import {
  DEFAULT_NOTE_PROPERTY_TYPES,
  isNotePropertyType,
  type NotePropertyType
} from '../../Editor/NoteProperties/notePropertyTypes.ts';

const NOTE_PROPERTY_TYPES_KEY = APP_SETTING_KEYS.notePropertyTypes;

function parsePropertyTypes(serializedTypes: string | null): Record<NotePropertyKey, NotePropertyType> {
  if (!serializedTypes) return {};

  try {
    const parsedTypes: unknown = JSON.parse(serializedTypes);
    if (typeof parsedTypes !== 'object' || parsedTypes === null || Array.isArray(parsedTypes)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsedTypes).filter(([key, type]) => (
        isValidNotePropertyName(key) && isNotePropertyType(type)
      ))
    ) as Record<NotePropertyKey, NotePropertyType>;
  } catch {
    return {};
  }
}

export const useNotePropertyTypesStore = defineStore('notePropertyTypes', () => {
  const explicitPropertyTypes = ref<Record<NotePropertyKey, NotePropertyType>>({});
  const initialized = ref(false);
  let disposeSettingsListener: (() => void) | undefined;

  function applySerializedTypes(serializedTypes: string | null): void {
    explicitPropertyTypes.value = parsePropertyTypes(serializedTypes);
  }

  function handleSettingsChanged(event: AppSettingChangedEvent): void {
    if (event.key === NOTE_PROPERTY_TYPES_KEY) applySerializedTypes(event.value);
  }

  async function initialize(): Promise<void> {
    if (initialized.value) return;
    disposeSettingsListener = appSettingsApi.onChanged(handleSettingsChanged);
    applySerializedTypes(await appSettingsApi.get(NOTE_PROPERTY_TYPES_KEY));
    initialized.value = true;
  }

  function dispose(): void {
    disposeSettingsListener?.();
    disposeSettingsListener = undefined;
    initialized.value = false;
  }

  function getPropertyType(key: NotePropertyKey): NotePropertyType {
    return explicitPropertyTypes.value[key] ?? DEFAULT_NOTE_PROPERTY_TYPES[key] ?? 'list';
  }

  function hasExplicitPropertyType(key: NotePropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(explicitPropertyTypes.value, key);
  }

  function setPropertyType(key: NotePropertyKey, type: NotePropertyType): void {
    if (!isValidNotePropertyName(key)) return;

    explicitPropertyTypes.value = {
      ...explicitPropertyTypes.value,
      [key]: type
    };
    void appSettingsApi.set(NOTE_PROPERTY_TYPES_KEY, JSON.stringify(explicitPropertyTypes.value));
  }

  function copyPropertyType(currentKey: NotePropertyKey, nextKey: NotePropertyKey): void {
    if (!hasExplicitPropertyType(currentKey)) return;
    setPropertyType(nextKey, getPropertyType(currentKey));
  }

  return {
    explicitPropertyTypes,
    initialized,
    initialize,
    dispose,
    getPropertyType,
    hasExplicitPropertyType,
    setPropertyType,
    copyPropertyType
  };
});
