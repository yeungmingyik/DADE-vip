import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [versionText, packageText, changelogText, lockText] = await Promise.all([
  read("VERSION"),
  read("package.json"),
  read("CHANGELOG.json"),
  read("package-lock.json")
]);
const version = versionText.trim();
const packageInfo = JSON.parse(packageText);
const lock = JSON.parse(lockText);
const changelog = JSON.parse(changelogText);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const categories = ["added", "changed", "fixed", "removed"];

assert.match(version, versionPattern, "Invalid VERSION");
assert.equal(packageInfo.version, version, "Package version mismatch");
assert.equal(lock.version, version, "Lockfile version mismatch");
assert.equal(lock.packages[""].version, version, "Lockfile root version mismatch");
assert.ok(Array.isArray(changelog.releases) && changelog.releases.length > 0, "Missing releases");
assert.equal(changelog.releases[0].version, version, "Latest release mismatch");

const seen = new Set();
let previousParts;
let previousDate;

for (const release of changelog.releases) {
  assert.match(release.version, versionPattern, "Invalid release version");
  assert.ok(!seen.has(release.version), "Duplicate release version");
  seen.add(release.version);

  const parts = release.version.split(".").map(Number);
  assert.ok(parts.every(Number.isSafeInteger), "Version exceeds numeric range");

  if (previousParts) {
    const difference = previousParts.findIndex((part, index) => part !== parts[index]);
    assert.ok(difference >= 0 && previousParts[difference] > parts[difference], "Releases must descend");
  }

  assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/, "Invalid release date");
  const timestamp = Date.parse(release.date);
  assert.ok(Number.isFinite(timestamp), "Invalid release date");
  assert.equal(new Date(timestamp).toISOString().slice(0, 10), release.date, "Invalid calendar date");
  if (previousDate) {
    assert.ok(previousDate >= release.date, "Release dates must descend");
  }

  assert.deepEqual(Object.keys(release.changes).sort(), [...categories].sort(), "Invalid change categories");
  let changeCount = 0;

  for (const category of categories) {
    assert.ok(Array.isArray(release.changes[category]), "Invalid change list");
    for (const change of release.changes[category]) {
      for (const locale of ["en", "zh-CN"]) {
        assert.ok(typeof change[locale] === "string" && change[locale].trim().length > 0, "Missing translated change");
      }
      changeCount += 1;
    }
  }

  assert.ok(changeCount > 0, "Empty release");
  previousParts = parts;
  previousDate = release.date;
}

process.stdout.write(version + "\n");
