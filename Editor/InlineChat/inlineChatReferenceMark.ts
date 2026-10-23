/** Defines the semantic inline mark used for @ file references in inline chat. */
import { Mark, mergeAttributes } from '@tiptap/core';

export const inlineChatReferenceMark = Mark.create({
  name: 'inlineChatReference',
  inclusive: false,
  addAttributes() {
    return {
      referencePath: {
        default: null,
        parseHTML: element => element.getAttribute('data-reference-path'),
        renderHTML: attributes => {
          const referencePath = attributes.referencePath;
          return typeof referencePath === 'string'
            ? { 'data-reference-path': referencePath }
            : {};
        }
      }
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-inline-chat-reference]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'cm-editor-inline-chat__reference',
        'data-inline-chat-reference': ''
      }),
      0
    ];
  }
});
