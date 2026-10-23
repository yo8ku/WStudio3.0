import type { ThemeDefinition, ThemeInstance } from 'vuetify';

import { DEFAULT_THEME_IDS } from '@theme/core/resolver';
import type { ResolvedTheme } from '@theme/core/types';

import {
  createFallbackVuetifyThemeDefinition,
  mapThemeVariantToVuetifyDefinition
} from './mapTokensToVuetify';

export function createVuetifyBootstrapThemes(): Record<string, ThemeDefinition> {
  return {
    [DEFAULT_THEME_IDS.dark]: createFallbackVuetifyThemeDefinition('dark'),
    [DEFAULT_THEME_IDS.light]: createFallbackVuetifyThemeDefinition('light')
  };
}

export function applyResolvedThemeToVuetify(
  vuetifyTheme: ThemeInstance,
  resolvedTheme: ResolvedTheme
): void {
  const vuetifyThemeName = resolvedTheme.descriptor.id;

  vuetifyTheme.themes.value[vuetifyThemeName] = mapThemeVariantToVuetifyDefinition(
    resolvedTheme.loaded.variant
  );
  vuetifyTheme.change(vuetifyThemeName);
}
