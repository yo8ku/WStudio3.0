/** Holds the transient response state shared by the inline input and response blocks. */
export interface InlineChatResponseState {
  markdown: string;
  error: string;
  isStreaming: boolean;
}

/** Creates a fresh response state for one inline-chat marker. */
export function createInlineChatResponseState(): InlineChatResponseState {
  return {
    markdown: '',
    error: '',
    isStreaming: false
  };
}
