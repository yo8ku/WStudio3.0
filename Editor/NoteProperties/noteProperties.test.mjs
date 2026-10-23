/**
 * 文件说明：验证笔记属性 Frontmatter 更新时的正文、未知字段和导航位置契约。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearNoteProperties,
  parseNoteDocument,
  removeNoteProperty,
  renameNoteProperty,
  sortNoteProperties,
  updateNotePropertyBoolean,
  updateNotePropertyText,
  updateNotePropertyValues
} from './noteProperties.ts';

test('创建属性时生成 Frontmatter、保留正文和重复标签', () => {
  const updated = updateNotePropertyValues('# 标题', 'tags', ['项目', '项目', ' 草稿 ']);
  const snapshot = parseNoteDocument(updated);

  assert.equal(snapshot.body, '# 标题');
  assert.deepEqual(snapshot.properties.tags, ['项目', '项目', '草稿']);
});

test('更新属性时保留未知字段与正文', () => {
  const original = '---\ntitle: 示例\ntags:\n  - 旧值\n---\n正文';
  const updated = updateNotePropertyValues(original, 'tags', ['新值']);

  assert.match(updated, /title: 示例/);
  assert.equal(parseNoteDocument(updated).body, '正文');
  assert.deepEqual(parseNoteDocument(updated).properties.tags, ['新值']);
});

test('布尔属性使用 YAML 标量并可在勾选与取消之间切换', () => {
  const original = '---\ntitle: 示例\ncompleted:\n  - 旧值\n---\n正文';
  const checked = updateNotePropertyBoolean(original, 'completed', true);
  const unchecked = updateNotePropertyBoolean(checked, 'completed', false);

  assert.match(checked, /completed: true/u);
  assert.doesNotMatch(checked, /completed:\s*\n\s*-/u);
  assert.deepEqual(parseNoteDocument(checked).properties.completed, ['true']);
  assert.match(unchecked, /completed: false/u);
  assert.deepEqual(parseNoteDocument(unchecked).properties.completed, ['false']);
  assert.equal(parseNoteDocument(unchecked).body, '正文');
});

test('文本属性使用 YAML 单值并保留自动换行内容', () => {
  const markdown = updateNotePropertyText('# 正文\n', 'summary', '第一行\n第二行：任意内容');
  const snapshot = parseNoteDocument(markdown);

  assert.deepEqual(snapshot.properties.summary, ['第一行\n第二行：任意内容']);
  assert.equal(snapshot.body, '# 正文\n');
});

test('日期时间属性完整保留小时和分钟', () => {
  const updated = updateNotePropertyValues(
    '---\n时间:\n  - 2026/08/10\n---\n正文',
    '时间',
    ['2026/08/10 01:38']
  );

  assert.deepEqual(parseNoteDocument(updated).properties['时间'], ['2026/08/10 01:38']);
});

test('无效 Frontmatter 保持在编辑器正文中供用户修复', () => {
  const original = '---\ntags: [未闭合\n---\n正文';
  const snapshot = parseNoteDocument(original);

  assert.equal(snapshot.invalidFrontmatter, true);
  assert.equal(snapshot.bodyStart, 0);
  assert.equal(snapshot.body, original);
});

test('移除属性时保留其他字段与正文', () => {
  const original = '---\ntitle: 示例\ntags:\n  - 标签\n---\n正文';
  const updated = removeNoteProperty(original, 'tags');

  assert.match(updated, /title: 示例/);
  assert.equal(parseNoteDocument(updated).presentPropertyKeys.has('tags'), false);
  assert.equal(parseNoteDocument(updated).body, '正文');
});

test('移除最后一个属性时清理空 Frontmatter', () => {
  const original = '---\ntags:\n  - 标签\n---\n正文';

  assert.equal(removeNoteProperty(original, 'tags'), '正文');
});

test('清除笔记属性时删除完整 Frontmatter 并原样保留正文', () => {
  const original = '---\ntitle: 示例\ntags:\n  - 标签\n---\n# 正文\n\n内容';

  assert.equal(clearNoteProperties(original), '# 正文\n\n内容');
  assert.equal(clearNoteProperties('# 无属性正文'), '# 无属性正文');
});

test('解析器按原顺序返回基础属性和自定义属性', () => {
  const original = '---\naliases:\n  - 别名\ncustom-field:\n  - 自定义值\ntags: []\n---\n正文';
  const snapshot = parseNoteDocument(original);

  assert.deepEqual(snapshot.propertyKeys, ['aliases', 'custom-field', 'tags']);
  assert.deepEqual(snapshot.properties['custom-field'], ['自定义值']);
});

test('重命名属性时保留属性顺序、重复值和正文', () => {
  const original = '---\ntitle: 示例\naliases:\n  - 重复\n  - 重复\ntags: []\n---\n正文';
  const updated = renameNoteProperty(original, 'aliases', 'custom-aliases');
  const snapshot = parseNoteDocument(updated);

  assert.deepEqual(snapshot.propertyKeys, ['title', 'custom-aliases', 'tags']);
  assert.deepEqual(snapshot.properties['custom-aliases'], ['重复', '重复']);
  assert.equal(snapshot.presentPropertyKeys.has('aliases'), false);
  assert.equal(snapshot.body, '正文');
});

test('纯数字属性名称按 Frontmatter 原始顺序展示和重命名', () => {
  const original = '---\n12: []\n1: []\n234324: []\n---\n正文';
  const originalSnapshot = parseNoteDocument(original);
  const renamed = renameNoteProperty(original, '1', '2');
  const renamedSnapshot = parseNoteDocument(renamed);

  assert.deepEqual(originalSnapshot.propertyKeys, ['12', '1', '234324']);
  assert.deepEqual(renamedSnapshot.propertyKeys, ['12', '2', '234324']);
});

test('属性名称支持中文、英文和数字自然升降序', () => {
  const original = '---\n中文: []\n标签10: []\naliases: []\n标签2: []\n日期: []\n---\n正文';
  const ascending = parseNoteDocument(sortNoteProperties(original, 'ascending'));
  const descending = parseNoteDocument(sortNoteProperties(original, 'descending'));

  assert.deepEqual(ascending.propertyKeys, ['标签2', '标签10', '日期', '中文', 'aliases']);
  assert.deepEqual(descending.propertyKeys, ['aliases', '中文', '日期', '标签10', '标签2']);
  assert.equal(ascending.body, '正文');
  assert.equal(descending.body, '正文');
});

test('重命名属性会拒绝空名称和已经存在的名称', () => {
  const original = '---\naliases: []\ntags: []\n---\n正文';

  assert.equal(renameNoteProperty(original, 'aliases', '   '), original);
  assert.equal(renameNoteProperty(original, 'aliases', 'tags'), original);
});
