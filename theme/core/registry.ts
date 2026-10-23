import { loadThemePackageManifests } from '@theme/core/manifestLoader';
import type {
  LoadedThemeManifest,
  LoadedThemeVariant,
  ThemeDescriptor,
  ThemeManifestContribution,
  ThemeRegistry,
  UserThemeEntry
} from '@theme/core/types';

export async function loadThemeRegistry(
  userThemes: readonly UserThemeEntry[] = []
): Promise<ThemeRegistry> {
  const manifests = await loadThemePackageManifests();

  return createThemeRegistry(manifests, userThemes);
}

export function createThemeRegistry(
  manifests: LoadedThemeManifest[],
  userThemes: readonly UserThemeEntry[] = []
): ThemeRegistry {
  const packagesById = new Map<string, LoadedThemeManifest>();
  const themesById = new Map<string, ThemeDescriptor>();
  const loadedVariantsById = new Map<string, LoadedThemeVariant>();
  const themes: ThemeDescriptor[] = [];

  for (const manifestEntry of manifests) {
    if (packagesById.has(manifestEntry.packageId)) {
      throw new Error(`Duplicate theme package id "${manifestEntry.packageId}" found.`);
    }

    packagesById.set(manifestEntry.packageId, manifestEntry);

    for (const contribution of manifestEntry.manifest.themes) {
      if (themesById.has(contribution.id)) {
        throw new Error(
          `Duplicate theme id "${contribution.id}" found across theme packages.`
        );
      }

      const descriptor: ThemeDescriptor = {
        packageId: manifestEntry.packageId,
        packageDirectory: manifestEntry.packageDirectory,
        manifestPath: manifestEntry.manifestPath,
        packageDisplayName: manifestEntry.manifest.displayName,
        id: contribution.id,
        label: contribution.label,
        appearance: contribution.appearance,
        file: contribution.file,
        source: 'builtin',
        category: manifestEntry.packageId
      };

      themes.push(descriptor);
      themesById.set(descriptor.id, descriptor);
    }
  }

  for (const userTheme of userThemes) {
    const descriptor: ThemeDescriptor = {
      packageId: 'user-themes',
      packageDirectory: userTheme.category,
      manifestPath: userTheme.relativePath,
      packageDisplayName: userTheme.category,
      id: userTheme.id,
      label: userTheme.variant.displayName,
      appearance: userTheme.variant.type,
      file: userTheme.relativePath,
      source: 'user',
      category: userTheme.category
    };
    const existingIndex = themes.findIndex(theme => theme.id === descriptor.id);
    if (existingIndex >= 0) {
      themes.splice(existingIndex, 1, descriptor);
    } else {
      themes.push(descriptor);
    }
    themesById.set(descriptor.id, descriptor);
    loadedVariantsById.set(descriptor.id, {
      packageId: 'user-themes',
      packageDirectory: userTheme.category,
      manifestPath: userTheme.relativePath,
      variantPath: userTheme.relativePath,
      contribution: createUserThemeContribution(userTheme),
      variant: userTheme.variant,
      source: 'user'
    });
  }

  const sortedThemes = themes.sort((left, right) =>
    `${left.packageDisplayName}:${left.label}`.localeCompare(
      `${right.packageDisplayName}:${right.label}`
    )
  );

  return {
    packages: manifests,
    packagesById,
    themes: sortedThemes,
    themesById,
    loadedVariantsById
  };
}

/** 将用户主题条目映射为与内置主题一致的贡献摘要。 */
function createUserThemeContribution(userTheme: UserThemeEntry): ThemeManifestContribution {
  return {
    id: userTheme.variant.id,
    label: userTheme.variant.displayName,
    appearance: userTheme.variant.type,
    file: userTheme.relativePath
  };
}
