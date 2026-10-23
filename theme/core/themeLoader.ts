import type {
  LoadedThemeManifest,
  LoadedThemeVariant,
  ThemeManifestContribution
} from '@theme/core/types';
import { validateThemeFile } from '@theme/schema/validateThemeFile';

const themeModules = import.meta.glob<unknown>('../packages/*/themes/*.json', {
  import: 'default'
});

export async function loadThemeVariant(
  manifestEntry: LoadedThemeManifest,
  themeId: string
): Promise<LoadedThemeVariant> {
  const contribution = manifestEntry.manifest.themes.find((item) => item.id === themeId);

  if (!contribution) {
    throw new Error(
      `Theme "${themeId}" is not declared in package "${manifestEntry.packageId}".`
    );
  }

  return loadThemeVariantByContribution(manifestEntry, contribution);
}

export async function loadThemeVariantByContribution(
  manifestEntry: LoadedThemeManifest,
  contribution: ThemeManifestContribution
): Promise<LoadedThemeVariant> {
  const variantPath = resolveVariantPath(manifestEntry.packageDirectory, contribution.file);
  const loadVariantModule = themeModules[variantPath];

  if (!loadVariantModule) {
    throw new Error(
      `Theme file "${contribution.file}" for package "${manifestEntry.packageId}" was not found.`
    );
  }

  const variant = validateThemeFile(await loadVariantModule(), variantPath);

  if (variant.id !== contribution.id) {
    throw new Error(
      `Theme variant id mismatch: manifest declares "${contribution.id}", but "${variantPath}" exports "${variant.id}".`
    );
  }

  if (variant.type !== contribution.appearance) {
    throw new Error(
      `Theme variant appearance mismatch: manifest declares "${contribution.appearance}", but "${variantPath}" exports "${variant.type}".`
    );
  }

  return {
    packageId: manifestEntry.packageId,
    packageDirectory: manifestEntry.packageDirectory,
    manifestPath: manifestEntry.manifestPath,
    variantPath,
    contribution,
    variant,
    source: 'builtin'
  };
}

export async function loadThemeVariantsForPackage(
  manifestEntry: LoadedThemeManifest
): Promise<LoadedThemeVariant[]> {
  return Promise.all(
    manifestEntry.manifest.themes.map((contribution) =>
      loadThemeVariantByContribution(manifestEntry, contribution)
    )
  );
}

function resolveVariantPath(packageDirectory: string, relativeFilePath: string): string {
  return `../packages/${packageDirectory}/${relativeFilePath}`;
}
