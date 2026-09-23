import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../src/lib/types";
import { memberNumberChanges, migrateMemberNumberSnapshot } from "../../src/modules/member-numbers";

export const memberNumberMigration = {
  name: "005-member-numbers.ts",
  apply(database: DatabaseSync): void {
    const members = database.prepare("SELECT id, number FROM members ORDER BY id").all() as { id: string; number: string }[];
    const changes = memberNumberChanges(members);
    if (!changes.size) return;
    const update = database.prepare("UPDATE members SET number = ? WHERE id = ? AND number = ?");
    for (const [id, change] of changes) update.run(change.next, id, change.previous);
    const results = database.prepare("SELECT actor, request_id, result_json FROM idempotency WHERE result_json IS NOT NULL").all() as { actor: string; request_id: string; result_json: string }[];
    const updateResult = database.prepare("UPDATE idempotency SET result_json = ? WHERE actor = ? AND request_id = ?");
    for (const entry of results) {
      const result = JSON.parse(entry.result_json) as ActionResult;
      const migrated = migrateMemberNumberSnapshot(result, changes);
      if (migrated !== result) updateResult.run(JSON.stringify(migrated), entry.actor, entry.request_id);
    }
  },
};
