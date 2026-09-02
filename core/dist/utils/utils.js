"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const LongModule = require('long');
const { CONFIG } = require('../config/config');
const { createModuleLogger, sanitizeMeta } = require('../services/logger');
const coreLogger = createModuleLogger('core');
// ============ 服务器时间状态 ============
let serverTimeMs = 0;
let localTimeAtSync = 0;
const dateFormatters = new Map();
const timeFormatters = new Map();
// ============ 类型转换 ============
function toLong(val) {
    return LongModule.fromNumber(val);
}
function toNum(val) {
    if (LongModule.isLong(val))
        return val.toNumber();
    return val || 0;
}
// ============ 时间相关 ============
/** 获取当前推算的服务器时间(秒) */
function getServerTimeSec() {
    if (!serverTimeMs)
        return Math.floor(Date.now() / 1000);
    const elapsed = Date.now() - localTimeAtSync;
    return Math.floor((serverTimeMs + elapsed) / 1000);
}
/** 同步服务器时间 */
function syncServerTime(ms) {
    serverTimeMs = ms;
    localTimeAtSync = Date.now();
}
function getDateFormatter(timeZone) {
    let formatter = dateFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        dateFormatters.set(timeZone, formatter);
    }
    return formatter;
}
function getTimeFormatter(timeZone) {
    let formatter = timeFormatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        timeFormatters.set(timeZone, formatter);
    }
    return formatter;
}
function partsToRecord(parts) {
    const result = {};
    for (const part of parts) {
        if (part.type !== 'literal')
            result[part.type] = part.value;
    }
    return result;
}
/** 按指定 IANA 时区生成日期键，不依赖服务器操作系统时区 */
function formatDateKeyInTimeZone(nowMs, timeZone) {
    const parts = partsToRecord(getDateFormatter(timeZone).formatToParts(new Date(nowMs)));
    return `${parts.year}-${parts.month}-${parts.day}`;
}
/** 获取系统配置时区下的当前日期键 */
function getSystemDateKey(nowMs = getServerTimeSec() * 1000) {
    return formatDateKeyInTimeZone(nowMs, CONFIG.timeZone);
}
/** 获取系统配置时区下的当前分钟数（0-1439） */
function getSystemClockMinutes(nowMs = getServerTimeSec() * 1000) {
    const parts = partsToRecord(getTimeFormatter(CONFIG.timeZone).formatToParts(new Date(nowMs)));
    return Number(parts.hour) * 60 + Number(parts.minute);
}
/** 按系统配置时区格式化日志时间 */
function formatSystemDateTime24(nowMs = Date.now()) {
    const date = formatDateKeyInTimeZone(nowMs, CONFIG.timeZone);
    const parts = partsToRecord(getTimeFormatter(CONFIG.timeZone).formatToParts(new Date(nowMs)));
    return `${date} ${parts.hour}:${parts.minute}:${parts.second}`;
}
/**
 * 将时间戳归一化为秒级
 * 大于 1e12 认为是毫秒级，转换为秒级
 */
function toTimeSec(val) {
    const n = toNum(val);
    if (n <= 0)
        return 0;
    if (n > 1e12)
        return Math.floor(n / 1000);
    return n;
}
let logHook = null;
function setLogHook(hook) { logHook = hook; }
function normalizeMeta(meta) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta))
        return {};
    return sanitizeMeta(meta);
}
function resolveModuleTag(moduleName) {
    const moduleMap = {
        farm: '农场',
        friend: '好友',
        warehouse: '仓库',
        task: '任务',
        system: '系统',
    };
    const m = String(moduleName || '').trim();
    return moduleMap[m] || '系统';
}
function inferModuleFromTag(tag) {
    const t = String(tag || '').trim();
    const tagMap = {
        农场: 'farm',
        商店: 'warehouse',
        购买: 'warehouse',
        仓库: 'warehouse',
        好友: 'friend',
        任务: 'task',
        活跃: 'task',
        系统: 'system',
        错误: 'system',
        WS: 'system',
        心跳: 'system',
        推送: 'system',
    };
    return tagMap[t] || 'system';
}
function normalizeLogArgs(arg1, arg2, arg3) {
    // 新写法: log(msg, meta)
    if (typeof arg2 !== 'string') {
        return {
            tag: '',
            msg: String(arg1 || ''),
            meta: arg2 || null,
        };
    }
    // 兼容旧写法: log(tag, msg, meta)
    return {
        tag: String(arg1 || ''),
        msg: String(arg2 || ''),
        meta: arg3 || null,
    };
}
function log(arg1, arg2, arg3 = null) {
    const { tag, msg, meta } = normalizeLogArgs(arg1, arg2, arg3);
    const safeMeta = normalizeMeta(meta);
    if (!safeMeta.module)
        safeMeta.module = inferModuleFromTag(tag);
    const displayTag = resolveModuleTag(safeMeta.module);
    coreLogger.info(msg, { tag: displayTag, ...safeMeta });
    if (logHook) {
        try {
            logHook(displayTag, msg, false, safeMeta);
        }
        catch { }
    }
}
function logWarn(arg1, arg2, arg3 = null) {
    const { tag, msg, meta } = normalizeLogArgs(arg1, arg2, arg3);
    const safeMeta = normalizeMeta(meta);
    if (!safeMeta.module)
        safeMeta.module = inferModuleFromTag(tag);
    const displayTag = resolveModuleTag(safeMeta.module);
    coreLogger.warn(msg, { tag: displayTag, ...safeMeta });
    if (logHook) {
        try {
            logHook(displayTag, msg, true, safeMeta);
        }
        catch { }
    }
}
// ============ 异步工具 ============
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
function randomDelay(minMs, maxMs) {
    const min = Math.max(0, Math.floor(minMs) || 0);
    const max = Math.max(min, Math.floor(maxMs) || min);
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    return new Promise(r => setTimeout(r, delay));
}
module.exports = {
    toLong, toNum,
    setLogHook,
    getServerTimeSec, syncServerTime, getSystemDateKey, getSystemClockMinutes,
    formatDateKeyInTimeZone, formatSystemDateTime24, toTimeSec,
    log, logWarn, sleep, randomDelay,
};
//# sourceMappingURL=utils.js.map