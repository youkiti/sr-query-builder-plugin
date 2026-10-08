export async function executeScenarios(scenarios, execute) {
    const results = [];
    for (const scenario of scenarios) {
        const warnings = [];
        try {
            await execute(scenario, warnings);
            results.push({ name: scenario.name, ok: true, warnings });
        } catch (error) {
            results.push({ name: scenario.name, ok: false, warnings, error: error.message ?? String(error) });
        }
    }
    return results;
}

export function summarize(results) {
    return {
        exitCode: results.length === 0 || results.some(r => !r.ok) ? 1 : 0,
        text: results.map(r => [
            `${r.ok ? '成功' : '失敗'}: ${r.name}`,
            ...(r.error ? [r.error] : []),
            ...r.warnings.map(w => `警告: ${w}`),
        ].join('\n')).join('\n'),
    };
}
