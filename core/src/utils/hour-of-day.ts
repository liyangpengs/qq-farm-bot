/** 只接受 0–23 的整点小时，保留午夜，不截断小数或尾随字符。 */
export function parseHourOfDay(input: unknown): number | null {
    if (typeof input !== 'number' && (typeof input !== 'string' || !/^\d+$/.test(input))) return null;
    const value = Number(input);
    return Number.isInteger(value) && value >= 0 && value <= 23 ? value : null;
}

export function assertEmailClaimHour(input: unknown): number {
    const value = parseHourOfDay(input);
    if (value === null) {
        throw Object.assign(new Error('自动邮箱领取时间必须是 0–23 的整数（时）'), { code: 'INVALID_CONFIG' });
    }
    return value;
}
