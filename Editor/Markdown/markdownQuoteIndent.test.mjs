/** 文件说明：验证编辑态引用缩进折叠范围只包含引用标记前的空白。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getMarkdownQuoteIndentLength } from './markdownQuoteIndent.ts';

test('返回引用标记前空格与制表符的数量', () => {
  assert.equal(getMarkdownQuoteIndentLength('                        > quote'), 24);
  assert.equal(getMarkdownQuoteIndentLength('\t  > quote'), 3);
});

test('非引用行没有可折叠的引用缩进', () => {
  assert.equal(getMarkdownQuoteIndentLength('    paragraph'), 0);
});
