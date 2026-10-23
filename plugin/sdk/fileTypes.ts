/**
 * 文件说明：定义 WStudio 工作区默认支持的文件类型、扩展名和媒体 MIME 类型。
 */

/** 工作区文件的默认打开类别。 */
export type PluginWorkspaceFileKind = 'text' | 'image' | 'video' | 'audio';

/** 宿主文本编辑器允许直接载入的最大文件大小。 */
export const MAX_WORKSPACE_TEXT_FILE_SIZE = 2 * 1024 * 1024;

/** 描述一个默认工作区文件类别及其扩展名集合。 */
export interface PluginWorkspaceFileTypeDefinition {
  readonly kind: PluginWorkspaceFileKind;
  readonly extensions: readonly string[];
}

/** 文件列表和编辑器默认支持的工作区文件类别。 */
export const DEFAULT_WORKSPACE_FILE_TYPES: readonly PluginWorkspaceFileTypeDefinition[] = [
  {
    kind: 'text',
    extensions: [
      // Plain text.
      '.txt', '.text', '.log', '.out', '.url',
      // Markdown and document markup.
      '.md', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn', '.rst', '.adoc', '.asciidoc', '.tex',
      '.html', '.htm', '.xhtml', '.xml', '.xsl', '.xsd',
      // Configuration files.
      '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.config', '.properties',
      // Data files.
      '.csv', '.tsv', '.jsonl', '.ndjson'
    ]
  },
  {
    kind: 'image',
    extensions: ['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']
  },
  {
    kind: 'video',
    extensions: ['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.ogv', '.webm']
  },
  {
    kind: 'audio',
    extensions: ['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']
  }
];

const FILE_KIND_BY_EXTENSION = new Map<string, PluginWorkspaceFileKind>(
  DEFAULT_WORKSPACE_FILE_TYPES.flatMap(({ kind, extensions }) => (
    extensions.map(extension => [extension, kind] as const)
  ))
);

/** 解码可编辑文本，兼容 UTF-8、带 BOM 的 UTF-16 和常见中文 GB18030 文件。 */
export function decodeWorkspaceText(fileData: Uint8Array): string | undefined {
  const encodings = fileData[0] === 0xff && fileData[1] === 0xfe
    ? ['utf-16le']
    : fileData[0] === 0xfe && fileData[1] === 0xff
      ? ['utf-16be']
      : ['utf-8'];

  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(fileData);
    } catch {
      // Try the next supported text encoding.
    }
  }

  const sample = fileData.subarray(0, Math.min(fileData.byteLength, 8192));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20)) return undefined;
    if (byte === 0x7f) controlBytes += 1;
  }
  if (sample.length > 0 && controlBytes / sample.length > 0.01) return undefined;

  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(fileData);
  } catch {
    return undefined;
  }
}

/** 返回路径的小写扩展名；没有扩展名时返回空字符串。 */
export function getWorkspaceFileExtension(filePath: string): string {
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const extensionIndex = fileName.lastIndexOf('.');

  return extensionIndex > 0 ? fileName.slice(extensionIndex).toLowerCase() : '';
}

/** 根据路径返回默认工作区文件类别。 */
export function resolveWorkspaceFileKind(filePath: string): PluginWorkspaceFileKind | undefined {
  return FILE_KIND_BY_EXTENSION.get(getWorkspaceFileExtension(filePath));
}

/** 判断路径是否属于默认文件列表可显示的文件格式。 */
export function isDefaultWorkspaceFile(filePath: string): boolean {
  return resolveWorkspaceFileKind(filePath) !== undefined;
}

/** 返回默认媒体类别对应的 MIME 类型，未知时由浏览器按资源扩展名处理。 */
export function resolveWorkspaceMediaMimeType(filePath: string): string | undefined {
  const extension = getWorkspaceFileExtension(filePath);

  switch (extension) {
    case '.avif':
      return 'image/avif';
    case '.bmp':
      return 'image/bmp';
    case '.gif':
      return 'image/gif';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.avi':
      return 'video/x-msvideo';
    case '.m4v':
      return 'video/x-m4v';
    case '.mkv':
      return 'video/x-matroska';
    case '.mov':
      return 'video/quicktime';
    case '.mp4':
      return 'video/mp4';
    case '.ogv':
      return 'video/ogg';
    case '.webm':
      return 'video/webm';
    case '.aac':
      return 'audio/aac';
    case '.flac':
      return 'audio/flac';
    case '.m4a':
      return 'audio/mp4';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.opus':
      return 'audio/opus';
    case '.wav':
      return 'audio/wav';
    default:
      return undefined;
  }
}
