/**
 * 文件说明：验证笔记属性类型切换时的初始数据转换契约。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  convertNotePropertyValues,
  normalizeNotePropertyNumber,
  sanitizeNotePropertyNumberInput
} from './notePropertyTypes.ts';

test('切换为列表时丢弃旧类型数据并返回空列表', () => {
  assert.deepEqual(convertNotePropertyValues('list', ['false']), []);
  assert.deepEqual(convertNotePropertyValues('list', ['旧值']), []);
});

test('切换为数字时默认内容为空', () => {
  assert.deepEqual(convertNotePropertyValues('number', ['旧值']), []);
});

test('切换为文本时将多个旧值合并为单个多行文本', () => {
  assert.deepEqual(convertNotePropertyValues('text', ['第一行', '第二行']), ['第一行\n第二行']);
  assert.deepEqual(convertNotePropertyValues('text', []), []);
});

test('数字输入过滤字母、多余符号和小数点', () => {
  assert.equal(sanitizeNotePropertyNumberInput('a-12.3.4b'), '-12.34');
  assert.equal(sanitizeNotePropertyNumberInput('1e2'), '12');
  assert.equal(sanitizeNotePropertyNumberInput('快快快'), '');
});

test('数字提交支持正负数和小数并拒绝无效输入', () => {
  assert.equal(normalizeNotePropertyNumber('-12.50'), '-12.5');
  assert.equal(normalizeNotePropertyNumber('+.75'), '0.75');
  assert.equal(normalizeNotePropertyNumber('-'), undefined);
  assert.equal(normalizeNotePropertyNumber('.'), undefined);
});

test('数字提交保留超长整数，不转换为科学计数法', () => {
  assert.equal(
    normalizeNotePropertyNumber('1111111111111111111111'),
    '1111111111111111111111'
  );
});
