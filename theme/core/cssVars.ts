/**
 * 文件说明：负责将主题 JSON 中的颜色字段展开为运行时 CSS 变量，并注入到目标元素上。
 */
import type { ThemeColorTree, ThemeVariant } from '@theme/core/types';

export const THEME_CSS_VARIABLE_PREFIX = '--ws';

const appliedThemeVariables = new WeakMap<HTMLElement, string[]>();
const themeStyleRules = new WeakMap<Document, CSSStyleRule>();
const DERIVED_MERMAID_THEME_VARIABLES = [
  {
    name: '--ws-mermaid-lineColor',
    candidates: ['editor.tableBorder', 'border', 'foreground']
  },
  {
    name: '--ws-mermaid-dashedLineColor',
    candidates: ['editor.tableBorder', 'border', 'foreground']
  },
  {
    name: '--ws-mermaid-nodeForeground',
    candidates: ['editor.foreground', 'foreground']
  },
  {
    name: '--ws-mermaid-blockBackground',
    candidates: ['editor.overlayBackground', 'editor.tableBackground', 'editor.background', 'backgroundAccent']
  },
  {
    name: '--ws-mermaid-background',
    candidates: ['editor.background', 'background', 'backgroundAccent']
  },
  {
    name: '--ws-mermaid-edgeLabelBackground',
    candidates: ['editor.background', 'editor.overlayBackground', 'background']
  },
  {
    name: '--ws-mermaid-blockBorder',
    candidates: ['editor.tableBorder', 'border', 'foreground']
  }
] as const;
const DERIVED_ICON_BUTTON_THEME_VARIABLES = [
  {
    name: '--ws-icon-hoverBackground',
    candidates: ['icon.hoverBackground', 'button.hoverBackground', 'activityBar.hoverBackground']
  }
] as const;
const DERIVED_EDITOR_THEME_VARIABLES = [
  {
    name: '--ws-editor-cursor-foreground',
    candidates: ['editor.cursor.foreground', 'editor.caret.foreground', 'editor.foreground', 'foreground']
  }
] as const;
const DERIVED_SELECT_THEME_VARIABLES = [
  {
    name: '--ws-select-background',
    candidates: ['select.background', 'sideBar.background', 'backgroundAccent', 'background']
  },
  {
    name: '--ws-select-foreground',
    candidates: ['select.foreground', 'input.foreground', 'sideBar.foreground', 'foreground']
  },
  {
    name: '--ws-select-border',
    candidates: ['select.border', 'input.focusBorder', 'focusBorder', 'border']
  },
  {
    name: '--ws-select-hover-background',
    candidates: ['select.hoverBackground', 'list.hoverBackground', 'setting.hoverBackground', 'backgroundAccent']
  }
] as const;
const DERIVED_DIFF_THEME_VARIABLES = [
  {
    name: '--ws-diff-foreground',
    candidates: ['diff.foreground'],
    fallback: '#a3a3a3'
  },
  {
    name: '--ws-diff-background',
    candidates: [
      'diff.background',
      'inlineEditor.background',
      'editor.background',
      'input.background',
      'background'
    ]
  }
] as const;

/** 将主题颜色树展开为运行时 CSS 变量，并补齐派生变量。 */
export function flattenThemeColorsToCssVariables(
  colors: ThemeColorTree
): Record<string, string> {
  const cssVariables: Record<string, string> = {};

  appendThemeColorBranch(colors, [], cssVariables);
  appendDerivedEditorThemeVariables(colors, cssVariables);
  appendDerivedMermaidThemeVariables(colors, cssVariables);
  appendDerivedIconButtonThemeVariables(colors, cssVariables);
  appendDerivedSelectThemeVariables(colors, cssVariables);
  appendDerivedDiffThemeVariables(colors, cssVariables);
  appendDerivedDialogThemeVariables(colors, cssVariables);

  return cssVariables;
}

function appendDerivedSelectThemeVariables(
  colors: ThemeColorTree,
  cssVariables: Record<string, string>
): void {
  for (const variable of DERIVED_SELECT_THEME_VARIABLES) {
    if (cssVariables[variable.name] !== undefined) continue;

    const value = resolveThemeColorToken(colors, variable.candidates);
    if (value !== null) cssVariables[variable.name] = value;
  }
}

