import {
  THEME_APPEARANCES,
  type ThemeAppearance,
  type ThemeColorTree,
  type ThemeEffects,
  type ThemeVariant
} from '../core/types';

const themeAppearanceSet = new Set<string>(THEME_APPEARANCES);

export class ThemeFileValidationError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly issues: string[]
  ) {
    super(message);
    this.name = 'ThemeFileValidationError';
  }
}

export function validateThemeFile(input: unknown, source = 'theme file'): ThemeVariant {
  const issues: string[] = [];

  if (!isPlainObject(input)) {
    throw new ThemeFileValidationError(`Invalid theme file at "${source}".`, source, [
      'Root value must be a plain object.'
    ]);
  }

  const variant: ThemeVariant = {
    id: readRequiredString(input, 'id', issues),
    name: readRequiredString(input, 'name', issues),
    displayName: readRequiredString(input, 'displayName', issues),
    type: readRequiredAppearance(input.type, 'type', issues),
    effects: readThemeEffects(input.effects, 'effects', issues),
    colors: readColorsTree(input.colors, 'colors', issues)
  };

  if (issues.length > 0) {
    throw new ThemeFileValidationError(`Invalid theme file at "${source}".`, source, issues);
  }

  return variant;
}

/** 读取主题视觉效果，并让未声明的路径导航渐变默认保持关闭。 */
function readThemeEffects(
  value: unknown,
  fieldPath: string,
  issues: string[]
): ThemeEffects {
  const defaultEffects: ThemeEffects = {
    pathNavigation: {
      projectGradient: false
    }
  };

  if (value === undefined) return defaultEffects;
  if (!isPlainObject(value)) {
    issues.push(`Field "${fieldPath}" must be a plain object.`);

    return defaultEffects;
  }

  const pathNavigation = value.pathNavigation;
  if (pathNavigation === undefined) return defaultEffects;
  if (!isPlainObject(pathNavigation)) {
    issues.push(`Field "${fieldPath}.pathNavigation" must be a plain object.`);

    return defaultEffects;
  }

  const projectGradient = pathNavigation.projectGradient;
  if (projectGradient === undefined) return defaultEffects;
  if (typeof projectGradient !== 'boolean') {
    issues.push(`Field "${fieldPath}.pathNavigation.projectGradient" must be a boolean.`);

    return defaultEffects;
  }

  return {
    pathNavigation: {
      projectGradient
    }
  };
}

function readColorsTree(
  value: unknown,
  fieldPath: string,
  issues: string[]
): ThemeColorTree {
  if (!isPlainObject(value)) {
    issues.push(`Field "${fieldPath}" must be a plain object.`);

    return {};
  }

  return Object.entries(value).reduce<ThemeColorTree>((tree, [key, entry]) => {
    const tokenPath = `${fieldPath}.${key}`;

    if (typeof entry === 'string') {
      const normalized = entry.trim();

      if (normalized.length === 0) {
        issues.push(`Field "${tokenPath}" must not be an empty string.`);
      } else {
        tree[key] = normalized;
      }

      return tree;
    }

    if (isPlainObject(entry)) {
      tree[key] = readColorsTree(entry, tokenPath, issues);

      return tree;
    }

    issues.push(`Field "${tokenPath}" must be a string or a nested object.`);

    return tree;
  }, {});
}

function readRequiredAppearance(
  value: unknown,
  fieldPath: string,
  issues: string[]
): ThemeAppearance {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`Field "${fieldPath}" must be a non-empty string.`);

    return 'dark';
  }

  if (!themeAppearanceSet.has(value)) {
    issues.push(
      `Field "${fieldPath}" must be one of: ${THEME_APPEARANCES.map((item) => `"${item}"`).join(', ')}.`
    );

    return 'dark';
  }

  return value as ThemeAppearance;
}

function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  issues: string[]
): string {
  const value = source[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`Field "${key}" must be a non-empty string.`);

    return '';
  }

  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
