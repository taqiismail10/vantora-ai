/**
 * Owner-run account management. Runs on the server, against the app database.
 *
 *   npm run users -- bootstrap-owner --email owner@example.com --name "Plant Owner"
 *   npm run users -- add --email analyst@example.com --name "Analyst" --role ANALYST
 *   npm run users -- set-role --email analyst@example.com --role VIEWER
 *   npm run users -- revoke --email analyst@example.com
 *   npm run users -- list
 *
 * A password is generated and printed once unless VANTORA_NEW_USER_PASSWORD is
 * set in the environment. It is never written to a file; only its hash is stored.
 */

import "dotenv/config";

import { listUsers, ownerCount, provisionUser, revokeUser, setRole } from "../src/lib/server/users";
import type { HumanRole } from "../src/lib/server/identity";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const command = process.argv[2];
  const password = process.env.VANTORA_NEW_USER_PASSWORD || undefined;

  switch (command) {
    case "bootstrap-owner": {
      if (ownerCount() > 0) throw new Error("an OWNER already exists; use `add --role OWNER --allow-additional-owner`");
      const result = await provisionUser({
        email: required("email"),
        name: required("name"),
        role: "OWNER",
        password,
        createdBy: "bootstrap-cli",
      });
      report(result);
      break;
    }
    case "add": {
      const result = await provisionUser({
        email: required("email"),
        name: required("name"),
        role: required("role").toUpperCase() as HumanRole,
        password,
        allowAdditionalOwner: process.argv.includes("--allow-additional-owner"),
        createdBy: "cli",
      });
      report(result);
      break;
    }
    case "set-role":
      await setRole(required("email"), required("role").toUpperCase() as HumanRole);
      console.log("role updated; the user's sessions were ended");
      break;
    case "revoke":
      await revokeUser(required("email"));
      console.log("access revoked; memberships and sessions removed");
      break;
    case "list":
      console.table(await listUsers());
      break;
    default:
      console.log("usage: npm run users -- <bootstrap-owner|add|set-role|revoke|list> [--email] [--name] [--role]");
      process.exitCode = 1;
  }
}

function report(result: Awaited<ReturnType<typeof provisionUser>>) {
  console.log(`created ${result.email} as ${result.role} of ${result.businessId}`);
  if (result.generatedPassword) {
    console.log(`one-time password (shown once, store it in a password manager): ${result.generatedPassword}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
