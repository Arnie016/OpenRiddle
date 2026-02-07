import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openJoustDb } from './agent-joust-db.mjs';
import { openJoustPostgresStore } from './agent-joust-db-postgres.mjs';

export async function openJoustStore({
  driver = 'sqlite',
  dbPath = './data/agent-joust.sqlite',
  postgresUrl = '',
}) {
  const mode = String(driver || 'sqlite').toLowerCase();

  if (mode === 'postgres') {
    if (!postgresUrl) {
      throw new Error('JOUST_POSTGRES_URL is required when JOUST_STORE_DRIVER=postgres');
    }
    const store = await openJoustPostgresStore({ connectionString: postgresUrl });
    return { ...store, driver: 'postgres' };
  }

  await mkdir(dirname(dbPath), { recursive: true });
  const store = openJoustDb(dbPath);
  return { ...store, driver: 'sqlite' };
}
