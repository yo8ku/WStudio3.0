/**
 * 文件说明：验证声明式插件设置定义的解析、条件计算和字段值校验。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PluginSettingField } from '../sdk';
import {
  PluginSettingDefinitionError,
  evaluatePluginSettingCondition,
  flattenPluginSettingDefinitions,
  parsePluginSettingPageDefinition,
  validatePluginSettingValue
} from './model';

test('声明式设置页解析分组、条件和校验规则', () => {
  const page = parsePluginSettingPageDefinition({
    id: 'test.settings.appearance',
    title: '外观',
    definitions: [
      {
        type: 'group',
        id: 'test.settings.theme-group',
        title: '主题',
        items: [
          {
            id: 'test.settings.theme',
            label: '主题',
            type: 'select',
            defaultValue: 'system',
            options: [
              { label: '跟随系统', value: 'system' },
              { label: '深色', value: 'dark' }
            ]
          },
          {
            id: 'test.settings.custom-theme',
            label: '自定义主题',
            type: 'text',
            visible: {
              fieldId: 'test.settings.theme',
              operator: 'equals',
              value: 'dark'
            },
            validate: [
              { type: 'required', message: '自定义主题不能为空。' }
            ]
          }
        ]
      }
    ]
  }, 'test.settings');

  assert.equal(page.definitions?.length, 1);
  assert.deepEqual(
    flattenPluginSettingDefinitions(page.definitions ?? []).map(field => field.id),
    ['test.settings.theme', 'test.settings.custom-theme']
  );
});

test('声明式条件只读取同页字段快照', () => {
  const condition = {
    fieldId: 'test.settings.mode',
    operator: 'equals' as const,
    value: 'advanced'
  };
  assert.equal(evaluatePluginSettingCondition(condition, {
    'test.settings.mode': 'advanced'
  }, false), true);
  assert.equal(evaluatePluginSettingCondition(condition, {
    'test.settings.mode': 'simple'
  }, false), false);
});

test('字段声明式校验返回插件提供的错误消息', () => {
  const field: PluginSettingField = {
    id: 'test.settings.endpoint',
    label: '地址',
    type: 'text',
    validate: [
      { type: 'required', message: '地址不能为空。' },
      { type: 'pattern', value: '^https://', message: '地址必须使用 HTTPS。' }
    ]
  };
  assert.equal(validatePluginSettingValue(field, '')?.message, '地址不能为空。');
  assert.equal(validatePluginSettingValue(field, 'http://example.com')?.message, '地址必须使用 HTTPS。');
  assert.equal(validatePluginSettingValue(field, 'https://example.com'), undefined);
});

test('设置条件引用未声明字段时拒绝注册', () => {
  assert.throws(
    () => parsePluginSettingPageDefinition({
      id: 'test.settings.appearance',
      definitions: [
        {
          id: 'test.settings.theme',
          label: '主题',
          type: 'text',
          visible: {
            fieldId: 'test.settings.missing',
            operator: 'equals',
            value: true
          }
        }
      ]
    }, 'test.settings'),
    (error: unknown) => error instanceof PluginSettingDefinitionError
      && error.code === 'PLUGIN_SETTING_DEFINITION_INVALID'
  );
});

test('设置定义支持递归子页面、工作区路径字段和只读状态行', () => {
  const page = parsePluginSettingPageDefinition({
    id: 'test.settings.files',
    definitions: [
      {
        type: 'page',
        id: 'test.settings.files.detail',
        title: '详细配置',
        items: [
          {
            id: 'test.settings.files.source',
            label: '源文件',
            type: 'file',
            defaultValue: 'notes/source.md',
            extensions: ['.md']
          },
          {
            id: 'test.settings.files.output',
            label: '输出目录',
            type: 'folder',
            defaultValue: 'exports'
          },
          {
            type: 'status',
            id: 'test.settings.files.status',
            label: '状态',
            value: '就绪'
          }
        ]
      }
    ]
  }, 'test.settings');

  assert.equal(page.definitions?.[0]?.type, 'page');
  assert.deepEqual(
    flattenPluginSettingDefinitions(page.definitions ?? []).map(field => field.id),
    ['test.settings.files.source', 'test.settings.files.output']
  );
});

test('工作区路径字段拒绝绝对路径和路径穿越', () => {
  assert.throws(
    () => parsePluginSettingPageDefinition({
      id: 'test.settings.files',
      definitions: [{
        id: 'test.settings.files.source',
        label: '源文件',
        type: 'file',
        defaultValue: '../outside.md'
      }]
    }, 'test.settings'),
    (error: unknown) => error instanceof PluginSettingDefinitionError
      && error.code === 'PLUGIN_SETTING_DEFINITION_INVALID'
  );
  assert.throws(
    () => parsePluginSettingPageDefinition({
      id: 'test.settings.files',
      definitions: [{
        id: 'test.settings.files.source',
        label: '源文件',
        type: 'file',
        defaultValue: 'notes/source.txt',
        extensions: ['.md']
      }]
    }, 'test.settings'),
    (error: unknown) => error instanceof PluginSettingDefinitionError
      && error.code === 'PLUGIN_SETTING_DEFINITION_INVALID'
  );
});