/** Ensures shared dialog surfaces always expose title and body background variables. */
function appendDerivedDialogThemeVariables(
  colors: ThemeColorTree,
  cssVariables: Record<string, string>
): void {
  if (cssVariables['--ws-dialog-background'] === undefined) {
    const background = resolveThemeColorToken(colors, ['dialog.background', 'background']);
    if (background !== null) cssVariables['--ws-dialog-background'] = background;
  }

  if (cssVariables['--ws-dialog-titleBackground'] === undefined) {
    const titleBackground = resolveThemeColorToken(colors, [
      'dialog.titleBackground',
      'dialog.background',
      'titleBar.activeBackground',
      'background'
    ]);
    if (titleBackground !== null) cssVariables['--ws-dialog-titleBackground'] = titleBackground;
  }
}

function appendDerivedDiffThemeVariables(
  colors: ThemeColorTree,
  cssVariables: Record<string, string>
): void {
  for (const variable of DERIVED_DIFF_THEME_VARIABLES) {
    if (cssVariables[variable.name] !== undefined) continue;

    const value = resolveThemeColorToken(colors, variable.candidates);
    if (value !== null) {
      cssVariables[variable.name] = value;
    } else if ('fallback' in variable) {
      cssVariables[variable.name] = variable.fallback;
    }
  }
}

/** 将主题变量应用到指定元素，并清理旧主题残留变量。 */
export function applyThemeVariantToElement(
  variant: ThemeVariant,
  element: HTMLElement
): Record<string, string> {
  const cssVariables = flattenThemeColorsToCssVariables(variant.colors);
  const nextVariableNames = Object.keys(cssVariables);
  const themeStyleRule = getThemeStyleRule(element);

  if (themeStyleRule) {
    for (const variableName of appliedThemeVariables.get(element) ?? []) {
      element.style.removeProperty(variableName);
    }

    themeStyleRule.style.cssText = '';

    for (const [variableName, variableValue] of Object.entries(cssVariables)) {
      themeStyleRule.style.setProperty(variableName, variableValue);
    }

    themeStyleRule.style.setProperty('color-scheme', variant.type);
    element.style.removeProperty('color-scheme');
    appliedThemeVariables.set(element, nextVariableNames);
    element.dataset.themeId = variant.id;
    element.dataset.themeAppearance = variant.type;

    return cssVariables;
  }

  const previousVariableNames = appliedThemeVariables.get(element) ?? [];
  const nextVariableNameSet = new Set<string>(nextVariableNames);

  for (const variableName of previousVariableNames) {
    if (!nextVariableNameSet.has(variableName)) {
      element.style.removeProperty(variableName);
    }
  }

  for (const [variableName, variableValue] of Object.entries(cssVariables)) {
    element.style.setProperty(variableName, variableValue);
  }

  element.dataset.themeId = variant.id;
  element.dataset.themeAppearance = variant.type;
  element.style.setProperty('color-scheme', variant.type);

  appliedThemeVariables.set(element, nextVariableNames);

  return cssVariables;
}

/** 清除指定元素上由主题系统注入的运行时变量。 */
export function clearThemeVariantFromElement(element: HTMLElement): void {
  const themeStyleRule = getExistingThemeStyleRule(element);

  if (themeStyleRule) {
    themeStyleRule.style.cssText = '';
    for (const variableName of appliedThemeVariables.get(element) ?? []) {
      element.style.removeProperty(variableName);
    }
    element.style.removeProperty('color-scheme');
    delete element.dataset.themeId;
    delete element.dataset.themeAppearance;
    appliedThemeVariables.delete(element);

    return;
  }

  const previousVariableNames = appliedThemeVariables.get(element) ?? [];

  for (const variableName of previousVariableNames) {
    element.style.removeProperty(variableName);
  }

  delete element.dataset.themeId;
  delete element.dataset.themeAppearance;
  element.style.removeProperty('color-scheme');
  appliedThemeVariables.delete(element);
}

/**
 * 为根文档创建可构造样式表，避免把完整主题变量集合写入 html 内联 style。
 * 非根元素或不支持 adoptedStyleSheets 的环境返回 null，继续使用兼容路径。
 */
