/**
 * 文件说明：解析 Markdown 行内链接目标，并从当前文档或工作区文件中生成标题章节预览。
 */
import { parser } from '@lezer/markdown';

import type {
  WorkspaceMarkdownFile,
  WorkspaceMarkdownFileMetadata
} from '@/types/ipc';

/** Markdown 标题节点及其源码范围。 */
export interface MarkdownHeadingSection {
  from: number;
  to: number;
  level: number;
  title: string;
}

export type MarkdownInlineLinkPreview = {
  kind: 'found';
  fileName: string;
  heading: string;
  headingLevel: number;
  content: string;
  position: number;
  selectionEnd: number;
  navigationTarget?: MarkdownInlineLinkNavigationTarget;
} | {
  kind: 'missing';
  fileName: string;
  heading: string;
};

/** 跨文件标题跳转所需的数据。 */
export interface MarkdownInlineLinkNavigationTarget {
  filePath: string;
  title: string;
  content: string;
  position: number;
  selectionEnd: number;
}

/** 行内链接预览解析所需的当前文档与工作区上下文。 */
interface ResolveMarkdownInlineLinkPreviewOptions {
  currentContent: string;
  currentFilePath?: string;
  destination: string;
  workspaceFiles: readonly WorkspaceMarkdownFileMetadata[];
  readWorkspaceFile: (filePath: string) => Promise<WorkspaceMarkdownFile | undefined>;
}

/** 安全解码链接目标，非法转义序列保持原文。 */
function decodeLinkPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 将工作区路径统一为可比较的正斜杠形式。 */
function normalizeWorkspacePath(value: string): string {
  const segments = value.replace(/\\/g, '/').split('/');
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

/** 获取路径中的文件名，并移除 Markdown 扩展名。 */
function getMarkdownFileName(filePath: string | undefined): string {
  const fileName = filePath?.replace(/\\/g, '/').split('/').pop();
  return fileName?.replace(/\.md$/i, '') || '当前文档';
}

/** 规范化标题文本，用于兼容直写标题和 Markdown 锚点形式。 */
function normalizeHeading(value: string): string {
  return decodeLinkPart(value)
    .replace(/^#+/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

/** 从井号后的扩展描述中提取第一个标题标识。 */
function extractHeadingTarget(value: string): string {
  return decodeLinkPart(value).trim().split(/\s+/u, 1)[0] ?? '';
}

/** 将标题转换为常见的 Markdown 锚点形式。 */
function createHeadingSlug(value: string): string {
  return normalizeHeading(value)
    .replace(/[`*_~[\]]/g, '')
    .replace(/\s+/g, '-');
}

/** 使用 Lezer Markdown 语法树收集真实标题，自动排除代码块内的伪标题。 */
export function collectMarkdownHeadingSections(source: string): MarkdownHeadingSection[] {
  const headings: MarkdownHeadingSection[] = [];

  parser.parse(source).iterate({
    enter(node) {
      const headingMatch = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);

      if (!headingMatch) {
        return;
      }

      const headingSource = source.slice(node.from, node.to);
      const firstLine = headingSource.split(/\r?\n/, 1)[0] ?? '';
      const title = node.name.startsWith('ATX')
        ? firstLine.replace(/^#{1,6}[\t ]+/, '').replace(/[\t ]+#+[\t ]*$/, '').trim()
        : firstLine.trim();

      headings.push({
        from: node.from,
        to: node.to,
        level: Number(headingMatch[1]),
        title
      });
    }
  });

  return headings;
}

/** 在标题列表中查找目标标题，并截取到下一个同级或更高级标题之前。 */
function resolveHeadingSection(
  source: string,
  headingTarget: string
): Pick<
  MarkdownInlineLinkPreview & { kind: 'found' },
  'heading' | 'headingLevel' | 'content' | 'position' | 'selectionEnd'
> | null {
  const headings = collectMarkdownHeadingSections(source);
  const normalizedTarget = normalizeHeading(headingTarget);
  const targetSlug = createHeadingSlug(headingTarget);
  const headingIndex = headings.findIndex((heading) => (
    normalizeHeading(heading.title) === normalizedTarget
    || createHeadingSlug(heading.title) === targetSlug
  ));

  if (headingIndex < 0) {
    return null;
  }

  const heading = headings[headingIndex];
  const nextBoundary = headings.slice(headingIndex + 1).find((candidate) => (
    candidate.level <= heading.level
  ));
  const selectionEnd = nextBoundary?.from ?? source.length;

  return {
    heading: heading.title,
    headingLevel: heading.level,
    content: source.slice(heading.to, selectionEnd).trim(),
    position: heading.from,
    selectionEnd
  };
}

/** 根据当前文件目录解析相对 Markdown 文件链接。 */
function resolveWorkspaceFile(
  fileTarget: string,
  currentFilePath: string | undefined,
  workspaceFiles: readonly WorkspaceMarkdownFileMetadata[]
): WorkspaceMarkdownFileMetadata | undefined {
  const normalizedTarget = normalizeWorkspacePath(decodeLinkPart(fileTarget));
  const currentDirectory = normalizeWorkspacePath(currentFilePath ?? '').split('/').slice(0, -1);
  const resolvedTarget = normalizeWorkspacePath([...currentDirectory, normalizedTarget].join('/'));
  const exactFile = workspaceFiles.find((file) => (
    normalizeWorkspacePath(file.path).toLocaleLowerCase() === resolvedTarget.toLocaleLowerCase()
  ));

  if (exactFile) {
    return exactFile;
  }

  const targetSuffix = `/${normalizedTarget.toLocaleLowerCase()}`;
  const suffixMatches = workspaceFiles.filter((file) => (
    `/${normalizeWorkspacePath(file.path).toLocaleLowerCase()}`.endsWith(targetSuffix)
  ));

  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

/** 解析一个含标题锚点的链接目标并生成预览结果。 */
export async function resolveMarkdownInlineLinkPreview(
  options: ResolveMarkdownInlineLinkPreviewOptions
): Promise<MarkdownInlineLinkPreview | null> {
  const destination = options.destination.trim().replace(/^<|>$/g, '');
  const anchorIndex = destination.indexOf('#');

  if (anchorIndex < 0) {
    return null;
  }

  const fileTarget = destination.slice(0, anchorIndex).trim();
  const headingTarget = extractHeadingTarget(destination.slice(anchorIndex + 1));

  if (!headingTarget) {
    return null;
  }

  const targetFile = fileTarget
    ? resolveWorkspaceFile(fileTarget, options.currentFilePath, options.workspaceFiles)
    : undefined;
  const fileName = getMarkdownFileName(targetFile?.path ?? (fileTarget || options.currentFilePath));
  const targetSnapshot = targetFile
    ? await options.readWorkspaceFile(targetFile.path)
    : undefined;
  const source = fileTarget ? targetSnapshot?.content : options.currentContent;

  if (source === undefined) {
    return { kind: 'missing', fileName, heading: decodeLinkPart(headingTarget) };
  }

  const section = resolveHeadingSection(source, headingTarget);

  return section
    ? {
        kind: 'found',
        fileName,
        ...section,
        navigationTarget: targetFile && targetSnapshot
          ? {
              filePath: targetSnapshot.path,
              title: targetFile.relativePath.replace(/\\/g, '/').split('/').pop() ?? targetFile.relativePath,
              content: targetSnapshot.content,
              position: section.position,
              selectionEnd: section.selectionEnd
            }
          : undefined
      }
    : { kind: 'missing', fileName, heading: decodeLinkPart(headingTarget) };
}
