"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { toNum } = require('../utils/utils');
const DEFAULT_RECHARGE_SOURCE = 'MallUI';
async function getRechargeInfo(source = DEFAULT_RECHARGE_SOURCE) {
    const body = types.GetRechargeInfoRequest.encode(types.GetRechargeInfoRequest.create({
        source: String(source || DEFAULT_RECHARGE_SOURCE),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.paypb.PayService', 'GetRechargeInfo', body);
    return types.GetRechargeInfoReply.decode(replyBody);
}
async function getDiamondBalance() {
    const reply = await getRechargeInfo();
    const infos = Array.isArray(reply?.recharge_infos) ? reply.recharge_infos : [];
    return Math.max(0, toNum(infos[0]?.balance));
}
module.exports = {
    DEFAULT_RECHARGE_SOURCE,
    getDiamondBalance,
    getRechargeInfo,
};
//# sourceMappingURL=pay.js.map