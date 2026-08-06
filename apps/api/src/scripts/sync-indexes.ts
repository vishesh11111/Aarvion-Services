/**
 * Index synchronisation — MongoDB's answer to "run the migrations".
 *
 * MongoDB is schemaless, so there is no DDL to version. What *does* need
 * deliberate management is indexes: they are the difference between a query that
 * takes 2ms and one that scans a collection, and building one on a large
 * collection is a real operation with a real cost.
 *
 * `autoIndex` is disabled on the connection precisely so this never happens
 * implicitly. Mongoose's default of building indexes on every process start is
 * fine on a laptop and actively dangerous in production: every replica racing to
 * build the same index on deploy.
 *
 * Run as a deploy step, exactly like `migrate deploy`:
 *     npm run db:indexes          (development)
 *     npm run db:indexes:prod     (compiled, in the container)
 *
 * `syncIndexes()` is declarative: it creates what is missing and drops indexes
 * that are no longer declared in the schema, so the database converges on what
 * the code says. Index builds on MongoDB 4.2+ are non-blocking for reads and
 * writes, which is why this is safe to run against a live cluster — but on a
 * very large collection it still consumes I/O, so prefer a quiet window.
 */
import { connectDatabase, disconnectDatabase, mongoose } from '../lib/db';
import { createLogger } from '../lib/logger';
import {
  AiInteractionModel,
  AuditLogModel,
  ImportErrorModel,
  ImportJobModel,
  LeadActivityModel,
  LeadModel,
  OrganizationModel,
  RefreshTokenModel,
  SavedViewModel,
  UserModel,
} from '../models';

const log = createLogger('sync-indexes');

const MODELS = [
  OrganizationModel,
  UserModel,
  RefreshTokenModel,
  LeadModel,
  LeadActivityModel,
  ImportJobModel,
  ImportErrorModel,
  AuditLogModel,
  AiInteractionModel,
  SavedViewModel,
];

export const syncAllIndexes = async (): Promise<void> => {
  for (const model of MODELS) {
    const started = Date.now();
    // Returns the names of any indexes it dropped, which is worth surfacing —
    // an unexpected drop means someone removed an index declaration.
    const dropped = await model.syncIndexes();
    const indexes = await model.listIndexes();

    log.info(
      {
        collection: model.collection.collectionName,
        indexes: indexes.length,
        dropped: dropped.length > 0 ? dropped : undefined,
        durationMs: Date.now() - started,
      },
      'indexes synchronised',
    );
  }
};

const main = async (): Promise<void> => {
  await connectDatabase();
  log.info({ database: mongoose.connection.name }, 'connected');

  await syncAllIndexes();

  console.log('\nIndexes are up to date.\n');
  await disconnectDatabase();
};

// Only run when invoked directly, so tests can import `syncAllIndexes` freely.
if (require.main === module) {
  main().catch((error: Error) => {
    console.error('Index sync failed:', error.message);
    process.exit(1);
  });
}
