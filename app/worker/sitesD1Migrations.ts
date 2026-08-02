import initialSchemaSql from "../drizzle/0000_sites_demo.sql?raw";
import auxiliaryAttemptsSql from "../drizzle/0001_auxiliary_call_attempts.sql?raw";
import {
  sha256Base64Url,
} from "../server/sites/webCrypto";

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS sites_schema_migrations (
    migration_id TEXT PRIMARY KEY NOT NULL,
    migration_sha256 TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
      CHECK(applied_at_ms >= 0)
  )
`;

const MIGRATIONS = Object.freeze([
  Object.freeze({
    id: "0000_sites_demo",
    sql: initialSchemaSql,
  }),
  Object.freeze({
    id: "0001_auxiliary_call_attempts",
    sql: auxiliaryAttemptsSql,
  }),
]);

interface AppliedMigration {
  readonly migration_id: string;
  readonly migration_sha256: string;
}

function migrationStatements(sql: string): readonly string[] {
  const statements = sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => {
      if (/^CREATE TABLE\s/iu.test(statement)) {
        return statement.replace(
          /^CREATE TABLE\s/iu,
          "CREATE TABLE IF NOT EXISTS ",
        );
      }
      if (/^CREATE UNIQUE INDEX\s/iu.test(statement)) {
        return statement.replace(
          /^CREATE UNIQUE INDEX\s/iu,
          "CREATE UNIQUE INDEX IF NOT EXISTS ",
        );
      }
      if (/^CREATE INDEX\s/iu.test(statement)) {
        return statement.replace(
          /^CREATE INDEX\s/iu,
          "CREATE INDEX IF NOT EXISTS ",
        );
      }
      throw new Error("지원하지 않는 Sites D1 migration statement입니다.");
    });
  if (statements.length === 0) {
    throw new Error("Sites D1 migration이 비어 있습니다.");
  }
  return statements;
}

async function migrationHash(sql: string): Promise<string> {
  return sha256Base64Url({
    domain: "sites-d1-migration:v1",
    value: sql,
  });
}

async function readAppliedMigration(
  database: D1Database,
  migrationId: string,
): Promise<AppliedMigration | null> {
  return database.prepare(`
    SELECT migration_id, migration_sha256
    FROM sites_schema_migrations
    WHERE migration_id = ?
    LIMIT 1
  `).bind(migrationId).first<AppliedMigration>();
}

function assertMatchingMigration(
  applied: AppliedMigration,
  expectedId: string,
  expectedSha256: string,
): void {
  if (
    applied.migration_id !== expectedId
    || applied.migration_sha256 !== expectedSha256
  ) {
    throw new Error("Sites D1 migration 이력이 현재 소스와 다릅니다.");
  }
}

/**
 * Sites가 빈 논리 D1 binding을 제공하는 경우에도 저장소에 포함된 SQL을
 * prepared batch transaction으로 한 번만 적용합니다.
 */
export async function ensureSitesDemoSchema(
  database: D1Database,
  now: () => number = Date.now,
): Promise<void> {
  await database.prepare(MIGRATION_TABLE_SQL).run();

  for (const migration of MIGRATIONS) {
    const expectedSha256 = await migrationHash(migration.sql);
    const applied = await readAppliedMigration(database, migration.id);
    if (applied !== null) {
      assertMatchingMigration(applied, migration.id, expectedSha256);
      continue;
    }

    const statements = migrationStatements(migration.sql)
      .map((statement) => database.prepare(statement));
    statements.push(
      database.prepare(`
        INSERT INTO sites_schema_migrations (
          migration_id,
          migration_sha256,
          applied_at_ms
        ) VALUES (?, ?, ?)
      `).bind(migration.id, expectedSha256, now()),
    );

    try {
      await database.batch(statements);
    } catch (error) {
      const concurrentlyApplied = await readAppliedMigration(
        database,
        migration.id,
      );
      if (concurrentlyApplied === null) throw error;
      assertMatchingMigration(
        concurrentlyApplied,
        migration.id,
        expectedSha256,
      );
    }
  }
}
