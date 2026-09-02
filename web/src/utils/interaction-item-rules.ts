function hasItemEffect(land: any, itemId: string): boolean {
  return (Array.isArray(land?.interactionEffects) ? land.interactionEffects : [])
    .some((effect: any) => String(effect?.itemId || '') === itemId)
}
export function interactionItemTargetReason(itemIdInput: unknown, land: any): string {
  const itemId = String(itemIdInput || '')
  if (!land?.unlocked || land?.occupiedByMaster || !String(land?.plantName || '').trim())
    return '不可用'

  const status = String(land?.status || '')
  if (['locked', 'empty', 'dead'].includes(status))
    return status === 'dead' ? '枯萎不可用' : '不可用'
  if (['harvestable', 'stealable', 'harvested'].includes(status))
    return '成熟不可用'
  if (hasItemEffect(land, itemId))
    return '已生效'

  const phaseName = String(land?.phaseName || '')
  const rarity = Number(land?.rarity || 0)
  if ((itemId === '5003' || itemId === '5004') && phaseName.includes('种子'))
    return '种子不可用'
  if ((itemId === '5003' || itemId === '5004') && (rarity === 4 || rarity === 5))
    return '天工作物不可用'
  if (itemId === '5003' && Number(land?.plantSize || 1) !== 1)
    return '仅限 1×1 作物'
  if (itemId === '5003' && (Array.isArray(land?.mutantConfigIds) ? land.mutantConfigIds : []).map(String).includes('12'))
    return '已闪电变异'

  return ''
}
