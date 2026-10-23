/**
 * 文件说明：构建可扩展到多文档的 Markdown 脚注引用索引，并生成受控长度的引用预览。
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { parser as markdownParser } from '@lezer/markdown';

const FOOTNOTE_DEFINITION_LINE_PATTERN = /^\s*\[\^[^\]\s]+\]:/;
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([^\]\s]+)\]/g;
const EXCLUDED_FOOTNOTE_NODE_NAMES = new Set([
  'FencedCode',
  'HTMLBlock',
  'HTMLTag',
  'InlineCode'
]);
const DEFAULT_REFERENCE_PREVIEW_MAX_CHARACTERS = 40;

export interface EditorFootnoteReference {
  readonly documentId: string | null;
  readonly footnoteId: string;
  readonly from: number;
  readonly to: number;
  readonly lineFrom: number;
  readonly preview: string;
}

export interface EditorFootnoteReferenceIndex {
  readonly documentId: string | null;
  readonly referencesByFootnoteId: ReadonlyMap<string, readonly EditorFootnoteReference[]>;
}

export interface EditorFootnoteReferenceIndexOptions {
  readonly documentId?: string;
  readonly previewMaxCharacters?: number;
}

/** 判断文档位置是否位于代码或 HTML 语法节点中。 */
export function isExcludedFootnotePosition(state: EditorState, position: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1);

  while (node) {
    if (EXCLUDED_FOOTNOTE_NODE_NAMES.has(node.name)) {
      return true;
    }
    node = node.parent;
  }

  return false;
}

/** 构建当前文档脚注引用索引，定义行本身不计入引用。 */
export function buildEditorFootnoteReferenceIndex(
  state: EditorState,
  options: EditorFootnoteReferenceIndexOptions = {}
): EditorFootnoteReferenceIndex {
  return buildEditorFootnoteReferenceIndexFromSource(state.doc.toString(), options, (position) => (
    isExcludedFootnotePosition(state, position)
  ));
}

/** 直接从 Markdown 字符串构建索引，供全项目文件扫描复用。 */
export function buildEditorFootnoteReferenceIndexFromSource(
  source: string,
  options: EditorFootnoteReferenceIndexOptions = {},
  isExcludedPosition?: (position: number) => boolean
): EditorFootnoteReferenceIndex {
  const documentId = options.documentId ?? null;
  const previewMaxCharacters = options.previewMaxCharacters
    ?? DEFAULT_REFERENCE_PREVIEW_MAX_CHARACTERS;
  const mutableReferences = new Map<string, EditorFootnoteReference[]>();
  const markdownTree = isExcludedPosition ? null : markdownParser.parse(source);
  const sourceLinePattern = /.*(?:\r\n|\n|$)/g;

  for (const lineMatch of source.matchAll(sourceLinePattern)) {
    if (lineMatch[0].length === 0) {
      continue;
    }

    const lineFrom = lineMatch.index ?? 0;
    const lineText = lineMatch[0].replace(/\r?\n$/, '');

    if (FOOTNOTE_DEFINITION_LINE_PATTERN.test(lineText)) {
      continue;
    }

    for (const match of lineText.matchAll(FOOTNOTE_REFERENCE_PATTERN)) {
      const from = lineFrom + (match.index ?? 0);

      if (
        isExcludedPosition?.(from)
        || (markdownTree && isExcludedMarkdownTreePosition(markdownTree, from))
      ) {
        continue;
      }

      const footnoteId = match[1];
      const reference: EditorFootnoteReference = {
        documentId,
        footnoteId,
        from,
        to: from + match[0].length,
        lineFrom,
        preview: createEditorFootnoteReferencePreview(
          lineText,
          footnoteId,
          previewMaxCharacters
        )
      };
      const references = mutableReferences.get(footnoteId) ?? [];
      references.push(reference);
      mutableReferences.set(footnoteId, references);
    }

  }

  return {
    documentId,
    referencesByFootnoteId: new Map(
      [...mutableReferences].map(([footnoteId, references]) => [
        footnoteId,
        references as readonly EditorFootnoteReference[]
      ])
    )
  };
}

/** 判断纯 Markdown 语法树位置是否位于代码或 HTML 中。 */
function isExcludedMarkdownTreePosition(tree: Tree, position: number): boolean {
  let node: SyntaxNode | null = tree.resolve(position, 1);

  while (node) {
    if (EXCLUDED_FOOTNOTE_NODE_NAMES.has(node.name)) {
      return true;
    }
    node = node.parent;
  }

  return false;
}

/** 生成移除脚注标记、压缩空白并限制字符数的引用预览。 */
function createEditorFootnoteReferencePreview(
  lineText: string,
  footnoteId: string,
  maxCharacters: number
): string {
  const normalizedText = lineText
    .replace(FOOTNOTE_REFERENCE_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
  const source = normalizedText || `[^${footnoteId}]`;
  const characters = Array.from(source);

  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters).join('')}...`
    : source;
}
