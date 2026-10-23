/** Provides the document-level lifecycle operation for transient inline-chat blocks. */
export const INLINE_CHAT_MARKER = '<!-- wstudio-inline-chat -->';

/** Marks the rendered inline-chat block as UI-only for persistence boundaries. */
export const INLINE_CHAT_TRANSIENT_ATTRIBUTE = 'data-editor-block-transient';
export const INLINE_CHAT_TRANSIENT_VALUE = 'true';
export const INLINE_CHAT_TYPE_ATTRIBUTE = 'data-editor-block-type';
export const INLINE_CHAT_TYPE = 'inline-chat';
export const INLINE_CHAT_SELECTOR = `[${INLINE_CHAT_TYPE_ATTRIBUTE}="${INLINE_CHAT_TYPE}"]`;
export const INLINE_CHAT_RESPONSE_TYPE = 'inline-chat-response';
export const INLINE_CHAT_RESPONSE_SELECTOR = `[${INLINE_CHAT_TYPE_ATTRIBUTE}="${INLINE_CHAT_RESPONSE_TYPE}"]`;
export const INLINE_CHAT_WIDGET_SELECTOR = `${INLINE_CHAT_SELECTOR}, ${INLINE_CHAT_RESPONSE_SELECTOR}`;

/** Applies the explicit transient identity used by editor block integrations. */
export function markInlineChatElement(
  element: HTMLElement,
  type: typeof INLINE_CHAT_TYPE | typeof INLINE_CHAT_RESPONSE_TYPE = INLINE_CHAT_TYPE
): void {
  element.setAttribute(INLINE_CHAT_TRANSIENT_ATTRIBUTE, INLINE_CHAT_TRANSIENT_VALUE);
  element.setAttribute(INLINE_CHAT_TYPE_ATTRIBUTE, type);
}

/** Removes all transient inline-chat blocks before an editor document is closed or reopened. */
export function closeInlineChat(content: string): string {
  return content.split(INLINE_CHAT_MARKER).join('');
}
