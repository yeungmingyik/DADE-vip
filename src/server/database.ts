import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") database.exec("PRAGMA journal_mode = WAL;");
  database.exec("CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const directory = join(process.cwd(), "db", "migrations");
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!database.prepare("SELECT name FROM migrations WHERE name = ?").get(name)) {
        database.exec(readFileSync(join(directory, name), "utf8"));
        database.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.close();
      throw error;
    }
  }
  return database;
}
