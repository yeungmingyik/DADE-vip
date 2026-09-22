import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { businessDay, businessMonth } from "../modules/rules";

export function seedDatabase(database: DatabaseSync, now: Date): void {
  if (database.prepare("SELECT id FROM members LIMIT 1").get()) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.prepare("SELECT id FROM members LIMIT 1").get()) {
      database.exec("COMMIT");
      return;
    }
    const stores = [
      ["st001", "Ubi", "乌美", "61 Ubi Avenue 2", "active"],
      ["st002", "Jurong", "裕廊", "18 Toh Guan Road East", "active"],
      ["st003", "Woodlands", "兀兰", "30 Woodlands Industrial Park E1", "active"],
    ];
    const insertStore = database.prepare("INSERT INTO stores (id, name_en, name_zh, address, status) VALUES (?, ?, ?, ?, ?)");
    for (const store of stores) insertStore.run(...store);
    const insertStaff = database.prepare("INSERT INTO staff (id, name, role, store_ids, active) VALUES (?, ?, ?, ?, ?)");
    insertStaff.run("s001", "Jamie Tan", "supervisor", JSON.stringify(["st001", "st002"]), 1);
    insertStaff.run("s002", "Ryan Koh", "cashier", JSON.stringify(["st002"]), 1);
    insertStaff.run("s003", "Aisha Lim", "cashier", JSON.stringify(["st003"]), 1);
    database.prepare("INSERT INTO rules (version, threshold_cents, silver_visits, gold_visits, monthly_limit, effective_at) VALUES (?, ?, ?, ?, ?, ?)").run(1, 3000, 4, 8, 2, "2025-01-01T00:00:00.000Z");
    const gifts = [
      ["g001", "Precision toolkit", "精密工具套装", "tools", 10, 1, "/gifts/toolkit.webp"],
      ["g002", "Insulated bottle", "保温随行杯", "lifestyle", 10, 1, "/gifts/bottle.webp"],
      ["g003", "Car care kit", "汽车护理套装", "care", 10, 1, "/gifts/care.webp"],
    ];
    const insertGift = database.prepare("INSERT INTO gifts (id, name_en, name_zh, category, points, active, image) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertStock = database.prepare("INSERT INTO gift_stock (gift_id, store_id, quantity) VALUES (?, ?, ?)");
    for (const [index, gift] of gifts.entries()) {
      insertGift.run(...gift);
      for (const [storeIndex, store] of stores.entries()) insertStock.run(gift[0], store[0], 8 + index * 4 + storeIndex * 3);
    }
    const names = ["Alex Chen", "Rachel Tan", "Daniel Lim", "Sarah Lee", "Marcus Wong", "Emma Goh", "Ethan Koh", "Chloe Ng", "Lucas Teo", "Olivia Low", "Noah Ho", "Sophia Yeo", "Liam Ong", "Isabella Tay", "Jayden Sim", "Mia Chua", "Benjamin Foo", "Amelia Toh", "Isaac Heng", "Charlotte Pang", "Aaron Yap", "Grace Ang", "Adrian Lau", "Hannah Neo"];
    const insertMember = database.prepare("INSERT INTO members (id, number, code, name, phone, joined_at, status, points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertPurchase = database.prepare("INSERT INTO purchases (id, receipt, member_id, store_id, amount_cents, refunded_cents, points, rule_version, actor, created_at, business_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertActivity = database.prepare("INSERT INTO activity (id, kind, member_id, reference_id, store_id, points_delta, balance_after, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const month = businessMonth(now);
    const today = Number(businessDay(now).slice(8, 10));
    const lastDay = Math.max(0, today - 1);
    for (const [index, name] of names.entries()) {
      const id = `m${String(index + 1).padStart(3, "0")}`;
      const joinedAt = new Date(now.getTime() - (120 + index * 4) * 86400000).toISOString();
      const initialBalance = index === 0 ? 24 : 4 + (index % 8) * 3;
      const visits = Math.min(index === 0 ? 7 : (index * 3 + 2) % 12, lastDay);
      insertMember.run(id, `SSPC ${String(10001 + index)}`, `sspc_${randomUUID().replaceAll("-", "")}`, name, `+658000${String(1001 + index)}`, joinedAt, index === 22 ? "suspended" : "active", initialBalance + visits);
      insertActivity.run(randomUUID(), "adjustment", id, `opening-${id}`, "st001", initialBalance, initialBalance, null, joinedAt);
      for (let visit = 0; visit < visits; visit++) {
        const day = Math.max(1, lastDay - visits + visit + 1);
        const createdAt = `${month}-${String(day).padStart(2, "0")}T${String(2 + index % 8).padStart(2, "0")}:15:00.000Z`;
        const purchaseId = `p-${id}-${visit + 1}`;
        const storeId = stores[(index + visit) % stores.length][0];
        const amount = [4800, 12600, 8600, 18640, 6200, 3400, 21500][(index + visit) % 7];
        insertPurchase.run(purchaseId, `R-${10001 + index}-${visit + 1}`, id, storeId, amount, 0, 1, 1, "s001", createdAt, `${month}-${String(day).padStart(2, "0")}`);
        insertActivity.run(randomUUID(), "purchase", id, purchaseId, storeId, 1, initialBalance + visit + 1, amount, createdAt);
      }
    }
    for (const [index, memberId] of ["m002", "m003", "m005", "m007"].entries()) {
      const createdAt = new Date(now.getTime() - (index + 1) * 3600000).toISOString();
      const redemptionId = `r-seed-${index + 1}`;
      const storeId = stores[index % 3][0];
      const gift = gifts[index % 3];
      const status = index < 2 ? "confirmed" : "fulfilled";
      const member = database.prepare("SELECT points FROM members WHERE id = ?").get(memberId) as { points: number };
      if (member.points < 10) continue;
      database.prepare("INSERT INTO redemptions (id, member_id, store_id, gift_id, gift_name_en, gift_name_zh, quantity, points, status, actor, rule_version, business_month, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(redemptionId, memberId, storeId, gift[0], gift[1], gift[2], 1, 10, status, "s001", 1, businessMonth(new Date(createdAt)), createdAt, createdAt);
      database.prepare("UPDATE members SET points = points - 10 WHERE id = ?").run(memberId);
      database.prepare("UPDATE gift_stock SET quantity = quantity - 1 WHERE gift_id = ? AND store_id = ?").run(gift[0], storeId);
      insertActivity.run(randomUUID(), "redemption", memberId, redemptionId, storeId, -10, member.points - 10, null, createdAt);
      if (status === "fulfilled") insertActivity.run(randomUUID(), "fulfilled", memberId, redemptionId, storeId, 0, member.points - 10, null, createdAt);
    }
    database.exec("CREATE TEMP TABLE sorted_activity AS SELECT id, kind, member_id, reference_id, store_id, points_delta, balance_after, amount_cents, created_at FROM activity ORDER BY created_at, sequence; DELETE FROM activity; INSERT INTO activity (id, kind, member_id, reference_id, store_id, points_delta, balance_after, amount_cents, created_at) SELECT id, kind, member_id, reference_id, store_id, points_delta, balance_after, amount_cents, created_at FROM sorted_activity; DROP TABLE sorted_activity;");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
