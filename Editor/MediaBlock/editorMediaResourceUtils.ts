/**
 * 文件说明：为编辑器中的本地图片、音频与视频提供统一的资源存在性探测。
 */

const LOCAL_MEDIA_SCHEME_PREFIX = 'wstudio-media://';

/** 本地媒体资源探测所需的原生元素类型。 */
export type EditorMediaResourceKind = 'image' | 'audio' | 'video';

/** 为本地媒体协议追加一次性查询参数，绕过浏览器对旧响应的复用。 */
function createRefreshUrl(sourceUrl: string, refreshToken: number): string {
  const separator = sourceUrl.includes('?') ? '&' : '?';
  return `${sourceUrl}${separator}refresh=${encodeURIComponent(String(refreshToken))}`;
}

/**
 * 重新探测本地媒体文件；远程 URL 不参与文件系统校验。
 *
 * 使用未挂载到 DOM 的原生媒体元素，避免渲染进程跨域 fetch 被协议 CORS
 * 策略误判为失败；资源仍然存在时不会触碰当前块的图片或播放器。
 */
export async function isLocalMediaResourceAvailable(
  sourceUrl: string,
  kind: EditorMediaResourceKind,
  refreshToken: number
): Promise<boolean> {
  if (!sourceUrl.startsWith(LOCAL_MEDIA_SCHEME_PREFIX)) {
    return true;
  }

  return new Promise((resolve) => {
    const probe = kind === 'image'
      ? new Image()
      : document.createElement(kind);
    let settled = false;
    let timeoutId = 0;

    const settle = (available: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timeoutId);
      probe.removeAttribute('src');
      if (probe instanceof HTMLMediaElement) {
        probe.load();
      }
      resolve(available);
    };

    timeoutId = window.setTimeout(() => settle(false), 10_000);
    if (probe instanceof HTMLImageElement) {
      probe.addEventListener('load', () => settle(true), { once: true });
      probe.addEventListener('error', () => settle(false), { once: true });
    } else {
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => settle(true), { once: true });
      probe.addEventListener('error', () => settle(false), { once: true });
    }

    probe.src = createRefreshUrl(sourceUrl, refreshToken);
  });
}
