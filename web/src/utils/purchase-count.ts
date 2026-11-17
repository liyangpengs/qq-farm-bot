/**
 * 购买数量上限计算：取限购剩余与按余额可购数量的较小值。
 * 购买确认按每份费用和对应余额计算，余额未确认时不可购买。
 */
export interface PurchaseCost {
  id?: number | string
  count?: number | string
  balance?: number | string | null
}

export function affordableCount(costs: PurchaseCost[]): number {
  let max = Number.POSITIVE_INFINITY
  for (const cost of costs || []) {
    const price = Number(cost?.count)
    const balance = cost?.balance
    if (!Number.isFinite(price) || price <= 0)
      continue
    if (balance == null || !Number.isFinite(Number(balance)))
      continue
    max = Math.min(max, Math.floor(Number(balance) / price))
  }
  return max
}

export function purchaseMaxCount(options: { limitRemaining?: number | null, costs?: PurchaseCost[], cap?: number }): number {
  const cap = options.cap ?? 9999
  const limit = options.limitRemaining
  let maximum = BigInt(Math.max(0, Math.floor(Math.min(cap, limit ?? cap))))
  for (const cost of options.costs || []) {
    if (cost.count == null || cost.balance == null)
      return 0
    const unitPrice = BigInt(cost.count)
    if (unitPrice <= 0n)
      return 0
    const affordable = BigInt(cost.balance) / unitPrice
    if (affordable < maximum)
      maximum = affordable
  }
  return Number(maximum < 0n ? 0n : maximum)
}
