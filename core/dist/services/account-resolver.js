"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function normalizeAccountRef(rawRef) {
    if (rawRef === undefined || rawRef === null)
        return '';
    if (Array.isArray(rawRef)) {
        return normalizeAccountRef(rawRef[0]);
    }
    return String(rawRef).trim();
}
function buildAccountKeys(account) {
    const keys = new Set();
    const push = (value) => {
        const next = normalizeAccountRef(value);
        if (next)
            keys.add(next);
    };
    push(account && account.id);
    push(account && account.uin);
    push(account && account.qq);
    return keys;
}
function findAccountByRef(accounts, rawRef) {
    const key = normalizeAccountRef(rawRef);
    if (!key)
        return null;
    const list = Array.isArray(accounts) ? accounts : [];
    for (const account of list) {
        if (!account || typeof account !== 'object')
            continue;
        const keys = buildAccountKeys(account);
        if (keys.has(key)) {
            return account;
        }
    }
    return null;
}
function resolveAccountId(accounts, rawRef) {
    const found = findAccountByRef(accounts, rawRef);
    if (!found)
        return '';
    return normalizeAccountRef(found.id);
}
module.exports = {
    normalizeAccountRef,
    findAccountByRef,
    resolveAccountId,
};
//# sourceMappingURL=account-resolver.js.map