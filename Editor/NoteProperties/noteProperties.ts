/**
 * 文件说明：解析、读取和更新 Markdown YAML Frontmatter，并保持正文与未知属性不丢失。
 */
import { Document, isMap, isNode, parseDocument } from 'yaml';

import {
  isValidNotePropertyName,
  normalizeNotePropertyName,
  type NotePropertyKey
} from './notePropertyDefinitions.ts';

/** Markdown Frontmatter 在原文中的结构边界。 */
interface FrontmatterBoundary {
  readonly bodyStart: number;
  readonly yamlEnd: number;
  readonly yamlStart: number;
}

/** 供属性视图和编辑器适配层使用的文档快照。 */
export interface NoteDocumentSnapshot {
  readonly body: string;
  readonly bodyStart: number;
  readonly hasFrontmatter: boolean;
  readonly invalidFrontmatter: boolean;
  readonly propertyKeys: readonly NotePropertyKey[];
  readonly presentPropertyKeys: ReadonlySet<NotePropertyKey>;
  readonly properties: Readonly<Partial<Record<NotePropertyKey, readonly string[]>>>;
}

/** 笔记属性名称排序方向。 */
export type NotePropertySortDirection = 'ascending' | 'descending';

const OPENING_BOUNDARY_PATTERN = /^---[\t ]*\r?\n/;
const CLOSING_BOUNDARY_PATTERN = /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/gm;
const NOTE_PROPERTY_NAME_COLLATOR = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base'
});

/** 定位文档开头完整 Frontmatter 的 YAML 与正文边界。 */
function locateFrontmatter(markdown: string): FrontmatterBoundary | undefined {
  const openingBoundary = OPENING_BOUNDARY_PATTERN.exec(markdown);

  if (!openingBoundary) {
    return undefined;
  }

  CLOSING_BOUNDARY_PATTERN.lastIndex = openingBoundary[0].length;
  const closingBoundary = CLOSING_BOUNDARY_PATTERN.exec(markdown);

  if (!closingBoundary) {
    return undefined;
  }

  return {
    bodyStart: closingBoundary.index + closingBoundary[0].length,
    yamlEnd: closingBoundary.index,
    yamlStart: openingBoundary[0].length
  };
}

/** 将 YAML 标量或序列规范化为属性标签字符串集合。 */
function normalizePropertyValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean);
  }

  if (value === null || value === undefined) {
    return [];
  }

  const normalizedValue = String(value).trim();
  return normalizedValue ? [normalizedValue] : [];
}

