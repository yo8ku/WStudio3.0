/**
 * 文件说明：协调脚注引用索引与 DockingThree，实现跨文件标签打开和编辑器定位。
 */
import type { EditorFootnoteReference } from '@editor/Footnote/editorFootnoteReferenceIndex';
import { workspaceApi } from '@/api/workspace';
import { useDockingThreeStore } from '@/store/dockingThree';
import { useFootnoteReferenceStore } from '@/store/footnoteReferences';

/** 打开引用所属 Markdown 文件并定位到引用位置。 */
export async function navigateToFootnoteReference(reference: EditorFootnoteReference): Promise<void> {
  if (!reference.documentId) {
    return;
  }

  const footnoteReferenceStore = useFootnoteReferenceStore();
  const fileMetadata = footnoteReferenceStore.getFile(reference.documentId);

  if (!fileMetadata) {
    return;
  }

  const file = await workspaceApi.readMarkdownFile(fileMetadata.path);
  if (!file) return;

  const pathSegments = fileMetadata.relativePath.split(/[\\/]/);
  const title = pathSegments[pathSegments.length - 1] ?? file.relativePath;
  useDockingThreeStore().openTextFileAtPosition({
    filePath: file.path,
    title,
    content: file.content,
    position: reference.from
  });
}
