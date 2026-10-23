import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = fileName => fs.readFileSync(path.join(directory, fileName), 'utf8');

test('宿主字体入口定义基础 icon class', () => {
  const source = read('index.scss');

  assert.match(source, /\.icon\s*\{/);
  assert.match(source, /font-family:\s*['"]Untitled['"]/);
});

test('应用入口全局引入字体包 CSS', () => {
  const source = read('../main.ts');

  assert.match(source, /import ['"]\.\/assets\/iconfont\/style\.css['"];?/);
});

test('宿主图标使用 content codepoint', () => {
  const source = read('icons.scss');

  assert.match(source, /\.icon-arrow-back::before\s*\{[^}]*content:\s*['"]\\f078['"]/s);
  assert.match(source, /\.icon-close::before\s*\{[^}]*content:\s*['"]\\f0a2['"]/s);
  assert.match(source, /\.icon-search::before\s*\{[^}]*content:\s*['"]\\f0a4['"]/s);
});

test('宿主图标入口不再生成普通 SVG 图标', () => {
  const settingsIcon = read('../components/WsSettingsIcon/WsSettingsIcon.vue');
  const vuetify = read('../plugins/vuetify.ts');
  const pluginSettings = read('../components/workbench/PluginSettingDefinitionList.vue');

  assert.doesNotMatch(settingsIcon, /<svg\b/u);
  assert.doesNotMatch(vuetify, /mdi-svg/u);
  assert.doesNotMatch(pluginSettings, /mdi-[a-z-]+/u);
});
