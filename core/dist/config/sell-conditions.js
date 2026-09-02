"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function parseSellConditions(condition) {
    return String(condition || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
        const separator = part.indexOf(':');
        if (separator < 0)
            return { type: part, value: '' };
        return {
            type: part.slice(0, separator).trim(),
            value: part.slice(separator + 1).trim(),
        };
    });
}
function isActivityEnded(window, nowSec) {
    return !window || window.endTime <= nowSec;
}
function isActivityActive(window, nowSec) {
    return !!window && window.beginTime <= nowSec && nowSec <= window.endTime;
}
function isSingleSellConditionSatisfied(condition, context) {
    const nowSec = Number(context.nowSec) || 0;
    if (condition.type === '道具过期后') {
        const expireTime = Number(context.expireTime) || 0;
        return expireTime > 0 && nowSec >= expireTime;
    }
    if (!context.activityWindowsLoaded || !condition.value)
        return false;
    const window = context.activityWindows?.get(condition.value);
    if (condition.type === '活动结束后')
        return isActivityEnded(window, nowSec);
    if (condition.type === '活动结束前')
        return !isActivityEnded(window, nowSec);
    if (condition.type === '活动区间外')
        return !isActivityActive(window, nowSec);
    return false;
}
function isSellConditionSatisfied(condition, context) {
    const conditions = parseSellConditions(condition);
    return conditions.length > 0
        && conditions.every((entry) => isSingleSellConditionSatisfied(entry, context));
}
module.exports = {
    parseSellConditions,
    isSellConditionSatisfied,
};
//# sourceMappingURL=sell-conditions.js.map