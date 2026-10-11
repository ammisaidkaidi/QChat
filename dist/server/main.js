#!/usr/bin/env node
/**
 * Standalone entry point: `npm run serve` / `infagent serve`.
 * Boots the API + static UI on 0.0.0.0:$PORT (default 8787).
 */
import process from 'node:process';
import { ensureEnv } from '../config/env.js';
import { startServer } from './server.js';
async function main() {
    ensureEnv({ silent: true });
    const port = Number(process.env['PORT'] ?? 8787);
    const host = process.env['HOST'] ?? '0.0.0.0';
    const running = await startServer({ port, host });
    process.stdout.write(`InfAgent UI  →  ${running.url}\n`);
    process.stdout.write(`  health     →  ${running.url}/api/health\n`);
    process.stdout.write(`  scripts    →  ${running.url}/api/scripts\n`);
    process.stdout.write('  press Ctrl+C to stop\n');
    const shutdown = async () => {
        await running.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
}
main().catch((error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=main.js.map