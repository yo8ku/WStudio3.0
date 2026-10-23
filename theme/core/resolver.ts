import { loadThemeVariant } from '@theme/core/themeLoader';
import type {
  ResolvedTheme,
  ResolvedThemeSelection,
  ThemeAppearance,
  ThemeRegistry
} from '@theme/core/types';

export const DEFAULT_THEME_IDS: Record<ThemeAppearance, string> = {
  dark: 'wstudio-dark',
  light: 'wstudio-light'
};

export interface ResolveThemeOptions {
  themeId?: string | null;
  preferredAppearance?: ThemeAppearance;
}

export function resolveThemeDescriptor(
  registry: ThemeRegistry,
  options: ResolveThemeOptions = {}
): ResolvedThemeSelection {
  if (registry.themes.length === 0) {
    throw new Error('No theme variants are registered.');
  }

  const requestedThemeId = normalizeThemeId(options.themeId);
  const preferredAppearance = options.preferredAppearance ?? 'dark';

  if (requestedThemeId) {
    const requestedDescriptor = registry.themesById.get(requestedThemeId);

    if (requestedDescriptor) {
      return {
        descriptor: requestedDescriptor,
        reason: 'requested'
      };
    }
  }

  const builtinDescriptor = registry.themesById.get(DEFAULT_THEME_IDS[preferredAppearance]);

  if (builtinDescriptor) {
    return {
      descriptor: builtinDescriptor,
      reason: requestedThemeId ? 'default-builtin' : 'preferred-appearance'
    };
  }

  const appearanceDescriptor = registry.themes.find(
    (theme) => theme.appearance === preferredAppearance
  );

  if (appearanceDescriptor) {
    return {
      descriptor: appearanceDescriptor,
      reason: 'preferred-appearance'
    };
  }

  return {
    descriptor: registry.themes[0],
    reason: 'first-available'
  };
}

export async function resolveTheme(
  registry: ThemeRegistry,
  options: ResolveThemeOptions = {}
): Promise<ResolvedTheme> {
  const selection = resolveThemeDescriptor(registry, options);
  const userLoadedVariant = registry.loadedVariantsById.get(selection.descriptor.id);
  if (userLoadedVariant) {
    return {
      selection,
      descriptor: selection.descriptor,
      loaded: userLoadedVariant
    };
  }
  const manifestEntry = registry.packagesById.get(selection.descriptor.packageId);

  if (!manifestEntry) {
    throw new Error(
      `Theme package "${selection.descriptor.packageId}" is missing from the registry.`
    );
  }

  const loaded = await loadThemeVariant(manifestEntry, selection.descriptor.id);

  return {
    selection,
    descriptor: selection.descriptor,
    loaded
  };
}

function normalizeThemeId(themeId: string | null | undefined): string | null {
  if (typeof themeId !== 'string') {
    return null;
  }

  const normalized = themeId.trim();

  return normalized.length > 0 ? normalized : null;
}
