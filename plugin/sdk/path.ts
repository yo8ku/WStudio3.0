/** 文件说明：提供跨进程复用的路径显示格式化纯函数。 */

export type PathDisplayMode = 'full' | 'with-drive' | 'compact';

/** 返回标准化后的完整路径，作为其他显示模式的处理基础。 */
export function fullFilePath(filePath: string): string {
  const separator = filePath.includes('\\') ? '\\' : '/';
  return filePath.replace(/[\\/]+/gu, separator);
}

/** 隐藏 Windows 盘符，但保留根路径分隔符。 */
export function filePathWithoutDrive(filePath: string): string {
  return fullFilePath(filePath).replace(/^[A-Za-z]:/u, '');
}

/** 层级忽略：保留首层与末层，例如 Backup\...\wstudio。 */
export function compactFilePath(filePath: string): string {
  const completePath = fullFilePath(filePath);
  const separator = completePath.includes('\\') ? '\\' : '/';
  const pathWithoutRoot = filePathWithoutDrive(completePath)
    .replace(new RegExp(`^${separator === '\\' ? '\\\\' : '/'}+`, 'u'), '');
  const segments = pathWithoutRoot.split(separator).filter(Boolean);

  if (segments.length <= 2) return filePathWithoutDrive(completePath);
  return separator + segments[0] + separator + '...' + separator + segments[segments.length - 1];
}

/** 保留盘符并按层级忽略规则压缩路径。 */
export function filePathWithDrive(filePath: string): string {
  const completePath = fullFilePath(filePath);
  const separator = completePath.includes('\\') ? '\\' : '/';
  const drive = completePath.match(/^[A-Za-z]:/u)?.[0];
  if (!drive) return compactFilePath(completePath);

  const pathWithoutRoot = filePathWithoutDrive(completePath)
    .replace(new RegExp(`^${separator === '\\' ? '\\\\' : '/'}+`, 'u'), '');
  const segments = pathWithoutRoot.split(separator).filter(Boolean);
  if (segments.length <= 3) return completePath;
  return `${drive}${separator}${segments[0]}${separator}...${separator}${segments[segments.length - 1]}`;
}

/** 从完整路径统一派生指定显示模式，供全局调用。 */
export function formatFilePath(filePath: string, mode: PathDisplayMode): string {
  const completePath = fullFilePath(filePath);
  if (mode === 'full') return completePath;
  if (mode === 'with-drive') return filePathWithDrive(completePath);
  return compactFilePath(completePath);
}
