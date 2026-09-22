export type Locale = "en" | "zh-CN";
export type Role = "member" | "staff" | "admin";
export type Tier = "bronze" | "silver" | "gold";
export type LocalizedText = { en: string; "zh-CN": string };

export interface Session {
  role: Role;
  userId: string;
  name: string;
  memberId?: string;
  storeIds: string[];
  canManage: boolean;
}

export interface Member {
  id: string;
  number: string;
  code: string;
  name: string;
  phone: string;
  joinedAt: string;
  status: "active" | "suspended";
  points: number;
  visits: number;
  tier: Tier;
  monthlyRedeemed: number;
  totalSpendCents: number;
}

export interface Store {
  id: string;
  name: LocalizedText;
  address: string;
  status: "active" | "inactive";
  deleted?: boolean;
}

export interface Gift {
  id: string;
  name: LocalizedText;
  category: "tools" | "lifestyle" | "care";
  points: number;
  active: boolean;
  image: string;
  stock: Record<string, number>;
  deleted?: boolean;
}

export interface Purchase {
  id: string;
  receipt: string;
  memberId: string;
  memberName: string;
  storeId: string;
  amountCents: number;
  refundedCents: number;
  points: number;
  createdAt: string;
  ruleVersion: number;
}

export interface Redemption {
  id: string;
  memberId: string;
  memberName: string;
  storeId: string;
  giftId: string;
  giftName: LocalizedText;
  quantity: number;
  points: number;
  status: "confirmed" | "fulfilled" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  sequence: number;
  kind: "purchase" | "refund" | "redemption" | "fulfilled" | "cancelled" | "adjustment";
  memberId: string;
  memberName: string;
  referenceId: string;
  storeId: string;
  pointsDelta: number;
  balanceAfter: number;
  amountCents?: number;
  createdAt: string;
}

export interface Staff {
  id: string;
  name: string;
  role: "cashier" | "supervisor";
  storeIds: string[];
  active: boolean;
}

export interface RuleSet {
  version: number;
  thresholdCents: number;
  silverVisits: number;
  goldVisits: number;
  monthlyLimit: number;
  effectiveAt: string;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  entityId: string;
  storeId: string | null;
  createdAt: string;
}

export interface AppData {
  session: Session;
  serverTime: string;
  businessMonth: string;
  snapshotVersion: string;
  members: Member[];
  selectedMember: Member | null;
  stores: Store[];
  gifts: Gift[];
  purchases: Purchase[];
  redemptions: Redemption[];
  activity: Activity[];
  latestActivity: Activity[];
  latestActivitySequence: number;
  staff: Staff[];
  audit: AuditEvent[];
  rules: RuleSet;
  stats: {
    members: number;
    activeMembers: number;
    salesCents: number;
    purchaseCount: number;
    pointsIssued: number;
    redemptionCount: number;
    pendingRedemptions: number;
    tierCounts: Record<Tier, number>;
  };
  series: { date: string; amountCents: number; purchases: number }[];
  pagination: { page: number; pageSize: number; total: number };
}

export type ActionPayload =
  | { action: "purchase"; memberId: string; storeId: string; amountCents: number; receipt: string }
  | { action: "redeem"; memberId: string; storeId: string; giftId: string; quantity: number }
  | { action: "fulfill" | "cancel"; redemptionId: string }
  | { action: "refund"; purchaseId: string; amountCents: number }
  | { action: "createGift"; name: LocalizedText; category: Gift["category"]; image: string; points: number; active: boolean; stock: Record<string, number> }
  | { action: "updateGift"; giftId: string; name?: LocalizedText; category?: Gift["category"]; image?: string; points: number; active: boolean; stock: Record<string, number> }
  | { action: "deleteGift"; giftId: string }
  | { action: "createStore"; name: LocalizedText; address: string; status: Store["status"] }
  | { action: "updateStore"; storeId: string; name: LocalizedText; address: string; status: Store["status"] }
  | { action: "deleteStore"; storeId: string }
  | { action: "updateMember"; memberId: string; status: "active" | "suspended" }
  | { action: "updateStaff"; staffId: string; role: "cashier" | "supervisor"; storeIds: string[]; active: boolean }
  | { action: "updateRules"; thresholdCents: number; silverVisits: number; goldVisits: number; monthlyLimit: number };

export type ActionInput = ActionPayload & { requestId: string };

export interface ActionResult {
  ok: true;
  referenceId?: string;
  purchase?: Purchase;
  redemption?: Redemption;
  member?: Member;
  gift?: Gift;
  store?: Store;
}

export interface StateQuery {
  redemptionStatus?: "confirmed" | "fulfilled" | "cancelled";
  activityKind?: "all" | "purchases" | "redemptions";
  section?: "overview" | "members" | "purchases" | "redemptions" | "gifts" | "stores" | "staff" | "settings" | "activity";
  page?: number;
  search?: string;
  storeId?: string;
  memberId?: string;
  period?: "week" | "month" | "all";
}