function getThemeStyleRule(element: HTMLElement): CSSStyleRule | null {
  const ownerDocument = element.ownerDocument;

  if (element !== ownerDocument.documentElement || !('adoptedStyleSheets' in ownerDocument)) {
    return null;
  }

  const existingRule = themeStyleRules.get(ownerDocument);
  if (existingRule) return existingRule;

  try {
    const sheet = new CSSStyleSheet();
    sheet.insertRule(':root {}');
    ownerDocument.adoptedStyleSheets = [...ownerDocument.adoptedStyleSheets, sheet];

    const rule = sheet.cssRules.item(0);
    if (!rule || !('style' in rule)) return null;

    const styleRule = rule as CSSStyleRule;
    themeStyleRules.set(ownerDocument, styleRule);

    return styleRule;
  } catch {
    return null;
  }
}

function getExistingThemeStyleRule(element: HTMLElement): CSSStyleRule | null {
  if (element !== element.ownerDocument.documentElement) return null;

  return themeStyleRules.get(element.ownerDocument) ?? null;
}

/** 将主题 token 路径转换为工作台 CSS 变量名。 */
export function tokenPathToCssVariable(tokenPath: string[]): string {
  const normalizedSegments = tokenPath
    .map(normalizeTokenSegment)
    .filter((segment) => segment.length > 0);

  if (normalizedSegments.length === 0) {
    throw new Error('Theme token path must contain at least one valid segment.');
  }

  return `${THEME_CSS_VARIABLE_PREFIX}-${normalizedSegments.join('-')}`;
}

/** 递归展开主题颜色树。 */
function appendThemeColorBranch(
  branch: ThemeColorTree,
  tokenPath: string[],
  cssVariables: Record<string, string>
): void {
  for (const [token, value] of Object.entries(branch)) {
    const nextTokenPath = [...tokenPath, token];

    if (typeof value === 'string') {
      cssVariables[tokenPathToCssVariable(nextTokenPath)] = value;

      continue;
    }

    appendThemeColorBranch(value, nextTokenPath, cssVariables);
  }
}

/** 为 Mermaid 提供可覆盖的默认主题变量，避免图表颜色绑定到通用编辑器变量。 */
function appendDerivedMermaidThemeVariables(
  colors: ThemeColorTree,
  cssVariables: Record<string, string>
): void {
  for (const variable of DERIVED_MERMAID_THEME_VARIABLES) {
    if (cssVariables[variable.name] !== undefined) {
      continue;
    }

    const value = resolveThemeColorToken(colors, variable.candidates);
    if (value !== null) {
      cssVariables[variable.name] = value;
    }
  }
}

/** 为编辑器提供稳定的光标变量，并兼容旧主题中的 caret token。 */
function appendDerivedEditorThemeVariables(
  colors: ThemeColorTree,
  cssVariables: Record<string, string>
): void {
  for (const variable of DERIVED_EDITOR_THEME_VARIABLES) {
    if (cssVariables[variable.name] !== undefined) {
      continue;
    }

    const value = resolveThemeColorToken(colors, variable.candidates);
    if (value !== null) {
      cssVariables[variable.name] = value;
    }
  }
}

/** 为全局图标按钮提供稳定的悬停背景变量，避免透明色受容器底色影响。 */
function appendDerivedIconButtonThemeVariables(
  colors: ThemeColorTree,
  cssVariables: Record<string, string>
): void {
  for (const variable of DERIVED_ICON_BUTTON_THEME_VARIABLES) {
    if (cssVariables[variable.name] !== undefined) {
      continue;
    }

    const value = resolveThemeColorToken(colors, variable.candidates);
    if (value !== null) {
      cssVariables[variable.name] = value;
    }
  }
}

/** 按候选路径读取第一个可用颜色 token。 */
function resolveThemeColorToken(
  colors: ThemeColorTree,
  candidatePaths: readonly string[]
): string | null {
  for (const candidatePath of candidatePaths) {
    const resolved = readThemeColorToken(colors, candidatePath);
    if (resolved !== null) {
      return resolved;
    }
  }

  return null;
}

/** 从颜色树读取点分路径对应的颜色值。 */
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

/** 规范化主题 token 片段，保证生成的 CSS 变量名稳定。 */
function normalizeTokenSegment(segment: string): string {
  return segment
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}
