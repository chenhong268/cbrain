import { ROLLBACK_COMMAND_ID } from "../src/core/release/structured-cohort-rollback.js";
import { proveStructuredCohortRollback } from "./lib/hermes-structured-host-canary.js";

const commandId = await proveStructuredCohortRollback();
if (commandId === ROLLBACK_COMMAND_ID) {
  process.stdout.write(`${JSON.stringify({
    schema_version: 1,
    status: "verified",
    command_id: ROLLBACK_COMMAND_ID,
  })}\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, status: "failed" })}\n`);
  process.exitCode = 1;
}
