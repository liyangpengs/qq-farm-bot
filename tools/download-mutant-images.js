'use strict';

const path = require('node:path');

const {
    DEFAULT_SOURCE,
    DEFAULT_CONCURRENCY,
    DEFAULT_RETRIES,
    parseIntegerOption,
    readJsonArray,
    readSettings,
    loadManifests,
    buildPathIndex,
    createMappingRecord,
    downloadImages,
    writeReportAtomically,
} = require('./download-game-images');

const DEFAULT_INPUT = path.join(__dirname, 'json');
const DEFAULT_OUTPUT = path.join(__dirname, 'img', 'mutant');
const SUCCESSFUL_STATUSES = new Set([
    'downloaded',
    'updated',
    'replaced-invalid',
    'skipped-identical',
]);

function printUsage() {
    console.log(`用法：
  node tools/download-mutant-images.js
  node tools/download-mutant-images.js --input <JSON目录> --output <图片目录> --source <反编译源码目录>

参数：
  --input <dir>         MutantEffect.json 所在目录
  --output <dir>        图片输出目录，图片文件名为 <变异ID>.png
  --source <dir>        微信小游戏反编译源码目录
  --concurrency <n>     下载并发数，1-32（默认 ${DEFAULT_CONCURRENCY}）
  --retries <n>         可重试错误的额外重试次数，0-10（默认 ${DEFAULT_RETRIES}）
  --help, -h            显示帮助

默认值：
  --input        ${DEFAULT_INPUT}
  --output       ${DEFAULT_OUTPUT}
  --source       ${DEFAULT_SOURCE}`);
}

function parseArgs(argv) {
    const options = {
        input: DEFAULT_INPUT,
        output: DEFAULT_OUTPUT,
        source: DEFAULT_SOURCE,
        concurrency: DEFAULT_CONCURRENCY,
        retries: DEFAULT_RETRIES,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (!['--input', '--output', '--source', '--concurrency', '--retries'].includes(arg)) {
            throw new Error(`未知参数: ${arg}`);
        }

        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数`);
        if (arg === '--concurrency') options.concurrency = parseIntegerOption(value, arg, 1, 32);
        else if (arg === '--retries') options.retries = parseIntegerOption(value, arg, 0, 10);
        else options[arg.slice(2)] = path.resolve(value);
    }

    return options;
}

function loadInput(inputDir) {
    const input = readJsonArray(path.join(inputDir, 'MutantEffect.json'), 'MutantEffect.json');
    const seenIds = new Set();
    const errors = [];

    input.value.forEach((effect, index) => {
        if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
            errors.push(`MutantEffect[${index}] 必须是对象`);
            return;
        }

        const id = Number(effect.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            errors.push(`MutantEffect[${index}].id 不是正安全整数: ${effect.id}`);
            return;
        }
        if (seenIds.has(id)) {
            errors.push(`MutantEffect 存在重复 id: ${id}`);
            return;
        }
        seenIds.add(id);

        if (effect.icon !== null && effect.icon !== undefined && typeof effect.icon !== 'string') {
            errors.push(`MutantEffect ${id}.icon 必须是字符串或 null`);
        }
    });

    if (errors.length > 0) {
        throw new Error(`输入校验失败 (${errors.length} 项):\n- ${errors.join('\n- ')}`);
    }
    return input;
}

function mapAll(input, pathIndex, manifests, settings) {
    const records = [];
    const skipped = [];

    input.value.forEach((effect, index) => {
        const id = Number(effect.id);
        const icon = typeof effect.icon === 'string' ? effect.icon.trim() : '';
        if (!icon) {
            skipped.push({
                id,
                sourceIndex: index,
                name: String(effect.effect_name || effect.name || ''),
                reason: 'NO_ICON',
            });
            return;
        }

        const manifestPath = icon.endsWith('/spriteFrame') ? icon : `${icon}/spriteFrame`;
        const mapping = {
            mode: 'icon',
            field: 'icon',
            value: effect.icon,
            manifestPath,
            effectName: String(effect.effect_name || effect.name || ''),
        };
        records.push(createMappingRecord(
            'MutantEffect',
            id,
            index,
            mapping,
            pathIndex,
            manifests,
            settings,
        ));
    });

    return { records, skipped };
}

function createReport(input, settings, options, records, skipped, startedAt) {
    const summary = {
        inputCount: input.value.length,
        expected: records.length,
        skippedNoIcon: skipped.length,
        downloaded: records.filter(record => record.status === 'downloaded').length,
        updated: records.filter(record => record.status === 'updated').length,
        replacedInvalid: records.filter(record => record.status === 'replaced-invalid').length,
        skippedIdentical: records.filter(record => record.status === 'skipped-identical').length,
        failed: records.filter(record => record.status === 'failed').length,
    };
    summary.succeeded = records.filter(record => SUCCESSFUL_STATUSES.has(record.status)).length;

    return {
        complete: summary.failed === 0 && summary.succeeded === summary.expected,
        startedAt,
        finishedAt: new Date().toISOString(),
        input: {
            mutantEffect: input.filePath,
            mutantEffectSha256: input.sha256,
            mutantEffectCount: input.value.length,
        },
        output: options.output,
        settings: {
            file: settings.filePath,
            server: settings.server,
            remoteBundles: Object.fromEntries(settings.remoteBundles.map(bundle => [bundle.name, bundle.version])),
        },
        summary,
        skipped,
        records,
    };
}

async function main() {
    const startedAt = new Date().toISOString();
    const options = parseArgs(process.argv.slice(2));
    const input = loadInput(options.input);
    const settings = readSettings(options.source);

    console.log(`[输入] MutantEffect=${input.value.length}`);
    console.log(`[配置] settings: ${settings.filePath}`);
    console.log(`[配置] CDN: ${settings.server}`);

    const manifests = await loadManifests(settings, options.retries);
    const pathIndex = buildPathIndex(manifests);
    const { records, skipped } = mapAll(input, pathIndex, manifests, settings);
    const mappingFailures = records.filter(record => record.status === 'failed').length;

    console.log(`[映射] 准确=${records.length - mappingFailures}, 失败=${mappingFailures}, 无图标跳过=${skipped.length}`);
    await downloadImages(records, options);

    const report = createReport(input, settings, options, records, skipped, startedAt);
    const reportPath = writeReportAtomically(options.output, report);
    console.log(`[报告] ${reportPath}`);

    if (report.complete) {
        console.log(`[完成] 已下载并验证 ${report.summary.succeeded}/${report.summary.expected} 张变异图片`);
        return;
    }

    console.error(`[部分完成] 成功 ${report.summary.succeeded}/${report.summary.expected}，失败 ${report.summary.failed}`);
    const grouped = new Map();
    for (const record of records.filter(item => item.status === 'failed')) {
        const code = record.error?.code || 'UNKNOWN';
        const ids = grouped.get(code) || [];
        ids.push(record.outputId);
        grouped.set(code, ids);
    }
    for (const [code, ids] of grouped) console.error(`[失败清单] ${code} (${ids.length}): ${ids.join(', ')}`);
    process.exitCode = 1;
}

main().catch(error => {
    console.error(`[失败] ${error.message}`);
    process.exitCode = 1;
});
