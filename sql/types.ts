/**
 * 文件说明：定义 SQLite 服务在主进程、Worker 和 IPC 之间共享的数据类型。
 */

/** SQLite 可绑定的参数类型。 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** SQLite 查询返回的单行记录。 */
export type SqlRow = Record<string, SqlValue>;

/** 带参数的 SQL 请求。参数必须使用占位符绑定，避免拼接用户输入。 */
export interface SqlQueryRequest {
  sql: string;
  params?: readonly SqlValue[];
}

/** INSERT、UPDATE、DELETE 执行后的变更信息。 */
export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

