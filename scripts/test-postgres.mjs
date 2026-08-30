import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import pg from "pg";

// The connection identifies a local test server whose user can CREATE DATABASE.
// Never migrate, clear or run fixtures in that source database.
const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString)
  throw new Error("Set TEST_DATABASE_URL or DATABASE_URL for the test PostgreSQL server");
const target = new URL(connectionString);
const databaseName = `zaprosto_test_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString });
let created = false;

function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Check exited with code ${code}`)),
    );
  });
}

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  target.pathname = `/${databaseName}`;
  const env = {
    ...process.env,
    DATABASE_URL: target.toString(),
    TEST_DATABASE_URL: target.toString(),
  };
  await run("node_modules/prisma/build/index.js", ["migrate", "deploy"], env);
  await run("node_modules/vitest/vitest.mjs", ["run", ...process.argv.slice(2)], env);
} finally {
  try {
    if (created) {
      // This exact random database was created by this invocation, never supplied by a user.
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
