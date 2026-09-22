import { z } from "zod";

const id = z.string().min(1).max(100);
const requestId = z.string().min(8).max(128);
const positiveInteger = z.number().int().positive().max(100000000);
const storeIds = z.array(id).min(1).max(20);
const catalogName = z.string().trim().min(1).max(100).refine((value) => !/\p{Cc}/u.test(value));
const localizedName = z.object({ en: catalogName, "zh-CN": catalogName }).strict();
const giftCategory = z.enum(["tools", "lifestyle", "care"]);
const giftImage = z.enum(["/gifts/toolkit.webp", "/gifts/bottle.webp", "/gifts/care.webp"]);
const giftStock = z.record(id, z.number().int().min(0).max(100000));
const storeAddress = z.string().trim().min(1).max(240).refine((value) => !/\p{Cc}/u.test(value));
const storeStatus = z.enum(["active", "inactive"]);

export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("purchase"), requestId, memberId: id, storeId: id, amountCents: positiveInteger, receipt: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("redeem"), requestId, memberId: id, storeId: id, giftId: id, quantity: z.number().int().min(1).max(100) }).strict(),
  z.object({ action: z.literal("fulfill"), requestId, redemptionId: id }).strict(),
  z.object({ action: z.literal("cancel"), requestId, redemptionId: id }).strict(),
  z.object({ action: z.literal("refund"), requestId, purchaseId: id, amountCents: positiveInteger }).strict(),
  z.object({ action: z.literal("createGift"), requestId, name: localizedName, category: giftCategory, image: giftImage, points: positiveInteger, active: z.boolean(), stock: giftStock }).strict(),
  z.object({ action: z.literal("updateGift"), requestId, giftId: id, name: localizedName.optional(), category: giftCategory.optional(), image: giftImage.optional(), points: positiveInteger, active: z.boolean(), stock: giftStock }).strict(),
  z.object({ action: z.literal("deleteGift"), requestId, giftId: id }).strict(),
  z.object({ action: z.literal("createStore"), requestId, name: localizedName, address: storeAddress, status: storeStatus }).strict(),
  z.object({ action: z.literal("updateStore"), requestId, storeId: id, name: localizedName, address: storeAddress, status: storeStatus }).strict(),
  z.object({ action: z.literal("deleteStore"), requestId, storeId: id }).strict(),
  z.object({ action: z.literal("updateMember"), requestId, memberId: id, status: z.enum(["active", "suspended"]) }).strict(),
  z.object({ action: z.literal("updateStaff"), requestId, staffId: id, role: z.enum(["cashier", "supervisor"]), storeIds, active: z.boolean() }).strict(),
  z.object({ action: z.literal("updateRules"), requestId, thresholdCents: positiveInteger, silverVisits: z.number().int().min(1).max(30), goldVisits: z.number().int().min(2).max(31), monthlyLimit: z.number().int().min(1).max(100) }).strict(),
]);

export const stateQuerySchema = z.object({
  section: z.enum(["overview", "members", "purchases", "redemptions", "gifts", "stores", "staff", "settings", "activity"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  search: z.string().max(100).optional(),
  storeId: id.optional(),
  memberId: id.optional(),
  period: z.enum(["week", "month", "all"]).optional(),
  activityKind: z.enum(["all", "purchases", "redemptions"]).optional(),
  redemptionStatus: z.enum(["confirmed", "fulfilled", "cancelled"]).optional(),
  role: z.enum(["member", "staff", "admin"]),
  locale: z.enum(["en", "zh-CN"]).optional(),
}).strict();

export const sessionSchema = z.object({
  role: z.enum(["member", "staff", "admin"]),
  personaId: id.optional(),
}).strict();
