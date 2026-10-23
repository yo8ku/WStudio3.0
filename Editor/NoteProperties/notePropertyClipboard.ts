/**
 * 文件说明：序列化、校验并读写笔记属性剪贴板数据，同时提供应用内可靠回退。
 */
import {
  isValidNotePropertyName,
  normalizeNotePropertyName,
  type NotePropertyKey
} from './notePropertyDefinitions.ts';
import { isNotePropertyType, type NotePropertyType } from './notePropertyTypes.ts';

const NOTE_PROPERTY_CLIPBOARD_SCHEMA = 'wstudio.note-property.v1';
/** 剪切、复制和粘贴共享的稳定属性载荷。 */
export interface NotePropertyClipboardPayload {
  readonly key: NotePropertyKey;
  readonly schema: typeof NOTE_PROPERTY_CLIPBOARD_SCHEMA;
  readonly type: NotePropertyType;
  readonly values: readonly string[];
}

let inMemoryClipboardPayload: NotePropertyClipboardPayload | undefined;

/** 创建经过规范化的属性剪贴板载荷。 */
export function createNotePropertyClipboardPayload(
  key: NotePropertyKey,
  type: NotePropertyType,
  values: readonly string[]
): NotePropertyClipboardPayload {
  return {
    key: normalizeNotePropertyName(key),
    schema: NOTE_PROPERTY_CLIPBOARD_SCHEMA,
    type,
    values: values.map(value => value.trim()).filter(Boolean)
  };
}

/** 将属性剪贴板载荷转换为可跨窗口传递的文本。 */
export function serializeNotePropertyClipboardPayload(
  payload: NotePropertyClipboardPayload
): string {
  return JSON.stringify(payload);
}

/** 从未知文本中安全解析属性剪贴板载荷。 */
export function parseNotePropertyClipboardPayload(
  serializedPayload: string
): NotePropertyClipboardPayload | undefined {
  try {
    const payload: unknown = JSON.parse(serializedPayload);

    if (
      typeof payload !== 'object'
      || payload === null
      || !('schema' in payload)
      || payload.schema !== NOTE_PROPERTY_CLIPBOARD_SCHEMA
      || !('key' in payload)
      || typeof payload.key !== 'string'
      || !isValidNotePropertyName(payload.key)
      || !('type' in payload)
      || !isNotePropertyType(payload.type)
      || !('values' in payload)
      || !Array.isArray(payload.values)
      || !payload.values.every(value => typeof value === 'string')
    ) {
      return undefined;
    }

    return createNotePropertyClipboardPayload(
      normalizeNotePropertyName(payload.key),
      payload.type,
      payload.values
    );
  } catch {
    return undefined;
  }
}

/** 写入系统剪贴板，并始终保存应用内副本作为权限失败时的回退。 */
export async function writeNotePropertyClipboardPayload(
  payload: NotePropertyClipboardPayload
): Promise<void> {
  inMemoryClipboardPayload = payload;

  try {
    await navigator.clipboard.writeText(serializeNotePropertyClipboardPayload(payload));
  } catch {
    // 系统剪贴板不可用时，应用内副本仍支持当前会话粘贴。
  }
}

/** 优先读取系统剪贴板中的合法载荷，不可用时返回应用内副本。 */
export async function readNotePropertyClipboardPayload(): Promise<NotePropertyClipboardPayload | undefined> {
  try {
    const payload = parseNotePropertyClipboardPayload(await navigator.clipboard.readText());
    if (payload) {
      inMemoryClipboardPayload = payload;
      return payload;
    }
  } catch {
    // 系统剪贴板不可用时继续读取应用内副本。
  }

  return inMemoryClipboardPayload;
}
