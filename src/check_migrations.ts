import { Client } from 'pg';

const connectionString = "postgres://postgres:7VmVRL2hU0fQJnud61T0tt2hVfdBG6K84uAeijthx4N5hXPL9JDE1JGWdwBltP4n@178.18.252.45:5440/postgres";

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  
  const res = await client.query("SELECT * FROM _prisma_migrations;");
  console.log("Migrations:", res.rows);
  
  await client.end();
}

main().catch(console.error);
