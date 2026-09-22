import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ports = { member: 3000, staff: 3001, admin: 3002 };
const role = process.argv[2] ?? "member";
if (!Object.hasOwn(ports, role)) throw new Error("Invalid application surface");
const root = fileURLToPath(new URL("../", import.meta.url));
const next = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
const mode = process.argv.includes("--dev") ? "dev" : "start";
const child = spawn(process.execPath, [next, mode, "--hostname", "127.0.0.1", "--port", String(ports[role])], { cwd: root, env: { ...process.env, APP_SURFACE: role }, stdio: "inherit", windowsHide: true });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
