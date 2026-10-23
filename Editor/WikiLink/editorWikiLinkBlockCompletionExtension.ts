/**
 * 文件说明：为 WikiLink 提供 Obsidian 风格块引用补全，并协调跨文档块 ID 写回。
 */
import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  pickedCompletion
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

import type {
  UpdateWorkspaceMarkdownFileResult,
  WorkspaceMarkdownFile,
  WorkspaceMarkdownFileMetadata
} from '@/types/ipc';
import {
  collectEditorWikiLinkBlockCandidates,
  createEditorWikiLinkBlockId,
  insertEditorWikiLinkBlockId,
  resolveEditorWikiLinkDocument,
  type EditorWikiLinkBlockCandidate,
  type EditorWikiLinkBlockCompletionContext
} from '@editor/WikiLink/editorWikiLinkBlockReference';

/** 块引用查询允许继续输入的字符范围。 */
const WIKI_LINK_BLOCK_VALID_PATTERN = /^[^\]\r\n|]*$/u;
const EXCLUDED_SYNTAX_NODE_NAMES = new Set([
  'FencedCode',
  'IndentedCode',
  'HTMLBlock',
  'HTMLTag',
  'InlineCode',
  'Comment',
  'CommentBlock'
]);

/** 依赖工作区和异步写回能力的块引用补全配置。 */
export interface EditorWikiLinkBlockCompletionOptions {
  /** 获取当前编辑器对应的文件路径。 */
  readonly getCurrentFilePath: () => string | undefined;
  /** 获取当前工作区 Markdown 文件快照。 */
  readonly getWorkspaceFiles: () => readonly WorkspaceMarkdownFileMetadata[];
  /** 按需读取跨文档块引用目标正文。 */
  readonly readWorkspaceFile: (filePath: string) => Promise<WorkspaceMarkdownFile | undefined>;
  /** 将跨文档目标内容比较后写回磁盘。 */
  readonly persistTarget?: (
    filePath: string,
    expectedContent: string,
    content: string
  ) => Promise<UpdateWorkspaceMarkdownFileResult>;
}

