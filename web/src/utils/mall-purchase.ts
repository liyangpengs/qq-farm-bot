import type { MallCatalogDto, MallGoodsDto } from '@/stores/commerce'

export function getMallLimitLabel(type?: number) {
  return ({ 1: '每日限购', 2: '每周限购', 3: '每月限购', 4: '永久限购' } as Record<number, string>)[Number(type)] || '限购'
}

export function getMallPurchaseAction(goods: MallGoodsDto, membership?: MallCatalogDto['membership']) {
  const blocked = (label: string, reason = goods.unavailableReason || label) => ({ enabled: false, label, reason })
  if (membership?.isSvip === false || goods.purchaseStatus === 'svip_required')
    return blocked('SVIP 限定', '需要 SVIP 会员身份')
  if (goods.purchaseStatus === 'owned')
    return blocked('已拥有')
  if (goods.purchaseStatus === 'sold_out' || goods.limit?.remaining === 0)
    return blocked(goods.isFree ? '已领取' : '售罄')
  if (goods.purchaseStatus === 'ad_required')
    return blocked('广告领取')
  if (goods.purchaseStatus === 'share_required')
    return blocked('需先分享')
  if (!goods.purchasable)
    return blocked('暂不可购买')
  if (!goods.isFree) {
    if (goods.price.id <= 0 || goods.price.count <= 0)
      return blocked('价格未确认', '商品价格未确认，请刷新商城')
    if (goods.price.balance == null || !Number.isFinite(goods.price.balance))
      return blocked('余额未确认', '余额暂不可用，请刷新商城')
    if (goods.price.balance < goods.price.count)
      return blocked('余额不足', `${goods.price.name}余额不足`)
  }
  return { enabled: true, label: goods.isFree ? '领取' : '购买', reason: '' }
}
