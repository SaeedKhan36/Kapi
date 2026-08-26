/** Checks whether a non-zero exit poisons the following command. */
import { loadEnv } from "../packages/env/src/index.ts";
loadEnv();
const { Daytona } = await import("@daytonaio/sdk");

const d = new (Daytona as any)({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL,
});
const sb: any = await d.create({ language: "typescript", autoStopInterval: 5, envVars: { KAPI_SMOKE: "1" } });
console.log("sandbox:", sb.id);

const run = async (label: string, cmd: string, cwd?: string) => {
  try {
    const r = await sb.process.executeCommand(cmd, cwd);
    console.log(`  ${label.padEnd(30)} exit=${String(r.exitCode).padEnd(4)} ${JSON.stringify(String(r.result ?? "").slice(0, 70))}`);
  } catch (e: any) {
    console.log(`  ${label.padEnd(30)} THREW ${String(e).slice(0, 90)}`);
  }
};

await run("echo before", "echo before");
await run("exit 3 (no cwd)", "exit 3");
await run("echo after exit", "echo after");
await run("env var after exit", "echo $KAPI_SMOKE");
console.log("  --- now with an existing cwd ---");
await run("mkdir workspace", "mkdir -p /home/daytona/workspace");
await run("exit 3 in workspace", "exit 3", "/home/daytona/workspace");
await run("echo in workspace", "echo ok", "/home/daytona/workspace");
await run("env var in workspace", "echo $KAPI_SMOKE", "/home/daytona/workspace");
console.log("  --- false vs exit ---");
await run("false", "false", "/home/daytona/workspace");
await run("echo after false", "echo ok", "/home/daytona/workspace");

await sb.delete();
console.log("deleted");
process.exit(0);
