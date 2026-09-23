export const exportMessages = {
  en: {
    purchaseHeaders: ["Receipt number", "Member", "Store", "Original amount (SGD)", "Refunded amount (SGD)", "Net points earned", "Date and time (Singapore)"],
    redemptionHeaders: ["Redemption ID", "Member", "Store", "Reward", "Quantity", "Points used", "Status", "Date and time (Singapore)"],
    redemptionStatuses: { confirmed: "Awaiting collection", fulfilled: "Collected", cancelled: "Cancelled" },
  },
  "zh-CN": {
    purchaseHeaders: ["收据编号", "会员", "门店", "原消费金额（SGD）", "已退款金额（SGD）", "有效获赠积分", "日期与时间（新加坡）"],
    redemptionHeaders: ["兑换编号", "会员", "门店", "礼品", "数量", "兑换积分", "状态", "日期与时间（新加坡）"],
    redemptionStatuses: { confirmed: "待领取", fulfilled: "已领取", cancelled: "已取消" },
  },
} as const;
