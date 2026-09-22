import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const applications = [{ role: "member", port: 3000 }, { role: "staff", port: 3001 }, { role: "admin", port: 3002 }];
const root = fileURLToPath(new URL("../", import.meta.url));
const next = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
await Promise.all(applications.map(({ port }) => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", () => reject(new Error(`Port ${port} is unavailable`)));
  server.listen(port, "127.0.0.1", () => server.close(resolve));
})));

const children = new Set();
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
for (const { role, port } of applications) {
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, APP_MODE: "demo", APP_SURFACE: role }, stdio: "inherit", windowsHide: true });
  children.add(child);
  child.on("error", (error) => { process.stderr.write(`${role}: ${error.message}\n`); process.exitCode = 1; stop(); });
  child.on("exit", (code) => {
    children.delete(child);
    if (!stopping) { process.exitCode = code ?? 1; stop(); }
  });
}
