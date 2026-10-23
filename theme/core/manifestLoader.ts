import type { LoadedThemeManifest } from '@theme/core/types';
import { validateThemeManifest } from '@theme/schema/validateManifest';

const manifestModules = import.meta.glob<unknown>('../packages/*/manifest.json', {
  import: 'default'
});

const manifestPathPattern = /^\.\.\/packages\/([^/]+)\/manifest\.json$/;

export async function loadThemePackageManifests(): Promise<LoadedThemeManifest[]> {
  const manifests = await Promise.all(
    Object.entries(manifestModules).map(async ([manifestPath, loadManifest]) => {
      const packageDirectory = extractPackageDirectory(manifestPath);
      const manifest = validateThemeManifest(await loadManifest(), manifestPath);

      return {
        packageId: manifest.id,
        packageDirectory,
        manifestPath,
        manifest
      };
    })
  );

  const packageIds = new Set<string>();

  for (const entry of manifests) {
    if (packageIds.has(entry.packageId)) {
      throw new Error(`Duplicate theme package id "${entry.packageId}" found in "${entry.manifestPath}".`);
    }

    packageIds.add(entry.packageId);
  }

  return manifests.sort((left, right) => left.packageId.localeCompare(right.packageId));
}

export async function loadThemePackageManifest(
  packageId: string
): Promise<LoadedThemeManifest | undefined> {
  const manifests = await loadThemePackageManifests();

  return manifests.find((entry) => entry.packageId === packageId);
}

function extractPackageDirectory(manifestPath: string): string {
  const match = manifestPath.match(manifestPathPattern);

  if (!match) {
    throw new Error(`Unsupported theme manifest path "${manifestPath}".`);
  }

  return match[1];
}
