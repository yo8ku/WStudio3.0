/**
 * 文件说明：将工作台主题字段映射为 Vuetify 运行时主题定义，供组件库内部配色使用。
 */
import type { ThemeColorTree, ThemeVariant } from '@theme/core/types';

export interface VuetifyRuntimeThemeDefinition {
  dark: boolean;
  colors: VuetifyRuntimeThemeColors;
  variables: Record<string, string | number>;
}

export interface VuetifyRuntimeThemeColors {
  background: string;
  surface: string;
  'surface-bright': string;
  'surface-light': string;
  'surface-variant': string;
  primary: string;
  secondary: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  'on-background': string;
  'on-surface': string;
  'on-surface-variant': string;
  'on-primary': string;
  'on-secondary': string;
  'on-success': string;
  'on-warning': string;
  'on-error': string;
  'on-info': string;
  [key: string]: string;
}

const DARK_FALLBACKS = {
  background: 'rgb(9 14 28)',
  surface: 'rgb(15 23 42)',
  surfaceBright: 'rgb(226 232 240)',
  surfaceLight: 'rgb(51 65 85)',
  surfaceVariant: 'rgb(100 116 139)',
  foreground: 'rgb(226 232 240)',
  primary: 'rgb(56 189 248)',
  secondary: 'rgb(30 41 59)',
  success: 'rgb(34 197 94)',
  warning: 'rgb(245 158 11)',
  error: 'rgb(196 43 28)',
  info: 'rgb(14 165 233)'
} as const;

const LIGHT_FALLBACKS = {
  background: 'rgb(248 250 252)',
  surface: 'rgb(255 255 255)',
  surfaceBright: 'rgb(255 255 255)',
  surfaceLight: 'rgb(241 245 249)',
  surfaceVariant: 'rgb(100 116 139)',
  foreground: 'rgb(15 23 42)',
  primary: 'rgb(37 99 235)',
  secondary: 'rgb(241 245 249)',
  success: 'rgb(22 163 74)',
  warning: 'rgb(217 119 6)',
  error: 'rgb(220 38 38)',
  info: 'rgb(2 132 199)'
} as const;

export function mapThemeVariantToVuetifyDefinition(
  variant: ThemeVariant
): VuetifyRuntimeThemeDefinition {
  const dark = variant.type === 'dark';
  const fallbacks = dark ? DARK_FALLBACKS : LIGHT_FALLBACKS;
  const foreground = resolveThemeColorToken(variant.colors, ['foreground'], fallbacks.foreground);
  const background = resolveThemeColorToken(variant.colors, ['background'], fallbacks.background);
  const surface = resolveThemeColorToken(
    variant.colors,
    ['backgroundAccent', 'panel.background', 'sideBar.background', 'background'],
    fallbacks.surface
  );
  const surfaceBright = resolveThemeColorToken(
    variant.colors,
    ['foreground'],
    fallbacks.surfaceBright
  );
  const surfaceLight = resolveThemeColorToken(
    variant.colors,
    ['backgroundAccent', 'button.background', 'panel.background', 'background'],
    fallbacks.surfaceLight
  );
  const surfaceVariant = resolveThemeColorToken(
    variant.colors,
    ['border', 'button.border', 'input.border', 'backgroundAccent'],
    fallbacks.surfaceVariant
  );
  const primary = resolveThemeColorToken(
    variant.colors,
    ['focusBorder', 'activityBar.activeBorder', 'button.background'],
    fallbacks.primary
  );
  const secondary = resolveThemeColorToken(
    variant.colors,
    ['button.background', 'backgroundAccent', 'panel.background', 'background'],
    fallbacks.secondary
  );
  const success = resolveThemeColorToken(variant.colors, ['successForeground'], fallbacks.success);
  const warning = resolveThemeColorToken(
    variant.colors,
    ['warningForeground'],
    fallbacks.warning
  );
  const error = resolveThemeColorToken(
    variant.colors,
    ['errorForeground', 'danger.background'],
    fallbacks.error
  );
  const info = resolveThemeColorToken(variant.colors, ['infoForeground', 'focusBorder'], fallbacks.info);
  const onPrimary = resolveThemeColorToken(
    variant.colors,
    ['button.foreground', 'foreground'],
    foreground
  );
  const borderColor = resolveThemeColorToken(
    variant.colors,
    ['border', 'panel.border', 'sideBar.border', 'statusBar.border'],
    dark ? 'rgb(71 85 105)' : 'rgb(203 213 225)'
  );

  return {
    dark,
    colors: {
      background,
      surface,
      'surface-bright': surfaceBright,
      'surface-light': surfaceLight,
      'surface-variant': surfaceVariant,
      primary,
      secondary,
      success,
      warning,
      error,
      info,
      'on-background': foreground,
      'on-surface': foreground,
      'on-surface-variant': foreground,
      'on-primary': onPrimary,
      'on-secondary': foreground,
      'on-success': foreground,
      'on-warning': foreground,
      'on-error': foreground,
      'on-info': foreground
    },
    variables: {
      'border-color': borderColor,
      'border-opacity': dark ? 0.78 : 1,
      'high-emphasis-opacity': 1,
      'medium-emphasis-opacity': dark ? 0.7 : 0.74,
      'disabled-opacity': 0.44,
      'hover-opacity': 0.08,
      'pressed-opacity': 0.12,
      'focus-opacity': 0.12,
      'selected-opacity': 0.12
    }
  };
}

export function createFallbackVuetifyThemeDefinition(
  appearance: 'dark' | 'light'
): VuetifyRuntimeThemeDefinition {
  const dark = appearance === 'dark';
  const fallbacks = dark ? DARK_FALLBACKS : LIGHT_FALLBACKS;

  return {
    dark,
    colors: {
      background: fallbacks.background,
      surface: fallbacks.surface,
      'surface-bright': fallbacks.surfaceBright,
      'surface-light': fallbacks.surfaceLight,
      'surface-variant': fallbacks.surfaceVariant,
      primary: fallbacks.primary,
      secondary: fallbacks.secondary,
      success: fallbacks.success,
      warning: fallbacks.warning,
      error: fallbacks.error,
      info: fallbacks.info,
      'on-background': fallbacks.foreground,
      'on-surface': fallbacks.foreground,
      'on-surface-variant': fallbacks.foreground,
      'on-primary': fallbacks.foreground,
      'on-secondary': fallbacks.foreground,
      'on-success': fallbacks.foreground,
      'on-warning': fallbacks.foreground,
      'on-error': fallbacks.foreground,
      'on-info': fallbacks.foreground
    },
    variables: {
      'border-color': dark ? 'rgb(71 85 105)' : 'rgb(203 213 225)',
      'border-opacity': dark ? 0.78 : 1
    }
  };
}

function resolveThemeColorToken(
  colors: ThemeColorTree,
  candidatePaths: string[],
  fallback: string
): string {
  for (const candidatePath of candidatePaths) {
    const resolved = readThemeColorToken(colors, candidatePath);

    if (resolved) {
      return resolved;
    }
  }

  return fallback;
}

function readThemeColorToken(colors: ThemeColorTree, tokenPath: string): string | null {
  const pathSegments = tokenPath.split('.');
  let current: string | ThemeColorTree | undefined = colors;

  for (const segment of pathSegments) {
    if (typeof current === 'string' || current === undefined) {
      return null;
    }

    current = current[segment];
  }

  if (typeof current !== 'string') {
    return null;
  }

  const normalized = current.trim();

  return normalized.length > 0 ? normalized : null;
}
