/**
 * 文件说明：验证笔记属性日期与日期时间的格式、范围和分段契约。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fromPickerDateValue,
  getDateSegments,
  normalizePropertyDate,
  toEditablePropertyDate,
  toPickerDateValue,
  toPropertyDateDraft
} from './notePropertyDateTime.ts';

test('日期时间在属性格式、编辑格式和选择器格式之间稳定转换', () => {
  const propertyValue = '2026/08/10 09:05';

  assert.equal(toEditablePropertyDate(propertyValue, 'datetime'), '2026 / 08 / 10  09:05');
  assert.equal(toPropertyDateDraft('2026 / 08 / 10  09:05'), propertyValue);
  assert.equal(toPickerDateValue(propertyValue, 'datetime'), '2026-08-10 09:05');
  assert.equal(fromPickerDateValue('2026-08-11 18:30', 'datetime'), '2026/08/11 18:30');
});

test('日期时间包含年月日时分五个固定编辑分段', () => {
  assert.deepEqual(getDateSegments('date'), ['year', 'month', 'day']);
  assert.deepEqual(getDateSegments('datetime'), ['year', 'month', 'day', 'hour', 'minute']);
});

test('本地 ISO 日期时间进入组件时规范化为属性日期时间', () => {
  const isoValue = '2026-08-10T05:34:00';

  assert.equal(toEditablePropertyDate(isoValue, 'datetime'), '2026 / 08 / 10  05:34');
  assert.equal(toPickerDateValue(isoValue, 'datetime'), '2026-08-10 05:34');
  assert.equal(fromPickerDateValue(isoValue, 'datetime'), '2026/08/10 05:34');
  assert.equal(normalizePropertyDate(isoValue, 'datetime'), '2026/08/10 05:34');
});

test('日期模式接收日期时间过渡值时丢弃时分', () => {
  assert.equal(toEditablePropertyDate('2026/05/08 01:30', 'date'), '2026 / 05 / 08');
  assert.equal(toEditablePropertyDate('2026/05/08 01', 'date'), '2026 / 05 / 08');
  assert.equal(toPickerDateValue('2026/05/08 01:30', 'date'), '2026-05-08');
  assert.equal(toPickerDateValue('2026/05/08 01', 'date'), '2026-05-08');
  assert.equal(normalizePropertyDate('2026/05/08 01:30', 'date'), '2026/05/08');
  assert.equal(normalizePropertyDate('2026/05/08 01', 'date'), '2026/05/08');
});

test('日期时间拒绝不存在日期和越界时分', () => {
  assert.equal(normalizePropertyDate('2026/02/29 12:30', 'datetime'), undefined);
  assert.equal(normalizePropertyDate('2026/08/10 24:00', 'datetime'), undefined);
  assert.equal(normalizePropertyDate('2026/08/10 23:60', 'datetime'), undefined);
  assert.equal(normalizePropertyDate('2026/08/10 23:59', 'datetime'), '2026/08/10 23:59');
});
