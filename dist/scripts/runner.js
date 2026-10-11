/**
 * Executes agent scripts as child processes.
 *
 * Contract: the script receives a single JSON string argument and prints a
 * JSON envelope (`{ ok: true, result }` / `{ ok: false, error }`) on stdout.
 * No shell is involved, the file must live inside the registry root, and a
 * hard timeout kills runaway scripts.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
const INTERPRETERS = {
    js: process.execPath,
    py: process.env['INFAGENT_PYTHON'] ?? 'python3',
};
export function interpreterFor(language) {
    return INTERPRETERS[language];
}
export function commandLabel(language, file, args) {
    const payload = JSON.stringify(args);
    const relative = file.replace(`${process.cwd()}/`, '');
    return language === 'js'
        ? `node ${relative} '${payload}'`
        : `${interpreterFor('py')} ${relative} '${payload}'`;
}
function parseEnvelope(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return undefined;
    const lastLine = trimmed.split('\n').at(-1) ?? '';
    try {
        return JSON.parse(lastLine);
    }
    catch {
        return undefined;
    }
}
export async function runScriptFile(file, language, name, args = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const binary = options.binary ?? interpreterFor(language);
    const startedAt = Date.now();
    return await new Promise((resolve) => {
        const child = spawn(binary, [file, JSON.stringify(args)], {
            cwd: options.cwd ?? process.cwd(),
            env: { ...process.env, INFAGENT_SCRIPT_NAME: name, ...options.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({
                ok: false,
                name,
                language,
                command: commandLabel(language, file, args),
                stdout,
                stderr: `${stderr}${error.message}\n`,
                exitCode: null,
                durationMs: Date.now() - startedAt,
                timedOut,
                envelope: undefined,
            });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const envelope = parseEnvelope(stdout);
            const ok = !timedOut &&
                code === 0 &&
                (envelope === undefined || envelope.ok !== false);
            resolve({
                ok,
                name,
                language,
                command: commandLabel(language, file, args),
                stdout,
                stderr: timedOut ? `${stderr}timed out after ${timeoutMs}ms\n` : stderr,
                exitCode: code,
                durationMs: Date.now() - startedAt,
                timedOut,
                envelope,
            });
        });
    });
}
//# sourceMappingURL=runner.js.map