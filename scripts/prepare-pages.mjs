import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist-pages");
const html = await readFile(resolve(output, "static/index.html"), "utf8");
await writeFile(resolve(output, "index.html"), html);
await writeFile(resolve(output, "404.html"), html);
await writeFile(resolve(output, ".nojekyll"), "");
for (const locale of ["en", "zh-CN"]) {
  const localeDirectory = resolve(output, locale);
  await mkdir(localeDirectory, { recursive: true });
  await copyFile(resolve(output, "index.html"), resolve(localeDirectory, "index.html"));
  for (const role of ["member", "staff", "admin"]) {
    const directory = resolve(localeDirectory, role, "login");
    await mkdir(directory, { recursive: true });
    await copyFile(resolve(output, "index.html"), resolve(directory, "index.html"));
    await copyFile(resolve(output, "index.html"), resolve(localeDirectory, role, "index.html"));
  }
}
