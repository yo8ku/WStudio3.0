export const THEME_APPEARANCES = ['light', 'dark'] as const;

export type ThemeAppearance = (typeof THEME_APPEARANCES)[number];

/** 标识主题来自源码内置包还是用户数据目录。 */
export type ThemeSource = 'builtin' | 'user';

export interface ThemeColorTree {
  [token: string]: string | ThemeColorTree;
}

export interface ThemeManifestRepository {
  url: string;
  type: string;
}

export interface ThemeManifestBugs {
  url: string;
}

export interface ThemeManifestContribution {
  id: string;
  label: string;
  appearance: ThemeAppearance;
  file: string;
}

/** 定义路径导航可由主题选择启用的视觉效果。 */
export interface ThemePathNavigationEffects {
  projectGradient: boolean;
}

/** 定义不属于颜色令牌的主题视觉效果。 */
export interface ThemeEffects {
  pathNavigation: ThemePathNavigationEffects;
}

export interface ThemeManifest {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description?: string;
  author?: string;
  icon?: string;
  categories?: string[];
  homepage?: string;
  repository?: ThemeManifestRepository;
  bugs?: ThemeManifestBugs;
  keywords?: string[];
  themes: ThemeManifestContribution[];
}

export interface ThemeVariant {
  id: string;
  name: string;
  displayName: string;
  type: ThemeAppearance;
  effects: ThemeEffects;
  colors: ThemeColorTree;
}

export interface LoadedThemeManifest {
  packageId: string;
  packageDirectory: string;
  manifestPath: string;
  manifest: ThemeManifest;
}

export interface LoadedThemeVariant {
  packageId: string;
  packageDirectory: string;
  manifestPath: string;
  variantPath: string;
  contribution: ThemeManifestContribution;
  variant: ThemeVariant;
  source: ThemeSource;
}

/** 主进程扫描并校验后返回给渲染进程的用户主题条目。 */
export interface UserThemeEntry {
  id: string;
  category: string;
  relativePath: string;
  variant: ThemeVariant;
}

export interface ThemeDescriptor {
  packageId: string;
  packageDirectory: string;
  manifestPath: string;
  packageDisplayName: string;
  id: string;
  label: string;
  appearance: ThemeAppearance;
  file: string;
  source: ThemeSource;
  category: string;
}

export interface ThemeRegistry {
  packages: LoadedThemeManifest[];
  packagesById: Map<string, LoadedThemeManifest>;
  themes: ThemeDescriptor[];
  themesById: Map<string, ThemeDescriptor>;
  loadedVariantsById: Map<string, LoadedThemeVariant>;
}

export type ThemeResolutionReason =
  | 'requested'
  | 'preferred-appearance'
  | 'default-builtin'
  | 'first-available';

export interface ResolvedThemeSelection {
  descriptor: ThemeDescriptor;
  reason: ThemeResolutionReason;
}

export interface ResolvedTheme {
  selection: ResolvedThemeSelection;
  descriptor: ThemeDescriptor;
  loaded: LoadedThemeVariant;
}
