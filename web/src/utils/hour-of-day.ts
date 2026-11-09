export function parseHourOfDay(input: unknown): number | null {
  if (typeof input !== 'number' && (typeof input !== 'string' || !/^\d+$/.test(input)))
    return null
  const value = Number(input)
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : null
}
