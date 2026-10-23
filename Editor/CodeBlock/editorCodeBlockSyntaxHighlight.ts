/**
 * 文件说明：为 Markdown 围栏代码块提供官方语言按需加载列表与跨语言统一语义高亮 class。
 */
import { HighlightStyle, LanguageDescription } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';

const jsonWithCommentsLanguage = LanguageDescription.of({
  name: 'JSON with Comments',
  alias: ['jsonc'],
  extensions: ['jsonc'],
  support: json()
});

/** Markdown 围栏代码块支持的语言描述，具体解析器由 CodeMirror 按需加载。 */
export const editorCodeBlockLanguages = [
  jsonWithCommentsLanguage,
  ...languages
];

/** 将不同语言解析器产生的标准 Lezer 标签映射为同一套代码块语义 class。 */
export const editorCodeBlockHighlightStyle = HighlightStyle.define([
  {
    tag: tags.punctuation,
    class: 'cm-editor-code-token--punctuation'
  },
  {
    tag: tags.operator,
    class: 'cm-editor-code-token--operator'
  },
  {
    tag: [tags.keyword, tags.meta],
    class: 'cm-editor-code-token--keyword'
  },
  {
    tag: tags.comment,
    class: 'cm-editor-code-token--comment'
  },
  {
    tag: [tags.string, tags.regexp, tags.escape],
    class: 'cm-editor-code-token--string'
  },
  {
    tag: tags.number,
    class: 'cm-editor-code-token--number'
  },
  {
    tag: tags.variableName,
    class: 'cm-editor-code-token--variable'
  },
  {
    tag: tags.propertyName,
    class: 'cm-editor-code-token--property'
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    class: 'cm-editor-code-token--type'
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    class: 'cm-editor-code-token--function'
  },
  {
    tag: tags.constant(tags.variableName),
    class: 'cm-editor-code-token--constant'
  },
  {
    tag: tags.bool,
    class: 'cm-editor-code-token--boolean'
  },
  {
    tag: [tags.null, tags.atom, tags.unit],
    class: 'cm-editor-code-token--null'
  },
  {
    tag: tags.invalid,
    class: 'cm-editor-code-token--invalid'
  }
]);
