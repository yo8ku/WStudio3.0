/**
 * 文件说明：通过 Tauri 调用 Rust SQLite 服务的异步 CRUD 接口。
 */
import type { SqlQueryRequest, SqlRow, SqlRunResult } from '../../sql/types';

import { nativeApi } from './native';

export const sqlApi = {
  /** 执行建表、建索引等不返回行集的 SQL。 */
  exec(request: SqlQueryRequest): Promise<void> {
    return nativeApi.sql.exec(request);
  },

  /** 执行 INSERT、UPDATE 或 DELETE。 */
  run(request: SqlQueryRequest): Promise<SqlRunResult> {
    return nativeApi.sql.run(request);
  },

  /** 查询单行记录。 */
  get(request: SqlQueryRequest): Promise<SqlRow | undefined> {
    return nativeApi.sql.get(request);
  },

  /** 查询多行记录；建议 SQL 始终带 LIMIT 或游标条件。 */
  all(request: SqlQueryRequest): Promise<SqlRow[]> {
    return nativeApi.sql.all(request);
  }
};

