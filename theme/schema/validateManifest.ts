import {
  THEME_APPEARANCES,
  type ThemeAppearance,
  type ThemeManifest,
  type ThemeManifestBugs,
  type ThemeManifestContribution,
  type ThemeManifestRepository
} from '@theme/core/types';

const themeAppearanceSet = new Set<string>(THEME_APPEARANCES);

export class ThemeManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly source: string,
    public readonly issues: string[]
  ) {
    super(message);
    this.name = 'ThemeManifestValidationError';
  }
}

export function validateThemeManifest(input: unknown, source = 'theme manifest'): ThemeManifest {
  const issues: string[] = [];

  if (!isPlainObject(input)) {
    throw new ThemeManifestValidationError(
      `Invalid theme manifest at "${source}".`,
      source,
      ['Root value must be a plain object.']
    );
  }

  const manifest: ThemeManifest = {
    id: readRequiredString(input, 'id', issues),
    name: readRequiredString(input, 'name', issues),
    displayName: readRequiredString(input, 'displayName', issues),
    version: readRequiredString(input, 'version', issues),
    themes: readThemeContributions(input.themes, source, issues)
  };

  const manifestRecord = manifest as unknown as Record<string, unknown>;

  assignOptionalString(manifestRecord, 'description', input.description, issues);
  assignOptionalString(manifestRecord, 'author', input.author, issues);
  assignOptionalString(manifestRecord, 'homepage', input.homepage, issues);
  assignOptionalString(manifestRecord, 'icon', input.icon, issues, normalizeLooseRelativePath);
  assignOptionalStringArray(manifestRecord, 'categories', input.categories, issues);
  assignOptionalStringArray(manifestRecord, 'keywords', input.keywords, issues);

  const repository = readOptionalRepository(input.repository, issues);

  if (repository) {
    manifest.repository = repository;
  }

  const bugs = readOptionalBugs(input.bugs, issues);

  if (bugs) {
    manifest.bugs = bugs;
  }

  if (issues.length > 0) {
    throw new ThemeManifestValidationError(`Invalid theme manifest at "${source}".`, source, issues);
  }

  return manifest;
}

function readThemeContributions(
  value: unknown,
  source: string,
  issues: string[]
): ThemeManifestContribution[] {
  if (!Array.isArray(value)) {
    issues.push('Field "themes" must be an array.');

    return [];
  }

  if (value.length === 0) {
    issues.push('Field "themes" must contain at least one theme contribution.');
  }

  const ids = new Set<string>();
  const files = new Set<string>();

  return value.map((entry, index) => {
    const path = `themes[${index}]`;

    if (!isPlainObject(entry)) {
      issues.push(`Field "${path}" must be a plain object.`);

      return {
        id: '',
        label: '',
        appearance: 'dark',
        file: ''
      };
    }

    const id = readRequiredString(entry, 'id', issues, path);
    const label = readRequiredString(entry, 'label', issues, path);
    const appearance = readRequiredAppearance(entry.appearance, `${path}.appearance`, issues);
    const file = readThemeFilePath(entry.file, `${path}.file`, issues);

    if (id && ids.has(id)) {
      issues.push(`Duplicate theme contribution id "${id}" in "${source}".`);
    }

    if (id) {
      ids.add(id);
    }

    if (file && files.has(file)) {
      issues.push(`Duplicate theme contribution file "${file}" in "${source}".`);
    }

    if (file) {
      files.add(file);
    }

    return {
      id,
      label,
      appearance,
      file
    };
  });
}

function readOptionalRepository(
  value: unknown,
  issues: string[]
): ThemeManifestRepository | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    issues.push('Field "repository" must be a plain object.');

    return undefined;
  }

  return {
    url: readRequiredString(value, 'url', issues, 'repository'),
    type: readRequiredString(value, 'type', issues, 'repository')
  };
}

function readOptionalBugs(value: unknown, issues: string[]): ThemeManifestBugs | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    issues.push('Field "bugs" must be a plain object.');

    return undefined;
  }

  return {
    url: readRequiredString(value, 'url', issues, 'bugs')
  };
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

function readThemeFilePath(value: unknown, fieldPath: string, issues: string[]): string {
  const normalized = readRequiredStringValue(value, fieldPath, issues, normalizeThemeFilePath);

  if (!normalized) {
    return '';
  }

  if (!normalized.startsWith('themes/')) {
    issues.push(`Field "${fieldPath}" must point to a file inside the "themes/" directory.`);
  }

  if (!normalized.endsWith('.json')) {
    issues.push(`Field "${fieldPath}" must point to a ".json" file.`);
  }

  return normalized;
}

function assignOptionalString(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  issues: string[],
  transform?: (value: string, fieldPath: string) => string
): void {
  if (value === undefined) {
    return;
  }

  const normalized = readRequiredStringValue(value, key, issues, transform);

  if (normalized) {
    target[key] = normalized;
  }
}

function assignOptionalStringArray(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  issues: string[]
): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    issues.push(`Field "${key}" must be an array of strings.`);

    return;
  }

  const strings = value.map((entry, index) =>
    readRequiredStringValue(entry, `${key}[${index}]`, issues)
  );

  target[key] = strings.filter((entry): entry is string => entry.length > 0);
}

function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  issues: string[],
  parentPath?: string
): string {
  const fieldPath = parentPath ? `${parentPath}.${key}` : key;

  return readRequiredStringValue(source[key], fieldPath, issues);
}

function readRequiredStringValue(
  value: unknown,
  fieldPath: string,
  issues: string[],
  transform?: (value: string, fieldPath: string) => string
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`Field "${fieldPath}" must be a non-empty string.`);

    return '';
  }

  let normalized = value.trim();

  if (transform) {
    try {
      normalized = transform(normalized, fieldPath);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `Field "${fieldPath}" is invalid.`);

      return '';
    }
  }

  if (normalized.length === 0) {
    issues.push(`Field "${fieldPath}" must be a non-empty string.`);
  }

  return normalized;
}

function normalizeThemeFilePath(value: string, fieldPath: string): string {
  const normalized = normalizeLooseRelativePath(value, fieldPath);

  return normalized;
}

function normalizeLooseRelativePath(value: string, fieldPath: string): string {
  const normalized = value.replace(/\\/g, '/').trim();

  if (normalized.startsWith('/')) {
    throw new Error(`Field "${fieldPath}" must be a relative path.`);
  }

  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Field "${fieldPath}" must not be an absolute Windows path.`);
  }

  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  if (segments.includes('..')) {
    throw new Error(`Field "${fieldPath}" must not contain ".." path segments.`);
  }

  return segments.join('/');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
