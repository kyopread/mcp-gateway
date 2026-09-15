import { snapshotDatabase } from './database-snapshot.js';

const [operation, source, destination, ...extra] = process.argv.slice(2);
if (!['backup', 'restore'].includes(operation) || !source || !destination || extra.length) {
  console.error(
    'Usage: node dist/database-cli.js <backup|restore> <source.sqlite> <new-destination.sqlite>',
  );
  process.exitCode = 1;
} else {
  try {
    const result = await snapshotDatabase(source, destination);
    console.log(JSON.stringify({ operation, status: 'verified', ...result }));
  } catch (error) {
    console.error(
      'Database operation failed:',
      error instanceof Error ? error.message : 'Unknown error',
    );
    process.exitCode = 1;
  }
}
