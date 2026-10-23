/**
 * 文件说明：解析 Obsidian 风格块引用候选，并为目标 Markdown 块生成稳定的块 ID。
 */
import { parser } from '@lezer/markdown';
import { Table } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

import type { WorkspaceMarkdownFileMetadata } from '@/types/ipc';
import { disableSetextHeadingExtension } from '@editor/Markdown/disableSetextHeadingExtension';

/** 可用于 WikiLink 块引用的 Markdown 块。 */
export interface EditorWikiLinkBlockCandidate {
  readonly from: number;
  readonly to: number;
  readonly kind: 'paragraph' | 'list-item' | 'blockquote';
  readonly preview: string;
  readonly blockId?: string;
  readonly idFrom?: number;
  readonly idTo?: number;
  readonly fingerprint: string;
}

/** WikiLink 块引用补全标记的位置。 */
export type EditorWikiLinkBlockMarkerStyle = 'prefix' | 'suffix';

/** `[[笔记名#^查询` 或 `[[笔记名#查询^` 的补全上下文。 */
export interface EditorWikiLinkBlockCompletionContext {
  readonly from: number;
  readonly to: number;
  readonly documentTarget: string;
  readonly openingFrom: number;
  readonly markerStyle: EditorWikiLinkBlockMarkerStyle;
}

const BLOCK_ID_PATTERN = /(?:^|[ \t]+|\r?\n[ \t]*)\^([A-Za-z0-9-]+)[ \t]*$/mu;
const PURE_BLOCK_ID_PATTERN = /^\^([A-Za-z0-9-]+)$/u;
const EXCLUDED_BLOCK_NODE_NAMES = new Set([
  'FencedCode',
  'IndentedCode',
  'HTMLBlock',
  'HTMLTag',
  'Table',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2'
]);
const parserWithTables = parser.configure([Table, disableSetextHeadingExtension]);

/** 将 Markdown 源码规范化为候选面板可读的单行预览。 */
function createBlockPreview(source: string): string {
  return source
    .replace(/(?:^|\r?\n)[ \t]*\^[A-Za-z0-9-]+[ \t]*/gu, '')
    .replace(/[ \t]+\^[A-Za-z0-9-]+[ \t]*$/u, '')
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/u, '')
    .replace(/^>[ \t]?/u, '')
    .replace(/\r?\n[ \t]*(?:>|[-+*]|\d+[.)])[ \t]?/gu, ' ')
    .replace(/\r?\n/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .trim()
    .slice(0, 120);
}

/** 判断节点是否属于不应生成块引用的 HTML 或代码区域。 */
function isExcludedBlockNode(node: SyntaxNode): boolean {
  return EXCLUDED_BLOCK_NODE_NAMES.has(node.name);
}

/** 从块源码尾部提取已有块 ID。 */
function findBlockId(source: string, from: number): Pick<EditorWikiLinkBlockCandidate, 'blockId' | 'idFrom' | 'idTo'> {
  const match = BLOCK_ID_PATTERN.exec(source);

  if (!match || match.index < 0 || !match[1]) {
    return {};
  }

  const idFrom = from + match.index + match[0].lastIndexOf(`^${match[1]}`) + 1;
  return {
    blockId: match[1],
    idFrom,
    idTo: idFrom + match[1].length
  };
}

/** 创建候选的稳定去重指纹。 */
function createFingerprint(source: string, kind: EditorWikiLinkBlockCandidate['kind']): string {
  return `${kind}:${source.replace(/\r\n/gu, '\n').trim()}`;
}

/** 将节点转换为块候选，并过滤空白或纯 HTML 段落。 */
function createCandidate(
  source: string,
  node: SyntaxNode,
  kind: EditorWikiLinkBlockCandidate['kind']
): EditorWikiLinkBlockCandidate | undefined {
  const blockSource = source.slice(node.from, node.to);
  const trimmedSource = blockSource.trim();

  if (
    !trimmedSource
    || PURE_BLOCK_ID_PATTERN.test(trimmedSource)
    || /^<[^>]+>[^\r\n]*<\/[^>]+>$/u.test(trimmedSource)
  ) {
    return undefined;
  }

  const blockId = findBlockId(blockSource, node.from);
  return {
    from: node.from,
    to: node.to,
    kind,
    preview: createBlockPreview(blockSource),
    ...blockId,
    fingerprint: createFingerprint(blockSource, kind)
  };
}

/** 收集一个列表中的直接 ListItem，避免将嵌套段落重复列为候选。 */
function collectListCandidates(
  source: string,
  listNode: SyntaxNode,
  candidates: EditorWikiLinkBlockCandidate[]
): void {
  for (let child = listNode.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'ListItem') {
      continue;
    }

    const candidate = createCandidate(source, child, 'list-item');
    if (candidate) {
      candidates.push(candidate);
    }
  }
}

/** 将引用块后空行中的独立块 ID 绑定到引用块候选。 */
function attachFollowingBlockquoteId(
  source: string,
  candidate: EditorWikiLinkBlockCandidate
): EditorWikiLinkBlockCandidate {
  const followingSource = source.slice(candidate.to);
  const match = /^(?:\r?\n){2,}[ \t]*\^([A-Za-z0-9-]+)[ \t]*(?=\r?\n|$)/u.exec(followingSource);

  if (!match || !match[1]) {
    return candidate;
  }

  const markerOffset = match[0].lastIndexOf(`^${match[1]}`);
  const idFrom = candidate.to + markerOffset + 1;
  return {
    ...candidate,
    blockId: match[1],
    idFrom,
    idTo: idFrom + match[1].length
  };
}

