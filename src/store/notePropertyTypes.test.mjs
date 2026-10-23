/**
 * 文件说明：验证笔记属性类型 Store 在面板重建后仍保持同名属性的用户选择。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPinia, setActivePinia } from 'pinia';

import { useNotePropertyTypesStore } from './notePropertyTypes.ts';

test('同一 Pinia 会话内重新获取 Store 时保留用户选择的属性类型', () => {
  setActivePinia(createPinia());
  const initialStore = useNotePropertyTypesStore();

  assert.equal(initialStore.getPropertyType('due'), 'list');
  assert.equal(initialStore.hasExplicitPropertyType('due'), false);

  initialStore.setPropertyType('due', 'date');

  const reopenedPanelStore = useNotePropertyTypesStore();
  assert.equal(reopenedPanelStore.getPropertyType('due'), 'date');
  assert.equal(reopenedPanelStore.hasExplicitPropertyType('due'), true);
});

test('重命名属性时复制显式类型并保留原属性类型', () => {
  setActivePinia(createPinia());
  const store = useNotePropertyTypesStore();

  store.setPropertyType('publishedAt', 'datetime');
  store.copyPropertyType('publishedAt', 'createdAt');

  assert.equal(store.getPropertyType('publishedAt'), 'datetime');
  assert.equal(store.getPropertyType('createdAt'), 'datetime');
});
