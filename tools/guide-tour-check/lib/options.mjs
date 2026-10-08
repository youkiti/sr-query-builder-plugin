export function parseArgs(argv) {
    const options = { only: null, lang: 'ja', size: { width: 1280, height: 800 }, settle: 0 };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        if (!['--only', '--lang', '--size', '--settle'].includes(key)) throw new Error(`不明な引数: ${key}`);
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`${key} の値が必要です`);
        if (key === '--only') {
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error('不正なシナリオ名です');
            options.only = value;
        } else if (key === '--lang') {
            if (!['ja', 'en'].includes(value)) throw new Error('--lang は ja または en を指定してください');
            options.lang = value;
        } else if (key === '--settle') {
            const settle = Number(value);
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(settle) || settle > 10000) {
                throw new Error('--settle は 0 以上 10000 以下の整数で指定してください');
            }
            options.settle = settle;
        } else {
            const match = /^(\d+)x(\d+)$/.exec(value);
            const width = Number(match?.[1]), height = Number(match?.[2]);
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
                throw new Error('--size は 1280x800 のような正の整数で指定してください');
            }
            options.size = { width, height };
        }
    }
    return options;
}
