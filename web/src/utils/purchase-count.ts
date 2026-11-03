/**
 * 购买数量上限计算：取限购剩余与按余额可购数量的较小值。
 * 每种费用按 floor(余额 / 单价) 计算可购数；单价无效（<0）或余额未知的费用不参与约束。
 * 没有任何费用参与约束时返回 Infinity，由调用方与限购、硬上限取最小值。
 */
export interface PurchaseCost {
  id?: number | string
  count?: number
  balance?: number | null
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
  return Math.max(1, Math.min(
    cap,
    limit != null && Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : cap,
    affordableCount(options.costs || []),
  ))
}
