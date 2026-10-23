/**
 * 文件说明：解析文件嵌入补全上下文、按文件名定位候选并格式化插入语法。
 */
import type { EditorState } from '@codemirror/state';
import type { WorkspaceMarkdownFileMetadata } from '@/types/ipc';

export interface EditorWikiLinkEmbedCompletionContext {
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

/** 将嵌入块高度限制在允许的最小值和最大值之间。 */
export function clampEditorWikiLinkEmbedHeight(
  height: number,
  minHeight: number,
  maxHeight: number
): number {
  return Math.max(minHeight, Math.min(maxHeight, height));
}

function hasMarkdownExtension(fileName: string): boolean {
  return /\.(?:md|markdown)$/iu.test(fileName.trim());
}

/** Wiki 嵌入语法只展示文件名，不把 Markdown 扩展名写入链接。 */
export function stripEditorWikiLinkEmbedExtension(fileName: string): string {
  return fileName.trim().replace(/\.(?:md|markdown)$/iu, '');
}

function isEscaped(source: string, position: number): boolean {
  let count = 0;
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) count += 1;
  return count % 2 === 1;
}

/** 查找当前光标所在的 `![[文件名称` 补全范围。 */
export function findEditorWikiLinkEmbedCompletionContext(
  state: EditorState,
  position = state.selection.main.head
): EditorWikiLinkEmbedCompletionContext | null {
  if (position < 0 || position > state.doc.length || !state.selection.main.empty) return null;
  const line = state.doc.lineAt(position);
  const cursorOffset = position - line.from;
  const beforeCursor = line.text.slice(0, cursorOffset);
  let opening = beforeCursor.lastIndexOf('![[');

  while (opening >= 0) {
    if (!isEscaped(beforeCursor, opening)) {
      const query = beforeCursor.slice(opening + 3);
      const afterCursor = line.text.slice(cursorOffset);
      if (
        !query.includes('![[')
        && !query.includes(']]')
        && !query.includes(']')
        && !query.includes('|')
        && !query.includes('#')
        && !hasMarkdownExtension(query)
        && (afterCursor.length === 0 || afterCursor.startsWith(']]'))
      ) {
        return { from: line.from + opening + 3, to: position, query };
      }
    }
    opening = opening > 0 ? beforeCursor.lastIndexOf('![[', opening - 1) : -1;
  }

  return null;
}

/** 按文件名称解析嵌入候选，兼容 `.md` 和 `.markdown` 扩展名省略。 */
export function resolveEditorWikiLinkEmbedFile(
  fileName: string,
  files: readonly WorkspaceMarkdownFileMetadata[]
): WorkspaceMarkdownFileMetadata | undefined {
  const target = fileName.trim().toLocaleLowerCase();
  if (hasMarkdownExtension(target)) return undefined;
  const withoutExtension = target.replace(/\.(?:md|markdown)$/u, '');
  const matches = files.filter((file) => {
    const name = file.name.toLocaleLowerCase();
    const nameWithoutExtension = name.replace(/\.(?:md|markdown)$/u, '');
    return name === target || nameWithoutExtension === withoutExtension;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return undefined;
  return files.find((file) => (
    file.relativePath.toLocaleLowerCase() === target
    || file.relativePath.toLocaleLowerCase().replace(/\.(?:md|markdown)$/u, '') === withoutExtension
  ));
}

export function createEditorWikiLinkEmbedText(fileName: string): string {
  return `![[${stripEditorWikiLinkEmbedExtension(fileName)}]]`;
}

/** 仅按源码按钮的显式请求设置模式，避免把焦点变化当成模式切换。 */
export function setEditorWikiLinkEmbedSourceMode(
  sourceKeys: ReadonlySet<string>,
  key: string,
  enabled: boolean
): Set<string> {
  const nextKeys = new Set(sourceKeys);
  if (enabled) {
    nextKeys.add(key);
  } else {
    nextKeys.delete(key);
  }
  return nextKeys;
}

/** 选区离开源码行后恢复对应的嵌入预览块。 */
export function retainEditorWikiLinkEmbedSourceKeys(
  sourceKeys: ReadonlySet<string>,
  activeSourceKeys: ReadonlySet<string>
): Set<string> {
  return new Set([...sourceKeys].filter((key) => activeSourceKeys.has(key)));
}

