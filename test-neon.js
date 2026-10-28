
import "dotenv/config";
import pg from "pg";

const { Client } = pg;

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Переменная DATABASE_URL не найдена в .env");
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();

    const result = await client.query(
      "SELECT current_database() AS db, version() AS version"
    );

    console.log("Neon подключен!");
    console.log("База:", result.rows[0].db);
    console.log("PostgreSQL:", result.rows[0].version);
  } catch (error) {
    console.error("Ошибка подключения:", error.message);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
