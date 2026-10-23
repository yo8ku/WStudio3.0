/**
 * 文件说明：根据工作区标签的文件路径与媒体信息解析状态栏使用的文档类型名称。
 */
import type { DockingThreeTab } from '@/DockingThree/types';
import {
  getWorkspaceFileExtension,
  resolveWorkspaceFileKind
} from '../../plugin/sdk/fileTypes';

const TEXT_DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  '.json': 'JSON',
  '.jsonc': 'JSONC',
  '.md': 'Markdown',
  '.markdown': 'Markdown',
  '.text': 'Plain Text',
  '.txt': 'Plain Text'
};

const MEDIA_DOCUMENT_LABELS = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio'
} as const;

/** 解析指定活动标签在状态栏中显示的文档类型名称。 */
export function resolveDocumentTypeLabel(tab: DockingThreeTab | undefined): string {
  if (!tab) {
    return '';
  }

  if (!tab.filePath) {
    return '';
  }

  const extension = getWorkspaceFileExtension(tab.filePath);
  const textLabel = TEXT_DOCUMENT_LABELS[extension];

  if (textLabel) {
    return textLabel;
  }

  const fileKind = resolveWorkspaceFileKind(tab.filePath);

  if (fileKind && fileKind !== 'text') {
    return MEDIA_DOCUMENT_LABELS[fileKind];
  }

  const mimeCategory = tab.mediaMimeType?.split('/', 1)[0];

  if (mimeCategory === 'image' || mimeCategory === 'video' || mimeCategory === 'audio') {
    return MEDIA_DOCUMENT_LABELS[mimeCategory];
  }

  return extension ? extension.slice(1).toUpperCase() : '';
}
