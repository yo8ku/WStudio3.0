/**
 * 文件说明：提供 Map 缓存的固定容量淘汰，保留最近写入的条目。
 */

/** 将插入顺序的 Map 裁剪到给定容量，最早写入的条目优先淘汰。 */
export function trimBoundedCache<Key, Value>(
  cache: Map<Key, Value>,
  maximumEntries: number,
  onDiscard?: (value: Value, key: Key) => void
): void {
  const normalizedMaximum = Math.max(0, Math.floor(maximumEntries));

  while (cache.size > normalizedMaximum) {
    const oldestEntry = cache.entries().next();
    if (oldestEntry.done) return;
    const [key, value] = oldestEntry.value;
    onDiscard?.(value, key);
    cache.delete(key);
  }
}
