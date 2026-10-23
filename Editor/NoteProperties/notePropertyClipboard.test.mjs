/**
 * 文件说明：验证笔记属性剪贴板载荷的序列化、校验和重复值保留契约。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createNotePropertyClipboardPayload,
  parseNotePropertyClipboardPayload,
  serializeNotePropertyClipboardPayload
} from './notePropertyClipboard.ts';

test('属性剪贴板载荷往返时保留类型与重复值', () => {
  const payload = createNotePropertyClipboardPayload(
    'tags',
    'list',
    [' 标签 ', '标签']
  );

  assert.deepEqual(
    parseNotePropertyClipboardPayload(serializeNotePropertyClipboardPayload(payload)),
    {
      key: 'tags',
      schema: 'wstudio.note-property.v1',
      type: 'list',
      values: ['标签', '标签']
    }
  );
});

test('属性剪贴板解析会拒绝普通文本和未知类型', () => {
  assert.equal(parseNotePropertyClipboardPayload('普通文本'), undefined);
  assert.equal(parseNotePropertyClipboardPayload(JSON.stringify({
    key: 'tags',
    schema: 'wstudio.note-property.v1',
    type: 'unknown',
    values: []
  })), undefined);
});

test('属性剪贴板支持合法的自定义属性名称', () => {
  const payload = createNotePropertyClipboardPayload('custom-field', 'text', ['内容']);
  const parsed = parseNotePropertyClipboardPayload(
    serializeNotePropertyClipboardPayload(payload)
  );

  assert.equal(parsed?.key, 'custom-field');
  assert.deepEqual(parsed?.values, ['内容']);
});