/** 将 YAML 文档根节点收窄为可按属性读取的普通对象。 */
function resolveFrontmatterRecord(document: Document): Record<string, unknown> {
  const value: unknown = document.toJS();
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 将 YAML 节点转换为普通值，同时保留映射条目的原始排列位置。 */
function resolveYamlNodeValue(value: unknown): unknown {
  return isNode(value) ? value.toJSON() : value;
}

/** 解析 YAML 文档；语法无效时返回空值，避免覆盖用户原始内容。 */
function parseFrontmatterDocument(
  markdown: string,
  boundary: FrontmatterBoundary
): Document | undefined {
  const document = parseDocument(
    markdown.slice(boundary.yamlStart, boundary.yamlEnd)
  );

  return document.errors.length === 0 ? document : undefined;
}

/** 读取 Markdown 正文与受支持的笔记属性。 */
export function parseNoteDocument(markdown: string): NoteDocumentSnapshot {
  const boundary = locateFrontmatter(markdown);
  const emptyProperties = Object.create(null) as Partial<Record<NotePropertyKey, readonly string[]>>;

  if (!boundary) {
    return {
      body: markdown,
      bodyStart: 0,
      hasFrontmatter: false,
      invalidFrontmatter: false,
      propertyKeys: [],
      presentPropertyKeys: new Set<NotePropertyKey>(),
      properties: emptyProperties
    };
  }

  const document = parseFrontmatterDocument(markdown, boundary);
  if (!document) {
    return {
      body: markdown,
      bodyStart: 0,
      hasFrontmatter: true,
      invalidFrontmatter: true,
      propertyKeys: [],
      presentPropertyKeys: new Set<NotePropertyKey>(),
      properties: emptyProperties
    };
  }

  const propertyKeys: NotePropertyKey[] = [];
  const presentPropertyKeys = new Set<NotePropertyKey>();
  const properties = Object.create(null) as Partial<Record<NotePropertyKey, readonly string[]>>;
  const propertyPairs = isMap(document.contents) ? document.contents.items : [];

  for (const pair of propertyPairs) {
    const key = String(resolveYamlNodeValue(pair.key));
    if (!isValidNotePropertyName(key)) {
      continue;
    }

    propertyKeys.push(key);
    presentPropertyKeys.add(key);
    properties[key] = normalizePropertyValues(resolveYamlNodeValue(pair.value));
  }

  return {
    body: markdown.slice(boundary.bodyStart),
    bodyStart: boundary.bodyStart,
    hasFrontmatter: true,
    invalidFrontmatter: false,
    propertyKeys,
    presentPropertyKeys,
    properties
  };
}

/** 新增或更新单个笔记属性，同时保留重复标签、其他 YAML 字段和正文。 */
export function updateNotePropertyValues(
  markdown: string,
  key: NotePropertyKey,
  values: readonly string[]
): string {
  const normalizedKey = normalizeNotePropertyName(key);
  if (!isValidNotePropertyName(normalizedKey)) {
    return markdown;
  }

  const boundary = locateFrontmatter(markdown);
  const normalizedValues = values.map(value => value.trim()).filter(Boolean);

  if (!boundary) {
    const document = new Document({});
    document.set(normalizedKey, normalizedValues);
    return `---\n${document.toString({ lineWidth: 0 })}---\n${markdown}`;
  }

  const document = parseFrontmatterDocument(markdown, boundary);
  if (!document) {
    return markdown;
  }

  document.set(normalizedKey, normalizedValues);
  return `${markdown.slice(0, boundary.yamlStart)}${document.toString({ lineWidth: 0 })}${markdown.slice(boundary.yamlEnd)}`;
}

/** 将文本属性作为单个 YAML 标量写回，并保留内容中的换行。 */
export function updateNotePropertyText(
  markdown: string,
  key: NotePropertyKey,
  value: string
): string {
  const normalizedKey = normalizeNotePropertyName(key);
  if (!isValidNotePropertyName(normalizedKey)) {
    return markdown;
  }

  const normalizedValue = value.replace(/\r\n?/gu, '\n');
  const boundary = locateFrontmatter(markdown);
  if (!boundary) {
    const document = new Document({});
    document.set(normalizedKey, normalizedValue);
    return `---\n${document.toString({ lineWidth: 0 })}---\n${markdown}`;
  }

  const document = parseFrontmatterDocument(markdown, boundary);
  if (!document) {
    return markdown;
  }

  document.set(normalizedKey, normalizedValue);
  return `${markdown.slice(0, boundary.yamlStart)}${document.toString({ lineWidth: 0 })}${markdown.slice(boundary.yamlEnd)}`;
}

/** 新增或更新单个布尔属性，同时保留其他 YAML 字段和正文。 */
export function updateNotePropertyBoolean(
  markdown: string,
  key: NotePropertyKey,
  value: boolean
): string {
  const normalizedKey = normalizeNotePropertyName(key);
  if (!isValidNotePropertyName(normalizedKey)) {
    return markdown;
  }

  const boundary = locateFrontmatter(markdown);
  if (!boundary) {
    const document = new Document({});
    document.set(normalizedKey, value);
    return `---\n${document.toString({ lineWidth: 0 })}---\n${markdown}`;
  }

  const document = parseFrontmatterDocument(markdown, boundary);
  if (!document) {
    return markdown;
  }

  document.set(normalizedKey, value);
  return `${markdown.slice(0, boundary.yamlStart)}${document.toString({ lineWidth: 0 })}${markdown.slice(boundary.yamlEnd)}`;
}

/** 移除单个笔记属性；没有其他字段时同时移除空 Frontmatter。 */
export function removeNoteProperty(markdown: string, key: NotePropertyKey): string {
  const boundary = locateFrontmatter(markdown);
  if (!boundary) {
    return markdown;
  }

  const document = parseFrontmatterDocument(markdown, boundary);
  if (!document || !document.delete(key)) {
    return markdown;
  }

  if (Object.keys(resolveFrontmatterRecord(document)).length === 0) {
    return markdown.slice(boundary.bodyStart);
  }

  return `${markdown.slice(0, boundary.yamlStart)}${document.toString({ lineWidth: 0 })}${markdown.slice(boundary.yamlEnd)}`;
}

/** 删除完整 Frontmatter 属性块并原样保留 Markdown 正文。 */
export function clearNoteProperties(markdown: string): string {
  const boundary = locateFrontmatter(markdown);
  return boundary ? markdown.slice(boundary.bodyStart) : markdown;
}

/** 重命名单个笔记属性，保留原属性值、YAML 顺序、其他字段与正文。 */
export function renameNoteProperty(
  markdown: string,
  currentKey: NotePropertyKey,
  nextKey: NotePropertyKey
): string {
  const normalizedNextKey = normalizeNotePropertyName(nextKey);
  if (
    !isValidNotePropertyName(currentKey)
    || !isValidNotePropertyName(normalizedNextKey)
    || currentKey === normalizedNextKey
  ) {
    return markdown;
  }

  const boundary = locateFrontmatter(markdown);
  if (!boundary) {
    return markdown;
  }

  const document = parseFrontmatterDocument(markdown, boundary);
  if (!document || document.has(normalizedNextKey) || !isMap(document.contents)) {
    return markdown;
  }

  const propertyPair = document.contents.items.find(pair => (
    String(pair.key) === currentKey
  ));
  if (!propertyPair) {
    return markdown;
  }

  propertyPair.key = document.createNode(normalizedNextKey);
  return `${markdown.slice(0, boundary.yamlStart)}${document.toString({ lineWidth: 0 })}${markdown.slice(boundary.yamlEnd)}`;
}

/** 按中英文名称与自然数字顺序重排 Frontmatter 属性。 */
export function sortNoteProperties(
  markdown: string,
  direction: NotePropertySortDirection
): string {
  const boundary = locateFrontmatter(markdown);
  if (!boundary) {
    return markdown;
  }

  const document = parseFrontmatterDocument(markdown, boundary);
  if (!document || !isMap(document.contents)) {
    return markdown;
  }

  const directionFactor = direction === 'ascending' ? 1 : -1;
  document.contents.items.sort((left, right) => (
    directionFactor * NOTE_PROPERTY_NAME_COLLATOR.compare(
      String(resolveYamlNodeValue(left.key)),
      String(resolveYamlNodeValue(right.key))
    )
  ));

  return `${markdown.slice(0, boundary.yamlStart)}${document.toString({ lineWidth: 0 })}${markdown.slice(boundary.yamlEnd)}`;
}
