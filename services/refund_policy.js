const REFUND_TIERS = {
  FULL: 'full',
  SEVENTY: 'seventy',
  THIRTY: 'thirty',
  NONE: 'none',
};

const REFUND_TIER_RATES = {
  [REFUND_TIERS.FULL]: 100,
  [REFUND_TIERS.SEVENTY]: 70,
  [REFUND_TIERS.THIRTY]: 30,
  [REFUND_TIERS.NONE]: 0,
};

const REFUND_TIER_DESCRIPTIONS = {
  [REFUND_TIERS.FULL]: '入住前7天以上，全额退款',
  [REFUND_TIERS.SEVENTY]: '入住前3-7天，退款70%',
  [REFUND_TIERS.THIRTY]: '入住前1-3天，退款30%',
  [REFUND_TIERS.NONE]: '入住当天及以后，不予退款',
};

const PLATFORM_FEE_RATE = 10;

function diffDays(checkIn, cancelDate) {
  const a = new Date(checkIn);
  const b = new Date(cancelDate);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
}

function determineRefundTier(checkInDate, cancelDate) {
  const daysUntilCheckIn = diffDays(checkInDate, cancelDate);

  if (daysUntilCheckIn >= 7) {
    return REFUND_TIERS.FULL;
  } else if (daysUntilCheckIn >= 3) {
    return REFUND_TIERS.SEVENTY;
  } else if (daysUntilCheckIn >= 1) {
    return REFUND_TIERS.THIRTY;
  } else {
    return REFUND_TIERS.NONE;
  }
}

function calculateRefund(totalPriceCents, checkInDate, cancelDate) {
  const totalCents = Math.round(Number(totalPriceCents));
  if (totalCents < 0) {
    throw new Error('订单金额不能为负');
  }

  const tier = determineRefundTier(checkInDate, cancelDate);
  const rate = REFUND_TIER_RATES[tier];
  const refundCents = Math.round((totalCents * rate) / 100);
  const cancelFeeCents = totalCents - refundCents;

  return {
    tier,
    rate,
    total_price_cents: totalCents,
    refund_cents: refundCents,
    cancel_fee_cents: cancelFeeCents,
    description: REFUND_TIER_DESCRIPTIONS[tier],
    days_until_check_in: diffDays(checkInDate, cancelDate),
  };
}

function calculateRefundForLegacyOrder(totalPriceCents) {
  const totalCents = Math.round(Number(totalPriceCents));
  return {
    tier: REFUND_TIERS.FULL,
    rate: 100,
    total_price_cents: totalCents,
    refund_cents: totalCents,
    cancel_fee_cents: 0,
    description: '老订单，全额退款',
    days_until_check_in: null,
    is_legacy: true,
  };
}

function calculatePlatformFee(totalPriceCents) {
  const totalCents = Math.round(Number(totalPriceCents));
  return Math.round((totalCents * PLATFORM_FEE_RATE) / 100);
}

function calculateHostPayout(totalPriceCents, refundCents) {
  const totalCents = Math.round(Number(totalPriceCents));
  const refund = Math.round(Number(refundCents));
  const effectiveTotal = Math.max(0, totalCents - refund);
  const platformFee = calculatePlatformFee(effectiveTotal);
  const hostPayout = effectiveTotal - platformFee;

  return {
    total_price_cents: totalCents,
    refund_cents: refund,
    effective_total_cents: effectiveTotal,
    platform_fee_cents: platformFee,
    host_payout_cents: hostPayout,
    platform_fee_rate: PLATFORM_FEE_RATE,
  };
}

function getRefundTierInfo(tier) {
  return {
    tier,
    rate: REFUND_TIER_RATES[tier] || 0,
    description: REFUND_TIER_DESCRIPTIONS[tier] || '未知档位',
  };
}

function getAllRefundTiers() {
  return Object.values(REFUND_TIERS).map(tier => ({
    tier,
    rate: REFUND_TIER_RATES[tier],
    description: REFUND_TIER_DESCRIPTIONS[tier],
  }));
}

module.exports = {
  REFUND_TIERS,
  REFUND_TIER_RATES,
  REFUND_TIER_DESCRIPTIONS,
  PLATFORM_FEE_RATE,
  determineRefundTier,
  calculateRefund,
  calculateRefundForLegacyOrder,
  calculatePlatformFee,
  calculateHostPayout,
  getRefundTierInfo,
  getAllRefundTiers,
};
