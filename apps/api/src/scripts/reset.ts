/**
 * Drops every collection in the configured database.
 *
 * Development convenience, equivalent to `migrate reset`. Guarded twice: it
 * refuses to run when `NODE_ENV=production`, and it refuses to touch a database
 * whose name does not look like a development or test database. Both guards
 * exist because the single most expensive mistake a script like this can make is
 * running against the wrong `MONGODB_URI` — and that URI usually comes from an
 * environment variable someone forgot to change.
 */
import { connectDatabase, disconnectDatabase, mongoose } from '../lib/db';
import { env } from '../config/env';

const SAFE_NAME = /(test|dev|local|staging)/i;

const main = async (): Promise<void> => {
  if (env.isProduction) {
    console.error('✖ Refusing to reset the database with NODE_ENV=production.');
    process.exit(1);
  }

  await connectDatabase();
  const name = mongoose.connection.name;

  if (!SAFE_NAME.test(name)) {
    console.error(
      `✖ Database "${name}" does not look like a development database.\n` +
        '  Expected the name to contain test / dev / local / staging.\n' +
        '  If you really mean it, drop it by hand from the Mongo shell.\n',
    );
    await disconnectDatabase();
    process.exit(1);
  }

  const collections = await mongoose.connection.db!.collections();
  for (const collection of collections) {
    await collection.drop().catch(() => undefined);
    console.log(`  dropped ${collection.collectionName}`);
  }

  console.log(`\nDatabase "${name}" reset. Run db:indexes and db:seed next.\n`);
  await disconnectDatabase();
};

main().catch((error: Error) => {
  console.error('Reset failed:', error.message);
  process.exit(1);
});
