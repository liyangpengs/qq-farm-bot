const test = require('node:test');
const assert = require('node:assert/strict');

const { decorateMessageWithIcons } = require('../dist/services/qq-bot-push.js');

// uploader 返回稳定的伪 url，便于断言图标出现次数
const uploader = async (local) => `url:${local}`;

function makeMap(...pairs) {
  return new Map(pairs.map(([name, path]) => [name, path]));
}

test('同名物品每次出现都带图标（不再只替换首次）', async () => {
  const map = makeMap(['马蹄莲', '/img/20102.png'], ['金币', '/img/1001.png']);
  const msg = '出售 马蹄莲x25, 马蹄莲x47, 马蹄莲x119，获得 198170 金币';
  const out = await decorateMessageWithIcons(msg, map, uploader);
  assert.equal((out.match(/!\[马蹄莲 #20px #20px\]/g) || []).length, 3, '马蹄莲应出现 3 个图标');
  assert.equal((out.match(/!\[金币 #20px #20px\]/g) || []).length, 1, '金币应带图标');
});

test('长词优先匹配，狐狸崽不被狐狸拆开', async () => {
  const map = makeMap(
    ['狐狸崽', '/img/fox-baby.png'],
    ['狐狸', '/img/fox.png'],
    ['水牛奶', '/img/milk.png'],
    ['水牛', '/img/buffalo.png'],
  );
  const msg = '勇敢女孩：获得 狐狸崽 ×7、水牛奶 ×5';
  const out = await decorateMessageWithIcons(msg, map, uploader);
  assert.ok(out.includes('狐狸崽![狐狸崽 #20px #20px]'), '狐狸崽应完整带图标');
  assert.ok(out.includes('水牛奶![水牛奶 #20px #20px]'), '水牛奶应完整带图标');
  assert.equal((out.match(/!\[狐狸 #20px #20px\]/g) || []).length, 0, '不应出现单独的狐狸图标');
  assert.equal((out.match(/!\[水牛 #20px #20px\]/g) || []).length, 0, '不应出现单独的水牛图标');
});

test('无匹配物品时原样返回', async () => {
  const map = makeMap(['兰花', '/img/orchid.png']);
  const out = await decorateMessageWithIcons('今天天气不错', map, uploader);
  assert.equal(out, '今天天气不错');
});

test('非物品单位词不加图标', async () => {
  const map = makeMap(['牧草', '/img/grass.png'], ['钻石', '/img/diamond.png']);
  const out = await decorateMessageWithIcons('获得 牧草 ×10、钻石 ×2', map, uploader);
  assert.equal(out, '获得 牧草 ×10、钻石 ×2');
});

test('图标串行上传，避免并发限流；失败会重试一次', async () => {
  const map = makeMap(['椰子', '/a.png'], ['杨桃', '/b.png'], ['蘑菇', '/c.png']);
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const flakyUploader = async (local) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(local);
    await new Promise(r => setTimeout(r, 5));
    // 让第一个物品首次失败，验证重试
    if (local === '/a.png' && calls.filter(c => c === local).length === 1) {
      inFlight--;
      return '';
    }
    inFlight--;
    return `url:${local}`;
  };
  const out = await decorateMessageWithIcons('椰子x1, 杨桃x2, 蘑菇x3', map, flakyUploader);
  assert.equal(maxInFlight, 1, '同一时刻只应有 1 个上传在飞（串行）');
  assert.ok(out.includes('![椰子'), '失败的图标重试后应成功显示');
  assert.ok(out.includes('![杨桃') && out.includes('![蘑菇'));
  assert.equal(calls.filter(c => c === '/a.png').length, 2, '失败应重试一次');
});

test('始终上传失败的图标被收集到 onMissing，便于重排队', async () => {
  const map = makeMap(['椰子', '/a.png'], ['杨桃', '/b.png']);
  const alwaysFail = async () => '';
  let missing = null;
  await decorateMessageWithIcons('椰子x1, 杨桃x2', map, alwaysFail, names => { missing = names; });
  assert.ok(Array.isArray(missing), 'onMissing 应被调用');
  assert.deepEqual(new Set(missing), new Set(['椰子', '杨桃']), '两个失败图标都应上报');
});

test('全部上传成功时 onMissing 收到空数组', async () => {
  const map = makeMap(['椰子', '/a.png']);
  let missing = null;
  await decorateMessageWithIcons('椰子x1', map, async p => `url:${p}`, names => { missing = names; });
  assert.deepEqual(missing, []);
});
