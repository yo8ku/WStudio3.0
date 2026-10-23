/**
 * 文件说明：定义 Message 组件支持的显示位置与消息类型。
 */
export type MessageLocation =
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export type MessageType = 'info' | 'normal' | 'success' | 'warning' | 'error';
