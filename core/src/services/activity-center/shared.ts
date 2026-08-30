/**
 * 活动中心共享原语 - int64 归一、文本/JSON 解码、通用 DTO 与 settle 辅助。
 */

import type Long from 'long';

const LongModule = require('long');
const { getItemById, getItemImageById } = require('../../config/gameConfig');
const { getServerTimeSec } = require('../../utils/utils');
const { getBagItems } = require('../warehouse');

const MAX_SIGNED_INT64 = 9223372036854775807n;

type Int64Like = Long | number | string | null | undefined;
type SettledEntry = PromiseSettledResult<any>;

class ActivityBusinessError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'ActivityBusinessError';
        this.code = code;
    }
}

function businessError(code: string, message: string): ActivityBusinessError {
    return new ActivityBusinessError(code, message);
}

function positiveDecimal(value: unknown, code: string, fieldName: string): string {
    let normalized = '';
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
        normalized = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        normalized = String(value);
    }
    if (!normalized || normalized.length > 19 || BigInt(normalized) > MAX_SIGNED_INT64) {
        throw businessError(code, `${fieldName} 必须是 int64 范围内的正十进制整数`);
    }
    return normalized;
}

function int64String(value: Int64Like): string {
    if (value == null) return '0';
    if (LongModule.isLong(value)) return (value as Long).toString();
    if (typeof value === 'string') return /^-?\d+$/.test(value) ? value : '0';
    return Number.isSafeInteger(value) ? String(value) : '0';
}

function int64Number(value: Int64Like): number {
    const parsed = Number(int64String(value));
    return Number.isSafeInteger(parsed) ? parsed : 0;
}

function compareInt64(left: Int64Like, right: Int64Like): number {
    const leftValue = BigInt(int64String(left));
    const rightValue = BigInt(int64String(right));
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function bytesToText(value: Uint8Array | Buffer | string | null | undefined): string {
    if (!value) return '';
    if (typeof value === 'string') return value;
    const buffer = Buffer.from(value);
    const utf8 = buffer.toString('utf8');
    if (!utf8.includes('�')) return utf8;
    try {
        return new TextDecoder('gb18030').decode(buffer);
    } catch {
        return utf8;
    }
}

function plainText(value: unknown): string {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .trim();
}

function findStrings(value: unknown, output: string[]): void {
    if (typeof value === 'string') {
        const text = plainText(value);
        if (text) output.push(text);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(entry => findStrings(entry, output));
        return;
    }
    if (value && typeof value === 'object') {
        Object.values(value as Record<string, unknown>).forEach(entry => findStrings(entry, output));
    }
}

function textContent(value: Uint8Array | Buffer | string | null | undefined): { title: string; paragraphs: string[] } {
    const text = bytesToText(value).trim();
    if (!text) return { title: '', paragraphs: [] };
    try {
        const parsed = JSON.parse(text);
        const tips = parsed && typeof parsed === 'object' ? parsed.tips : null;
        const rawParagraphs = tips && Array.isArray(tips.txt) ? tips.txt : [];
        const paragraphs = rawParagraphs
            .filter((entry: unknown): entry is string => typeof entry === 'string')
            .map(plainText)
            .filter(Boolean);
        if (paragraphs.length) {
            return { title: typeof tips?.title === 'string' ? plainText(tips.title) : '', paragraphs };
        }
        const allText: string[] = [];
        findStrings(parsed, allText);
        return { title: '', paragraphs: Array.from(new Set(allText)) };
    } catch {
        return { title: '', paragraphs: [plainText(text)].filter(Boolean) };
    }
}

function parseJsonText(value: Uint8Array | Buffer | string | null | undefined): unknown {
    const text = bytesToText(value).trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function parseNestedJsonValue(value: unknown, depth = 0): unknown {
    if (depth >= 6) return value;
    if (Array.isArray(value)) return value.map(entry => parseNestedJsonValue(entry, depth + 1));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .map(([key, entry]) => [key, parseNestedJsonValue(entry, depth + 1)]));
    }
    if (typeof value !== 'string') return value;

    const text = value.trim();
    if (!text) return value;
    try {
        return parseNestedJsonValue(JSON.parse(text), depth + 1);
    } catch {
        // 抓包中的 activity.extra 会在 JSON 属性内再次嵌套 Base64 JSON。
    }

    let encoded = text;
    for (let nesting = 0; nesting < 3; nesting += 1) {
        if (encoded.length < 4 || encoded.length % 4 === 1 || !/^[A-Z0-9+/]+={0,2}$/i.test(encoded)) break;
        const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
        const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
        if (!decoded || decoded.includes('�')) break;
        try {
            return parseNestedJsonValue(JSON.parse(decoded), depth + 1);
        } catch {
            encoded = decoded;
        }
    }
    return value;
}

