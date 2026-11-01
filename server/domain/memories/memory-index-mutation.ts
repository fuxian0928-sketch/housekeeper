import { database } from '../../db.js';

/** Synchronous index mutation plus revision, atomic even inside caller transactions.
 * SQLite virtual tables cannot use normal row triggers; every owned index writer
 * enters here. External connections are additionally covered by data_version.
 */
export function mutateMemoryIndex(write: () => void): void {
  database.exec('SAVEPOINT memory_index_write');
  try {
    write();
    database.prepare('UPDATE memory_context_revision SET revision=lower(hex(randomblob(16))) WHERE id=1').run();
    database.exec('RELEASE memory_index_write');
  } catch (error) {
    database.exec('ROLLBACK TO memory_index_write');
    database.exec('RELEASE memory_index_write');
    throw error;
  }
}
