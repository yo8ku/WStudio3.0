/**
 * 文件说明：转换本地媒体协议 URL，并封装桌面宿主的图片选择与媒体文件拖拽。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { DEFAULT_WORKSPACE_FILE_TYPES } from '../../plugin/sdk/fileTypes';
import { isTauriRuntime } from './native';
import { createNativeSubscription } from './nativeEvents';
import type { DragDropEvent } from '@tauri-apps/api/webview';

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const POSIX_ABSOLUTE_PATH_PATTERN = /^\/(?!\/)/;

/** 判断是否为当前平台上的绝对本地路径。 */
function isLocalMediaPath(source: string): boolean {
  const trimmed = source.trim();
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)
    || POSIX_ABSOLUTE_PATH_PATTERN.test(trimmed);
}

/** 复用系统文件对话框选择单张图片；取消时不返回路径。 */
export async function pickLocalImageFile(): Promise<string | undefined> {
  const extensions = DEFAULT_WORKSPACE_FILE_TYPES
    .find((type) => type.kind === 'image')?.extensions.map((extension) => extension.slice(1)) ?? [];
  const selected = await open({
    title: '插入图像',
    directory: false,
    multiple: false,
    filters: [{ name: '图像', extensions }]
  });
  return typeof selected === 'string' ? selected : undefined;
}

/**
 * 判断媒体地址是否为 Windows 本地绝对路径或 UNC 路径。
 */
export function isWindowsLocalMediaPath(source: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(source.trim());
}

/** Resolve a relative media reference against the current Markdown file. */
export function resolveRelativeMediaPath(source: string, currentFilePath?: string): string {
  if (!currentFilePath || isLocalMediaPath(source)) {
    return source;
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) {
    return source;
  }

  const lastSeparator = Math.max(
    currentFilePath.lastIndexOf('\\'),
    currentFilePath.lastIndexOf('/')
  );

  if (lastSeparator < 0) {
    return source;
  }

  const separator = currentFilePath.includes('\\') ? '\\' : '/';
  return `${currentFilePath.slice(0, lastSeparator + 1)}${source.replace(/[\\/]/g, separator)}`;
}

/**
 * 将本地媒体路径转换为受控协议 URL，远程地址保持不变。
 */
export function resolveMediaSourceUrl(source: string, currentFilePath?: string): string {
  const normalizedSource = resolveRelativeMediaPath(
    source.trim().replace(/^<|>$/g, ''),
    currentFilePath?.trim()
  );

  if (!isLocalMediaPath(normalizedSource)) return normalizedSource;

  // Tauri maps the Rust media protocol to localhost on Windows.
  const baseUrl = convertFileSrc('local', 'wstudio-media');
  return `${baseUrl}?path=${encodeURIComponent(normalizedSource)}`;
}

/** DOM File 不提供可信本地路径；原生路径由 onNativeMediaDrop 传递。 */
export function getDroppedFilePath(_file: File): string {
  return '';
}

/** Tauri 原生文件拖拽事件的最小 DTO，坐标相对于当前 WebView 左上角。 */
export interface NativeMediaDropEvent {
  readonly paths: readonly string[];
  readonly position: {
    readonly x: number;
    readonly y: number;
  };
}

/**
 * 监听 Tauri 原生文件拖拽并返回可重复调用的释放函数。
 * 监听建立是异步的，因此快速销毁时需要回收稍后才返回的 unlisten。
 */
export function onNativeMediaDrop(
  listener: (event: NativeMediaDropEvent) => void
): () => void {
  if (!isTauriRuntime()) {
    return () => undefined;
  }

  return createNativeSubscription<DragDropEvent>('native-media-drop',
    handler => getCurrentWebview().onDragDropEvent(event => handler(event.payload)), payload => {
    if (payload.type !== 'drop') return;
    listener({
      paths: payload.paths,
      position: {
        x: payload.position.x,
        y: payload.position.y
      }
    });
  });
}