function parseActivityExtra(value: Uint8Array | Buffer | string | null | undefined): unknown {
    const parsed = parseJsonText(value);
    return parseNestedJsonValue(parsed);
}

function itemDto(item: any) {
    const rawId = item?.item_id ?? item?.itemId ?? item?.id;
    const id = int64String(rawId);
    const numericId = int64Number(rawId);
    const metadata = numericId > 0 ? getItemById(numericId) : undefined;
    return {
        id,
        count: int64String(item?.count),
        name: metadata?.name || bytesToText(item?.name),
        image: numericId > 0 ? getItemImageById(numericId) : '',
        rarity: Number(metadata?.rarity) || 0,
    };
}

function activityDto(activity: any) {
    return {
        id: int64String(activity?.activity_id),
        typeCode: int64String(activity?.type),
        name: bytesToText(activity?.name),
        startTime: int64String(activity?.begin_time),
        endTime: int64String(activity?.end_time),
        extra: parseActivityExtra(activity?.extra),
    };
}

function activityWindowIsActive(activity: any, serverTime = getServerTimeSec()): boolean {
    const beginTime = int64Number(activity?.begin_time ?? activity?.beginTime);
    const endTime = int64Number(activity?.end_time ?? activity?.endTime);
    return (beginTime <= 0 || serverTime >= beginTime) && (endTime <= 0 || serverTime <= endTime);
}

function configuredSellPrice(item: any, effectiveSellInfo: any) {
    const effectivePrices = Array.isArray(effectiveSellInfo?.sells) ? effectiveSellInfo.sells : [];
    const configuredPrices = effectivePrices.length > 0
        ? effectivePrices
        : String(item?.cond_sells || item?.sells || '')
            .split(';')
            .map((entry: string) => {
                const [currencyId, price] = entry.split(':');
                return { currencyId: Number(currencyId) || 0, price: Number(price) || 0 };
            })
            .filter((entry: any) => entry.currencyId > 0 && entry.price > 0);
    const price = configuredPrices[0];
    if (!price) return null;
    const currency = itemDto({ item_id: price.currencyId, count: price.price });
    return {
        currencyId: String(price.currencyId),
        amount: String(price.price),
        currencyName: currency.name,
        currencyImage: currency.image,
    };
}

function readBagBalances(bagReply: any, currencyIds: string[]): Map<string, string> {
    const requestedIds = new Set(currencyIds);
    const balances = new Map<string, bigint>(currencyIds.map(id => [id, 0n]));
    for (const item of getBagItems(bagReply)) {
        const id = int64String(item?.id ?? item?.item_id);
        if (!requestedIds.has(id)) continue;
        const count = BigInt(int64String(item?.count));
        balances.set(id, (balances.get(id) || 0n) + (count > 0n ? count : 0n));
    }
    return new Map(Array.from(balances, ([id, count]) => [id, count.toString()]));
}

function settledValue(entry: SettledEntry): any | null {
    return entry.status === 'fulfilled' ? entry.value : null;
}

function settledError(entry: SettledEntry): string | null {
    if (entry.status === 'fulfilled') return null;
    return String(entry.reason?.message || entry.reason || '未知错误');
}

async function settleRequest(operation: () => Promise<any>): Promise<SettledEntry> {
    try {
        return { status: 'fulfilled', value: await operation() };
    } catch (reason) {
        return { status: 'rejected', reason };
    }
}

module.exports = {
    MAX_SIGNED_INT64,
    ActivityBusinessError,
    businessError,
    positiveDecimal,
    int64String,
    int64Number,
    compareInt64,
    bytesToText,
    plainText,
    findStrings,
    textContent,
    parseJsonText,
    parseNestedJsonValue,
    parseActivityExtra,
    itemDto,
    activityDto,
    activityWindowIsActive,
    configuredSellPrice,
    readBagBalances,
    settledValue,
    settledError,
    settleRequest,
};