/** 收集目标文档中的可引用段落、列表项和引用块。 */
export function collectEditorWikiLinkBlockCandidates(
  source: string
): EditorWikiLinkBlockCandidate[] {
  const candidates: EditorWikiLinkBlockCandidate[] = [];
  const tree = parserWithTables.parse(source);

  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (isExcludedBlockNode(node)) {
      continue;
    }

    if (node.name === 'Paragraph') {
      const candidate = createCandidate(source, node, 'paragraph');
      if (candidate) {
        candidates.push(candidate);
      }
      continue;
    }

    if (node.name === 'BulletList' || node.name === 'OrderedList') {
      collectListCandidates(source, node, candidates);
      continue;
    }

    if (node.name === 'Blockquote') {
      const candidate = createCandidate(source, node, 'blockquote');
      if (candidate) {
        candidates.push(attachFollowingBlockquoteId(source, candidate));
      }
    }
  }

  return candidates;
}

/** 生成不与目标文档现有 ID 冲突的 6 位小写 base36 ID。 */
export function createEditorWikiLinkBlockId(
  source: string,
  candidate: EditorWikiLinkBlockCandidate
): string {
  const usedIds = new Set<string>();
  const idCounts = new Map<string, number>();
  const matches = source.matchAll(/(?:^|[ \t]+|\r?\n[ \t]*)\^([A-Za-z0-9-]+)[ \t]*$/gmu);

  for (const match of matches) {
    if (match[1]) {
      usedIds.add(match[1]);
      idCounts.set(match[1], (idCounts.get(match[1]) ?? 0) + 1);
    }
  }

  if (candidate.blockId && idCounts.get(candidate.blockId) === 1) {
    return candidate.blockId;
  }

  let hash = 2166136261;
  for (const character of candidate.fingerprint) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  for (let salt = 0; salt < Number.MAX_SAFE_INTEGER; salt += 1) {
    const value = ((hash + salt) >>> 0).toString(36).padStart(6, '0').slice(-6);
    if (!usedIds.has(value)) {
      return value;
    }
  }

  return '000000';
}

/** 计算在候选块末尾追加块 ID 所需的源码变更。 */
export function createEditorWikiLinkBlockIdInsertion(
  source: string,
  candidate: EditorWikiLinkBlockCandidate,
  blockId: string
): { from: number; to: number; insert: string } {
  const lineBreak = source.includes('\r\n') ? '\r\n' : '\n';

  if (candidate.blockId && candidate.idFrom !== undefined && candidate.idTo !== undefined) {
    return { from: candidate.idFrom, to: candidate.idTo, insert: blockId };
  }

  if (candidate.kind === 'blockquote') {
    return { from: candidate.to, to: candidate.to, insert: `${lineBreak}${lineBreak}^${blockId}` };
  }

  if (candidate.kind === 'list-item' && /\r?\n/u.test(source.slice(candidate.from, candidate.to))) {
    const firstLine = source.slice(candidate.from, candidate.to).split(/\r?\n/u, 1)[0] ?? '';
    const indent = (firstLine.match(/^[ \t]*/u)?.[0] ?? '') + '  ';
    return { from: candidate.to, to: candidate.to, insert: `${lineBreak}${indent}^${blockId}` };
  }

  return { from: candidate.to, to: candidate.to, insert: ` ^${blockId}` };
}

/** 将块 ID 变更应用到目标文档源码。 */
export function insertEditorWikiLinkBlockId(
  source: string,
  candidate: EditorWikiLinkBlockCandidate,
  blockId: string
): string {
  const insertion = createEditorWikiLinkBlockIdInsertion(source, candidate, blockId);
  return `${source.slice(0, insertion.from)}${insertion.insert}${source.slice(insertion.to)}`;
}

/** 将工作区路径统一为可比较的正斜杠路径。 */
function normalizeWorkspacePath(value: string): string {
  const segments = value.replace(/\\/gu, '/').replace(/\/+/gu, '/').split('/');
  const normalized: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..' && normalized.length > 0) {
      normalized.pop();
      continue;
    }

    normalized.push(segment);
  }

  return normalized.join('/');
}

/** 根据当前文档目录和 WikiLink 目标解析工作区 Markdown 文件。 */
export function resolveEditorWikiLinkDocument(
  documentTarget: string,
  currentFilePath: string | undefined,
  workspaceFiles: readonly WorkspaceMarkdownFileMetadata[]
): WorkspaceMarkdownFileMetadata | undefined {
  const target = normalizeWorkspacePath(documentTarget.trim()).replace(/\.markdown$/iu, '.md');
  const currentDirectory = normalizeWorkspacePath(currentFilePath ?? '').split('/').slice(0, -1);
  const relativeTarget = normalizeWorkspacePath([...currentDirectory, target].join('/')).toLocaleLowerCase();
  const exact = workspaceFiles.find((file) => (
    normalizeWorkspacePath(file.path).toLocaleLowerCase() === relativeTarget
    || normalizeWorkspacePath(file.relativePath).toLocaleLowerCase() === relativeTarget
    || normalizeWorkspacePath(file.relativePath).replace(/\.markdown$/iu, '').toLocaleLowerCase() === relativeTarget.replace(/\.md$/iu, '')
  ));

  if (exact) {
    return exact;
  }

  const targetWithoutExtension = target.replace(/\.(?:md|markdown)$/iu, '').toLocaleLowerCase();
  const matches = workspaceFiles.filter((file) => {
    const relativePath = normalizeWorkspacePath(file.relativePath).replace(/\.(?:md|markdown)$/iu, '').toLocaleLowerCase();
    return relativePath === targetWithoutExtension
      || relativePath.endsWith(`/${targetWithoutExtension}`)
      || relativePath.split('/').pop() === targetWithoutExtension;
  });

  return matches.length === 1 ? matches[0] : undefined;
}
