export const PACKAGE_NAME = '@specledger/db';

export { openDatabase } from './database.js';
export type { Database, DatabaseOptions } from './database.js';
export { StoredRowInvalidError } from './repositories.js';
export type { NewDocument, NewField, NewReviewEvent, Repositories } from './repositories.js';
