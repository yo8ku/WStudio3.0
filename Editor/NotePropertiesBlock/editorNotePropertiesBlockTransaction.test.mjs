/**
 * 文件说明：验证笔记属性块将完整 Markdown 收敛为最小 CodeMirror 文档变更。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEditorNotePropertiesDocumentChange
} from './editorNotePropertiesBlockTransaction.ts';

/** 将单段变更应用到原文，验证生成结果。 */
function applyDocumentChange(currentValue, change) {
  if (!change) {
    return currentValue;
  }

  return `${currentValue.slice(0, change.from)}${change.insert}${currentValue.slice(change.to)}`;
}

test('相同文档不生成 CodeMirror 事务', () => {
  assert.equal(createEditorNotePropertiesDocumentChange('正文', '正文'), null);
});

test('首次创建 Frontmatter 时只在正文前插入属性源码', () => {
  const currentValue = '正文';
  const nextValue = '---\ntags:\n  - 示例\n---\n正文';
  const change = createEditorNotePropertiesDocumentChange(currentValue, nextValue);

  assert.deepEqual(change, {
    from: 0,
    to: 0,
    insert: '---\ntags:\n  - 示例\n---\n'
  });
  assert.equal(applyDocumentChange(currentValue, change), nextValue);
});

test('更新属性时最小变更不覆盖未修改正文', () => {
  const currentValue = '---\ntags:\n  - 旧值\n---\n正文内容';
  const nextValue = '---\ntags:\n  - 新值\n---\n正文内容';
  const change = createEditorNotePropertiesDocumentChange(currentValue, nextValue);

  assert.ok(change);
  assert.equal(change.to < currentValue.indexOf('正文内容'), true);
  assert.equal(applyDocumentChange(currentValue, change), nextValue);
});
