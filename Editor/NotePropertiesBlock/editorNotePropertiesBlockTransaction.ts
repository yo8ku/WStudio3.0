/**
 * 文件说明：计算笔记属性写回 CodeMirror 文档时所需的最小文本变更范围。
 */

/** CodeMirror 可直接消费的单段文档变更。 */
export interface EditorNotePropertiesDocumentChange {
  /** 被替换内容的起点。 */
  readonly from: number;
  /** 新写入的文本。 */
  readonly insert: string;
  /** 被替换内容的终点。 */
  readonly to: number;
}

/**
 * 通过公共前后缀提取最小变更，避免属性写回时替换整篇正文。
 */
export function createEditorNotePropertiesDocumentChange(
  currentValue: string,
  nextValue: string
): EditorNotePropertiesDocumentChange | null {
  if (currentValue === nextValue) {
    return null;
  }

  const maximumPrefixLength = Math.min(currentValue.length, nextValue.length);
  let prefixLength = 0;

  while (
    prefixLength < maximumPrefixLength
    && currentValue[prefixLength] === nextValue[prefixLength]
  ) {
    prefixLength += 1;
  }

  const maximumSuffixLength = Math.min(
    currentValue.length - prefixLength,
    nextValue.length - prefixLength
  );
  let suffixLength = 0;

  while (
    suffixLength < maximumSuffixLength
    && currentValue[currentValue.length - suffixLength - 1]
      === nextValue[nextValue.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  return {
    from: prefixLength,
    to: currentValue.length - suffixLength,
    insert: nextValue.slice(prefixLength, nextValue.length - suffixLength)
  };
}
