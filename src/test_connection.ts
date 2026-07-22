import { Client } from 'pg';

const connectionString = "postgres://postgres:7VmVRL2hU0fQJnud61T0tt2hVfdBG6K84uAeijthx4N5hXPL9JDE1JGWdwBltP4n@178.18.252.45:5440/postgres";

async function main() {
  const client = new Client({ connectionString });
  console.log("Connecting to remote server: 178.18.252.45:5440...");
  await client.connect();
  
  // List all databases
  const dbRes = await client.query("SELECT datname FROM pg_database WHERE datistemplate = false;");
  const databases = dbRes.rows.map((r: any) => r.datname);
  console.log("Databases:", databases);

  // For each database, print its tables
  for (const db of databases) {
    const dbClient = new Client({ 
      connectionString: `postgres://postgres:7VmVRL2hU0fQJnud61T0tt2hVfdBG6K84uAeijthx4N5hXPL9JDE1JGWdwBltP4n@178.18.252.45:5440/${db}` 
    });
    try {
      await dbClient.connect();
      const tableRes = await dbClient.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public';
      `);
      const tables = tableRes.rows.map((r: any) => r.table_name);
      console.log(`Database: ${db} - Table Count: ${tables.length}`);
      if (tables.length > 0) {
        console.log(`Tables in ${db}:`, tables.slice(0, 10), tables.length > 10 ? '...' : '');
      }
    } catch (err: any) {
      console.error(`Error listing tables for ${db}:`, err.message);
    } finally {
      await dbClient.end();
    }
  }
  
  await client.end();
}

main().catch(console.error);
