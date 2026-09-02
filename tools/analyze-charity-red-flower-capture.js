/*
 * Decode the CharityRedFlower ActivityService.Operate traffic from a capture.
 * Usage: pnpm -C core exec tsx ../tools/analyze-charity-red-flower-capture.js <capture-dir>
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const coreRequire = createRequire(path.resolve(__dirname, '../core/package.json'));
const protobuf = coreRequire('protobufjs');
const cryptoWasm = require('../core/src/utils/crypto-wasm.ts');

const captureDir = path.resolve(process.argv[2] || 'C:/Users/liyp/Downloads/协议');
const protoDir = path.resolve(__dirname, '../core/src/proto');
const protoFiles = fs.readdirSync(protoDir)
    .filter(name => name.endsWith('.proto'))
    .map(name => path.join(protoDir, name));

function integer(value) {
    if (value == null) return '0';
    if (typeof value === 'object' && typeof value.toString === 'function') return value.toString();
    return String(value);
}

function item(value) {
    return value
        ? { id: integer(value.item_id ?? value.id), count: integer(value.count) }
        : null;
}

function charityState(value) {
    if (!value) return null;
    return {
        loveItemId: integer(value.love_item_id),
        loveBalance: integer(value.love_balance),
        donated: integer(value.donated_love),
        globalDonated: integer(value.global_donated_love),
        globalTarget: integer(value.global_target_love),
        seedRewardStatus: integer(value.seed_reward_status),
        seedReward: item(value.seed_reward),
        progressRewards: (value.progress_rewards || []).map(entry => ({
            target: integer(entry.target),
            reward: item(entry.reward),
            status: integer(entry.status),
        })),
        globalReward: value.global_reward
            ? { target: integer(value.global_reward.target), reward: item(value.global_reward.reward) }
            : null,
        settlementRequiredLove: integer(value.settlement_required_love),
        settlementReward: item(value.settlement_reward),
        endTime: integer(value.end_time),
        dailyRewardStatus: integer(value.daily_reward_status),
        flowStatus: integer(value.flow_status),
        publicFund: value.public_fund
            ? {
                date: integer(value.public_fund.date),
                orderId: String(value.public_fund.order_id || ''),
                token: String(value.public_fund.token || ''),
                status: integer(value.public_fund.status),
            }
            : null,
        agreementStatus: integer(value.agreement_status),
        dailyReward: item(value.daily_reward),
    };
}

async function main() {
    const root = new protobuf.Root();
    await root.load(protoFiles, { keepCase: true });
    const gate = root.lookupType('gatepb.Message');
    const activityListType = root.lookupType('gamepb.activitypb.ActivityListReply');
    const requestType = root.lookupType('gamepb.activitypb.CharityRedFlowerOperateRequest');
    const replyType = root.lookupType('gamepb.activitypb.ActivityOperateReply');
    const names = fs.readdirSync(captureDir).filter(name => name.endsWith('.bin')).sort();

    for (const name of names) {
        let message;
        try {
            message = gate.decode(fs.readFileSync(path.join(captureDir, name)));
        } catch {
            continue;
        }
        const meta = message.meta || {};
        const service = String(meta.service_name || '');
        const method = String(meta.method_name || '');
        if (service !== 'gamepb.activitypb.ActivityService') {
            continue;
        }

        const direction = Number(meta.message_type) === 1 ? 'SEND' : 'RECV';
        let body = Buffer.from(message.body || []);
        if (direction === 'SEND' && body.length) body = await cryptoWasm.decryptBuffer(body);

        if (method === 'List' && direction === 'RECV') {
            let listReply;
            try {
                listReply = activityListType.decode(body);
            } catch {
                continue;
            }
            const queue = [...(listReply.activities || [])];
            while (queue.length) {
                const entry = queue.shift();
                queue.push(...(entry?.children || []));
                if (!entry?.charity_red_flower) continue;
                console.log(JSON.stringify({
                    file: name,
                    direction,
                    method,
                    activityId: integer(entry?.activity?.activity_id),
                    errorCode: integer(meta.error_code),
                    errorMessage: String(meta.error_message || ''),
                    state: charityState(entry.charity_red_flower),
                }));
            }
            continue;
        }
        if (method !== 'Operate') continue;

        let decoded = null;
        try {
            decoded = direction === 'SEND' ? requestType.decode(body) : replyType.decode(body);
        } catch {}
        const activityId = integer(decoded?.activity_id);
        if (activityId !== '2026090901') continue;

        console.log(JSON.stringify({
            file: name,
            direction,
            operateType: integer(decoded?.operate_type),
            errorCode: integer(meta.error_code),
            errorMessage: String(meta.error_message || ''),
            request: direction === 'SEND'
                ? {
                    claimSeed: decoded?.claim_seed != null,
                    donateLove: decoded?.donate_love != null,
                    sendPublicFund: decoded?.send_public_fund != null,
                    query: decoded?.query ? { accepted: !!decoded.query.accepted } : null,
                }
                : null,
            state: direction === 'RECV' ? charityState(decoded?.data?.charity_red_flower) : null,
            seedResult: direction === 'RECV' && decoded?.charity_seed_result
                ? { reward: item(decoded.charity_seed_result.reward) }
                : null,
            donateResult: direction === 'RECV' && decoded?.charity_donate_result
                ? {
                    donated: integer(decoded.charity_donate_result.donated),
                    count: integer(decoded.charity_donate_result.count),
                    status: integer(decoded.charity_donate_result.status),
                    globalDonated: integer(decoded.charity_donate_result.global_donated),
                }
                : null,
            publicFundResult: direction === 'RECV' && decoded?.charity_public_fund_result
                ? {
                    status: integer(decoded.charity_public_fund_result.status),
                    orderId: String(decoded.charity_public_fund_result.order_id || ''),
                    reward: item(decoded.charity_public_fund_result.reward),
                    token: String(decoded.charity_public_fund_result.token || ''),
                }
                : null,
            queryResult: direction === 'RECV' && decoded?.charity_query_result
                ? { accepted: !!decoded.charity_query_result.accepted }
                : null,
        }));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
