/** Typed application preference keys shared by the renderer and Rust host. */

export const APP_SETTING_KEYS = {
  activeThemeId: 'wstudio.theme.activeThemeId',
  modernUiEnabled: 'wstudio.appearance.modernUiEnabled',
  notePropertyTypes: 'wstudio.note-property-types.v1',
  inlineChatSelectedModel: 'wstudio.inline-chat.selected-model',
  shortcutBindings: 'wstudio.shortcuts.bindings.v1',
  editorFontFamilies: 'wstudio.editor.font-families.v1',
  editorFontSize: 'wstudio.editor.font-size.v1'
} as const;

export type AppSettingKey = typeof APP_SETTING_KEYS[keyof typeof APP_SETTING_KEYS];

export interface AppSettingChangedEvent {
  key: AppSettingKey;
  value: string | null;
}