/** 判断指定位置之前是否有奇数个连续反斜杠。 */
function isEscaped(source: string, position: number): boolean {
  let slashCount = 0;

  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

/** 在当前行中查找未转义的 WikiLink 起点。 */
function findOpeningPosition(source: string, start: number): number {
  let openingPosition = source.lastIndexOf('[[', start);

  while (openingPosition >= 0) {
    if (!isEscaped(source, openingPosition)) {
      return openingPosition;
    }

    openingPosition = openingPosition > 0
      ? source.lastIndexOf('[[', openingPosition - 1)
      : -1;
  }

  return -1;
}

/** 查找当前 WikiLink 中未转义的 `#^` 分隔符起点。 */
function findHashCaretPosition(source: string): number {
  for (let position = source.indexOf('#^'); position >= 0; position = source.indexOf('#^', position + 1)) {
    if (!isEscaped(source, position)) {
      return position;
    }
  }

  return -1;
}

/** 查找未转义的 WikiLink 标题分隔符。 */
function findHashPosition(source: string): number {
  for (let position = source.indexOf('#'); position >= 0; position = source.indexOf('#', position + 1)) {
    if (!isEscaped(source, position)) {
      return position;
    }
  }

  return -1;
}

/** 查找当前光标所在的 `[[目标#^查询` 范围。 */
export function findEditorWikiLinkBlockCompletionContext(
  state: EditorState,
  position = state.selection.main.head
): EditorWikiLinkBlockCompletionContext | null {
  if (position < 0 || position > state.doc.length) {
    return null;
  }

  const line = state.doc.lineAt(position);
  const cursorOffset = position - line.from;
  const beforeCursor = line.text.slice(0, cursorOffset);
  let openingPosition = findOpeningPosition(beforeCursor, beforeCursor.length);

  while (openingPosition >= 0) {
    const linkContent = beforeCursor.slice(openingPosition + 2);
    const hashCaretPosition = findHashCaretPosition(linkContent);
    const hashPosition = hashCaretPosition >= 0
      ? hashCaretPosition
      : findHashPosition(linkContent);
    const markerStyle = hashCaretPosition >= 0 ? 'prefix' : 'suffix';

    if (hashPosition >= 0) {
      const documentTarget = linkContent.slice(0, hashPosition).trim();
      const suffixContent = linkContent.slice(hashPosition + 1);
      const hasSuffixCaret = markerStyle === 'suffix'
        && suffixContent.endsWith('^')
        && !isEscaped(suffixContent, suffixContent.length - 1);
      const query = markerStyle === 'prefix'
        ? linkContent.slice(hashPosition + 2)
        : suffixContent.slice(0, -1);
      const afterCursor = line.text.slice(cursorOffset);

      if (
        !linkContent.includes('[[')
        && !linkContent.includes(']]')
        && !(openingPosition > 0 && beforeCursor[openingPosition - 1] === '!')
        && !documentTarget.includes('|')
        && !query.includes(']')
        && !query.includes('|')
        && (markerStyle === 'prefix' || hasSuffixCaret)
        && (afterCursor.length === 0 || afterCursor.startsWith(']]'))
      ) {
        return {
          from: line.from + openingPosition + 2 + hashPosition + (markerStyle === 'prefix' ? 2 : 1),
          to: position,
          documentTarget,
          openingFrom: line.from + openingPosition,
          markerStyle
        };
      }
    }

    openingPosition = openingPosition > 0
      ? findOpeningPosition(beforeCursor, openingPosition - 1)
      : -1;
  }

  return null;
}

/** 判断语法树位置是否处于代码或 HTML 区域。 */
function isExcludedSyntaxPosition(state: EditorState, position: number): boolean {
  const resolvedPosition = Math.max(0, Math.min(state.doc.length - 1, position - 1));
  if (state.doc.length === 0) {
    return false;
  }

  let node: SyntaxNode | null = syntaxTree(state).resolveInner(resolvedPosition, -1);

  while (node) {
    if (EXCLUDED_SYNTAX_NODE_NAMES.has(node.name)) {
      return true;
    }

    node = node.parent;
  }

  return false;
}

/** 获取当前文档或工作区目标文件。 */
async function resolveTargetFile(
  context: CompletionContext,
  completionContext: EditorWikiLinkBlockCompletionContext,
  options: EditorWikiLinkBlockCompletionOptions
): Promise<WorkspaceMarkdownFile | undefined> {
  const currentFilePath = options.getCurrentFilePath();
  const currentFile = currentFilePath
    ? options.getWorkspaceFiles().find((file) => file.path === currentFilePath)
    : undefined;

  if (!completionContext.documentTarget) {
    return {
      path: currentFilePath ?? '',
      relativePath: currentFile?.relativePath ?? '',
      content: context.state.doc.toString()
    };
  }

  const targetFile = resolveEditorWikiLinkDocument(
    completionContext.documentTarget,
    currentFilePath,
    options.getWorkspaceFiles()
  );

  if (!targetFile) {
    return undefined;
  }

  if (targetFile.path === currentFilePath) {
    return {
      ...targetFile,
      content: context.state.doc.toString()
    };
  }

  return options.readWorkspaceFile(targetFile.path);
}

/** 判断候选是否与当前尚未闭合的 WikiLink 重叠。 */
function overlapsActiveLink(
  candidate: EditorWikiLinkBlockCandidate,
  activeLinkFrom: number,
  targetIsCurrentDocument: boolean
): boolean {
  return targetIsCurrentDocument
    && candidate.from <= activeLinkFrom
    && activeLinkFrom <= candidate.to;
}

/** 按候选类型和源码指纹在最新文档中重新定位块。 */
function resolveLatestBlockCandidate(
  source: string,
  candidate: EditorWikiLinkBlockCandidate
): EditorWikiLinkBlockCandidate | undefined {
  return collectEditorWikiLinkBlockCandidates(source).find((nextCandidate) => (
    nextCandidate.kind === candidate.kind
    && nextCandidate.fingerprint === candidate.fingerprint
  ));
}

/** 在当前文档中插入链接及块 ID，保持一次 CodeMirror 事务完成。 */
function applyCurrentDocumentBlockReference(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
  candidate: EditorWikiLinkBlockCandidate,
  blockId: string,
  markerStyle: EditorWikiLinkBlockCompletionContext['markerStyle']
): void {
  const source = view.state.doc.toString();
  const latestCandidate = resolveLatestBlockCandidate(source, candidate);

  if (!latestCandidate) {
    return;
  }

  const hasClosingMark = view.state.sliceDoc(to, to + 2) === ']]';
  const referenceText = markerStyle === 'suffix' ? `^${blockId}` : blockId;
  const linkChange = {
    from,
    to,
    insert: `${referenceText}${hasClosingMark ? '' : ']]'}`
  };
  const targetChange = latestCandidate.blockId
    && latestCandidate.idFrom !== undefined
    && latestCandidate.idTo !== undefined
    && latestCandidate.blockId !== blockId
    ? { from: latestCandidate.idFrom, to: latestCandidate.idTo, insert: blockId }
    : latestCandidate.blockId
      ? undefined
      : (() => {
          const nextSource = insertEditorWikiLinkBlockId(source, latestCandidate, blockId);
          return {
            from: latestCandidate.to,
            to: latestCandidate.to,
            insert: nextSource.slice(latestCandidate.to, nextSource.length - source.length + latestCandidate.to)
          };
        })();
  const changes = [targetChange, linkChange]
    .filter((change): change is { from: number; to: number; insert: string } => Boolean(change))
    .sort((left, right) => left.from - right.from);
  const targetInsertionLength = targetChange && targetChange.from < from
    ? targetChange.insert.length - (targetChange.to - targetChange.from)
    : 0;

  view.dispatch({
    changes,
    selection: { anchor: from + targetInsertionLength + referenceText.length },
    annotations: pickedCompletion.of(completion),
    scrollIntoView: true,
    userEvent: 'input.complete'
  });
  view.focus();
}

/** 创建一个块引用补全项。 */
function createBlockCompletion(
  targetFile: WorkspaceMarkdownFile,
  candidate: EditorWikiLinkBlockCandidate,
  order: number,
  completionContext: EditorWikiLinkBlockCompletionContext,
  options: EditorWikiLinkBlockCompletionOptions
): Completion {
  const targetLabel = targetFile.relativePath || targetFile.path || '当前文档';
  return {
    label: candidate.blockId ? `${candidate.preview} ^${candidate.blockId}` : candidate.preview,
    displayLabel: candidate.blockId
      ? `${candidate.preview}  ^${candidate.blockId}`
      : candidate.preview,
    detail: `${targetLabel} · ${candidate.kind}`,
    sortText: String(order).padStart(6, '0'),
    type: 'text',
    apply(view, completion, from, to) {
      const currentFilePath = options.getCurrentFilePath();
      const targetIsCurrentDocument = !completionContext.documentTarget
        || targetFile.path === currentFilePath;
      const source = targetIsCurrentDocument ? view.state.doc.toString() : targetFile.content;
      const latestCandidate = resolveLatestBlockCandidate(source, candidate);

      if (!latestCandidate) {
        return;
      }

      const blockId = createEditorWikiLinkBlockId(source, latestCandidate);

      if (targetIsCurrentDocument) {
        applyCurrentDocumentBlockReference(
          view,
          completion,
          from,
          to,
          latestCandidate,
          blockId,
          completionContext.markerStyle
        );
        return;
      }

      if (!options.persistTarget) {
        return;
      }

      const nextContent = insertEditorWikiLinkBlockId(targetFile.content, latestCandidate, blockId);
      const requestedDocument = view.state.doc.toString();

      if (nextContent === targetFile.content) {
        const hasClosingMark = view.state.sliceDoc(to, to + 2) === ']]';
        const referenceText = completionContext.markerStyle === 'suffix' ? `^${blockId}` : blockId;
        view.dispatch({
          changes: {
            from,
            to,
            insert: `${referenceText}${hasClosingMark ? '' : ']]'}`
          },
          selection: { anchor: from + referenceText.length },
          annotations: pickedCompletion.of(completion),
          scrollIntoView: true,
          userEvent: 'input.complete'
        });
        view.focus();
        return;
      }

      void options.persistTarget(targetFile.path, targetFile.content, nextContent).then((result) => {
        if (
          (result.status !== 'updated' && result.status !== 'unchanged')
          || view.state.doc.toString() !== requestedDocument
        ) {
          return;
        }

        const hasClosingMark = view.state.sliceDoc(to, to + 2) === ']]';
        const referenceText = completionContext.markerStyle === 'suffix' ? `^${blockId}` : blockId;
        view.dispatch({
          changes: {
            from,
            to,
            insert: `${referenceText}${hasClosingMark ? '' : ']]'}`
          },
          selection: { anchor: from + referenceText.length },
          annotations: pickedCompletion.of(completion),
          scrollIntoView: true,
          userEvent: 'input.complete'
        });
        view.focus();
      });
    }
  };
}

/** 提供当前 `#^` 查询对应目标文档的块候选。 */
export async function editorWikiLinkBlockCompletionSource(
  context: CompletionContext,
  options: EditorWikiLinkBlockCompletionOptions
): Promise<CompletionResult | null> {
  if (!context.state.selection.main.empty || isExcludedSyntaxPosition(context.state, context.pos)) {
    return null;
  }

  const completionContext = findEditorWikiLinkBlockCompletionContext(context.state, context.pos);
  if (!completionContext) {
    return null;
  }

  const targetFile = await resolveTargetFile(context, completionContext, options);
  if (!targetFile) {
    return null;
  }

  const targetIsCurrentDocument = !completionContext.documentTarget
    || targetFile.path === options.getCurrentFilePath();
  const candidates = collectEditorWikiLinkBlockCandidates(targetFile.content)
    .filter((candidate) => !overlapsActiveLink(candidate, completionContext.openingFrom, targetIsCurrentDocument));

  if (candidates.length === 0) {
    return null;
  }

  return {
    from: completionContext.from,
    to: completionContext.to,
    options: candidates.map((candidate, index) => createBlockCompletion(
      targetFile,
      candidate,
      index,
      completionContext,
      options
    )),
    validFor: WIKI_LINK_BLOCK_VALID_PATTERN
  };
}

/** 创建带有当前文档与工作区动态上下文的 WikiLink 补全扩展。 */
export function createEditorWikiLinkBlockCompletionExtension(
  options: EditorWikiLinkBlockCompletionOptions
) {
  // Keep the source identity stable so CodeMirror does not restart this
  // completion query on every view update (including completion-list scrolls).
  const completionSource = (context: CompletionContext) =>
    editorWikiLinkBlockCompletionSource(context, options);

  return EditorState.languageData.of(() => [{
    autocomplete: completionSource
  }]);
}

/** 判断当前补全状态是否处于 WikiLink 块引用输入范围。 */
export function isEditorWikiLinkBlockCompletionState(state: EditorState): boolean {
  return findEditorWikiLinkBlockCompletionContext(state) !== null;
}
