#!/usr/bin/env node
/**
 * InfAgent CLI.
 *
 *   infagent                              show help
 *   infagent config [--json]              resolved env keys (secrets redacted)
 *   infagent run <task…>                  execute a task through the stub agent
 *   infagent serve [--port 8787]          start the API + Vue interface
 *   infagent scripts list [--json]        list agent scripts
 *   infagent scripts search <query>       search scripts
 *   infagent scripts read <name>          metadata + source
 *   infagent scripts prompt <name>        agent callback prompt
 *   infagent scripts create <name> …      scaffold a new script
 *   infagent scripts update <name> …      patch header/body
 *   infagent scripts remove <name>        delete a script
 *   infagent scripts run <name> [json]    execute a script
 *   infagent scripts stats [--json]       counters
 *   infagent tools [--json]               JSON-schema tool definitions for an LLM
 *   infagent --version
 */
import process from 'node:process';
import { ensureEnv, envKeys, envSource, isEnvLoaded, snapshot } from './config/env.js';
import { webFetch, webSearch } from './capabilities/search.js';
import { ChatError, QwenEngine } from './chat/qwen.js';
import { McpManager } from './mcp/manager.js';
import { SkillRegistry } from './skills/registry.js';
import { Agent } from './lib/agent.js';
import { SCRIPT_LANGUAGES } from './scripts/types.js';
import { ScriptError, defaultRegistry } from './scripts/registry.js';
import { startServer } from './server/server.js';
import { buildInfo } from './version.js';
const HELP = `InfAgent — agent infrastructure toolkit

Usage:
  infagent <command> [options]

Commands:
  run <task...>              Run a task through the agent
  serve [--port <n>]         Start the API + Vue interface (default port 8787)
  config                     Show resolved configuration (secrets redacted)
  scripts <subcommand>       Manage agent scripts (see below)
  skills <subcommand>        Manage skills (list|read|create|remove)
  mcp <subcommand>           MCP servers (list|start|stop|call)
  search "<query>"           Internet search, no API key required
  fetch <url>                Fetch a page as text
  chat <subcommand>          Talk to the local Qwen3 model
  tools                      JSON-schema tool definitions for an LLM
  help                       Show this help

Chat subcommands:
  status                     Active model, models folder, context, RAM, tools
  models                     List every model in the models folder
  use <model-id>             Switch the active model (settings file decides)
  download [model-id]        Fetch the GGUF (~380 MB) into the models folder
  ask "<message>"            One-shot question, streamed token by token
      --thinking               Show the model's reasoning block (on stderr)
      --no-tools               Disable script tool calls
      --no-net                 Disable webSearch / webFetch for this turn
      --temp 0.4 --max 512     Sampling controls
  unload                     Free the model from memory

Script subcommands:
  list [--json]              List scripts with description and language
  search <query>             Match name, description or agent prompt
  read <name> [--json]       Header metadata + full source
  prompt <name>              Prompt describing how an agent calls the script
  create <name> [options]    Scaffold a script (.js by default)
      --lang js|py             Target language
      --desc "text"            One-line description (required)
      --body <file>            Use this file as the body
      --force                  Overwrite an existing script
  update <name> [options]    Patch description / prompt / body
  remove <name>              Delete a script
  run <name> ['{json args}'] Execute a script and print its envelope
  stats [--json]             Script counters

Options:
  -h, --help                 Show help
  -v, --version              Show version
  -j, --json                 Machine-readable output

Environment:
  Reads .env from the current working directory.
  Regenerate it from env.txt with:  npm run env:from-txt
`;
const argv = process.argv.slice(2);
const wantsJson = argv.includes('--json') || argv.includes('-j');
const args = argv.filter((arg) => arg !== '--json' && arg !== '-j');
/** Read `--flag value` or `--flag=value` from the argument list. */
function flag(name) {
    const index = args.findIndex((arg) => arg === `--${name}`);
    if (index !== -1) {
        const value = args[index + 1];
        if (value !== undefined && !value.startsWith('--'))
            return value;
    }
    const inline = args.find((arg) => arg.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : undefined;
}
/** Flags that expect a value, so `--limit 3` is not mistaken for a query word. */
const VALUE_FLAGS = new Set(['limit', 'max', 'provider', 'desc', 'when', 'body', 'lang', 'temp']);
/** Arguments left over once flags and their values are removed. */
function positional(args) {
    const out = [];
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? '';
        if (!arg.startsWith('--')) {
            out.push(arg);
            continue;
        }
        const name = arg.replace(/^--/, '').split('=')[0] ?? '';
        if (!arg.includes('=') && VALUE_FLAGS.has(name))
            index += 1;
    }
    return out;
}
function print(value) {
    process.stdout.write(`${value}\n`);
}
async function scriptsCommand(sub, rest) {
    const registry = defaultRegistry;
    switch (sub) {
        case 'list':
        case undefined: {
            const records = registry.list();
            if (wantsJson) {
                print(JSON.stringify({ scripts: records, stats: registry.stats() }, null, 2));
            }
            else {
                print(registry.format());
            }
            return 0;
        }
        case 'search': {
            const query = rest.join(' ').trim();
            if (!query) {
                process.stderr.write('error: `infagent scripts search` needs a query\n');
                return 2;
            }
            const records = registry.search(query);
            if (wantsJson) {
                print(JSON.stringify({ scripts: records }, null, 2));
            }
            else {
                print(records.length === 0
                    ? `No script matches "${query}".`
                    : records
                        .map((record) => `${record.meta.name}  (${record.meta.language})  ${record.meta.description}`)
                        .join('\n'));
            }
            return 0;
        }
        case 'read': {
            const name = rest[0];
            if (!name) {
                process.stderr.write('error: `infagent scripts read` needs a script name\n');
                return 2;
            }
            const detail = registry.read(name);
            if (wantsJson) {
                print(JSON.stringify(detail, null, 2));
            }
            else {
                print(`${detail.meta.name} (${detail.meta.language}) — ${detail.meta.description}`);
                print(`file     : ${detail.relativePath}`);
                print(`callback : ${detail.meta.callback}`);
                print(`usage    : ${detail.meta.usage}`);
                print('');
                print(detail.source);
            }
            return 0;
        }
        case 'prompt': {
            const name = rest[0];
            if (!name) {
                process.stderr.write('error: `infagent scripts prompt` needs a script name\n');
                return 2;
            }
            print(registry.agentPrompt(name));
            return 0;
        }
        case 'create': {
            const name = rest[0];
            const description = flag('desc') ?? flag('description');
            const language = (flag('lang') ?? 'js');
            if (!name || !description) {
                process.stderr.write('error: usage: infagent scripts create <name> --desc "text" [--lang js|py] [--force]\n');
                return 2;
            }
            if (!SCRIPT_LANGUAGES.includes(language)) {
                process.stderr.write(`error: --lang must be one of ${SCRIPT_LANGUAGES.join(', ')}\n`);
                return 2;
            }
            const bodyFile = flag('body');
            const input = {
                name,
                language,
                description,
                overwrite: argv.includes('--force'),
                ...(bodyFile ? { body: (await import('node:fs')).readFileSync(bodyFile, 'utf8') } : {}),
            };
            const created = registry.create(input);
            print(`✔ created ${created.relativePath} (${created.meta.language})`);
            print(`  callback: ${created.meta.callback}`);
            return 0;
        }
        case 'update': {
            const name = rest[0];
            if (!name) {
                process.stderr.write('error: `infagent scripts update` needs a script name\n');
                return 2;
            }
            const patch = {
                ...(flag('desc') ? { description: flag('desc') } : {}),
                ...(flag('prompt') ? { agentPrompt: flag('prompt') } : {}),
                ...(flag('body')
                    ? { body: (await import('node:fs')).readFileSync(flag('body'), 'utf8') }
                    : {}),
            };
            const updated = registry.update(name, patch);
            print(`✔ updated ${updated.relativePath}`);
            return 0;
        }
        case 'remove': {
            const name = rest[0];
            if (!name) {
                process.stderr.write('error: `infagent scripts remove` needs a script name\n');
                return 2;
            }
            const removed = registry.remove(name);
            print(`✔ removed ${removed.relativePath}`);
            return 0;
        }
        case 'run': {
            const name = rest[0];
            if (!name) {
                process.stderr.write('error: `infagent scripts run` needs a script name\n');
                return 2;
            }
            let scriptArgs = {};
            const rawArgs = rest.slice(1).join(' ').trim();
            if (rawArgs) {
                try {
                    const parsed = JSON.parse(rawArgs);
                    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
                        throw new Error('not an object');
                    scriptArgs = parsed;
                }
                catch {
                    process.stderr.write(`error: arguments must be a JSON object, got: ${rawArgs}\n`);
                    return 2;
                }
            }
            const result = await registry.run(name, scriptArgs);
            if (wantsJson) {
                print(JSON.stringify(result, null, 2));
            }
            else {
                print(`$ ${result.command}`);
                if (result.stdout.trim())
                    print(result.stdout.trimEnd());
                if (result.stderr.trim())
                    process.stderr.write(result.stderr);
                print(`${result.ok ? '✔' : '✖'} exit ${result.exitCode ?? 'null'} in ${result.durationMs}ms`);
            }
            return result.ok ? 0 : 1;
        }
        case 'stats': {
            const stats = registry.stats();
            print(wantsJson
                ? JSON.stringify(stats, null, 2)
                : `scripts: ${stats.count} (js ${stats.byLanguage.js}, py ${stats.byLanguage.py}) · ${stats.totalBytes} bytes · ${stats.root}`);
            return 0;
        }
        default:
            process.stderr.write(`error: unknown scripts subcommand "${sub}"\n\n${HELP}`);
            return 2;
    }
}
/** `infagent chat` — talk to the local Qwen3 model from the terminal. */
async function chatCommand(sub, rest) {
    const engine = new QwenEngine();
    switch (sub) {
        case 'status':
        case undefined: {
            const status = engine.status();
            if (wantsJson) {
                print(JSON.stringify({ status, models: engine.models() }, null, 2));
            }
            else {
                print(`${status.modelName} — ${status.state}`);
                print(`model   : ${status.modelPath}${status.modelPresent ? '' : ' (not downloaded)'}`);
                print(`settings: ${status.settingsFile}`);
                print(`context : ${status.contextSize} tokens · threads ${status.threads} · RAM ${status.ramUsedMb} MB`);
                print(`models  : ${engine.models().models.length} in ${engine.modelsDir}`);
                print(`tools   : ${status.toolsAvailable ? 'enabled' : 'disabled (INFAGENT_ALLOW_RUN=0)'}`);
            }
            return 0;
        }
        case 'use': {
            const id = rest.find((arg) => !arg.startsWith('--'));
            if (!id) {
                process.stderr.write('error: usage: infagent chat use <model-id>\n');
                return 2;
            }
            const record = await engine.useModel(id);
            print(`✔ active model: ${record.settings.name} (${record.settings.id})`);
            if (!record.present) {
                print(`  weights missing — run: infagent chat download ${id}`);
            }
            return 0;
        }
        case 'download': {
            const id = rest.find((arg) => !arg.startsWith('--'));
            const status = engine.status();
            if (!id && status.modelPresent) {
                print(`✔ already present: ${status.modelPath}`);
                return 0;
            }
            print(`→ downloading ${(id ?? status.modelId) || status.modelName}`);
            const file = await engine.downloadModel(id);
            print(`✔ ${file}`);
            return 0;
        }
        case 'models': {
            const catalog = engine.models();
            print(`folder: ${catalog.dir}`);
            for (const record of catalog.models) {
                const marker = record.settings.id === catalog.active ? '●' : '○';
                const size = record.present
                    ? `${(record.bytesOnDisk / 1048576).toFixed(1)} MB`
                    : record.sizeBytes > 0
                        ? `${(record.sizeBytes / 1048576).toFixed(1)} MB (not downloaded)`
                        : 'not downloaded';
                print(`${marker} ${record.settings.id.padEnd(24)} ${size.padEnd(26)} ${record.settings.description ?? ''}`);
            }
            return 0;
        }
        case 'unload': {
            await engine.unload();
            print('✔ model unloaded');
            return 0;
        }
        case 'ask': {
            const message = rest
                .filter((arg) => !arg.startsWith('--'))
                .join(' ')
                .trim();
            if (!message) {
                process.stderr.write('error: usage: infagent chat ask "your question" [--thinking] [--no-tools]\n');
                return 2;
            }
            for await (const event of engine.stream({
                messages: [{ role: 'user', content: message }],
                thinking: argv.includes('--thinking'),
                tools: !argv.includes('--no-tools'),
                net: !argv.includes('--no-net'),
                ...(flag('temp') ? { temperature: Number(flag('temp')) } : {}),
                ...(flag('max') ? { maxTokens: Number(flag('max')) } : {}),
            })) {
                switch (event.type) {
                    case 'thinking':
                        process.stderr.write(event.text);
                        break;
                    case 'token':
                        process.stdout.write(event.text);
                        break;
                    case 'tool_call':
                        print(`\n🛠 ${event.call.name}(${JSON.stringify(event.call.args)})`);
                        break;
                    case 'tool_result':
                        print(`   ${event.call.ok ? 'ok' : 'failed'} in ${event.call.durationMs ?? 0}ms`);
                        break;
                    case 'stats':
                        print(`\n— ${event.totalTokens} tok · ${event.tokensPerSecond} tok/s · ${(event.durationMs / 1000).toFixed(1)}s`);
                        break;
                    case 'error':
                        process.stderr.write(`\nerror: ${event.message}\n`);
                        return 1;
                    default:
                        break;
                }
            }
            return 0;
        }
        default:
            process.stderr.write(`error: unknown chat subcommand "${sub}"\n\n${HELP}`);
            return 2;
    }
}
async function main() {
    const [command, ...rest] = args;
    if (!command || command === 'help' || args.includes('--help') || args.includes('-h')) {
        process.stdout.write(HELP);
        return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
        const { name, version, node } = buildInfo();
        print(wantsJson
            ? JSON.stringify({ name, version, node }, null, 2)
            : `${name} v${version} (node ${node})`);
        return 0;
    }
    if (command === 'config') {
        const found = ensureEnv();
        const source = envSource() ?? '(process environment only)';
        const declared = envKeys();
        const entries = snapshot(declared.length > 0 ? declared : undefined);
        if (wantsJson) {
            print(JSON.stringify({ envFileFound: found, envFile: source, entries }, null, 2));
            return 0;
        }
        print(`env file : ${source}${found ? '' : ' (not found)'}\n`);
        for (const { key, value, sensitive } of entries) {
            print(`${sensitive ? '🔒' : '  '} ${key.padEnd(28)} ${value}`);
        }
        return 0;
    }
    if (command === 'serve') {
        ensureEnv({ silent: true });
        const port = Number(flag('port') ?? process.env['PORT'] ?? 8787);
        const running = await startServer({ port, host: flag('host') ?? '0.0.0.0' });
        print(`InfAgent UI → ${running.url}  (Ctrl+C to stop)`);
        return await new Promise(() => 0);
    }
    if (command === 'tools') {
        const tools = defaultRegistry.toolDefinitions();
        print(wantsJson
            ? JSON.stringify({ tools, systemPrompt: defaultRegistry.systemPrompt() }, null, 2)
            : JSON.stringify(tools, null, 2));
        return 0;
    }
    if (command === 'scripts') {
        return await scriptsCommand(rest[0], rest.slice(1));
    }
    if (command === 'chat') {
        return await chatCommand(rest[0], rest.slice(1));
    }
    if (command === 'search') {
        const query = positional(rest).join(' ').trim();
        if (!query) {
            process.stderr.write('error: usage: infagent search "<query>" [--limit 5]\n');
            return 2;
        }
        const limit = Number(flag('limit') ?? 5) || 5;
        const report = await webSearch(query, { limit });
        if (wantsJson) {
            print(JSON.stringify(report, null, 2));
        }
        else {
            print(`${report.provider} — ${report.results.length} result(s) for "${report.query}"`);
            for (const item of report.results) {
                print(`\n• ${item.title}\n  ${item.url}\n  ${item.snippet.slice(0, 200)}`);
            }
        }
        return 0;
    }
    if (command === 'fetch') {
        const url = positional(rest)[0];
        if (!url) {
            process.stderr.write('error: usage: infagent fetch <url>\n');
            return 2;
        }
        const page = await webFetch(url, { maxChars: Number(flag('max') ?? 4000) || 4000 });
        print(wantsJson ? JSON.stringify(page, null, 2) : `${page.title}\n${page.url}\n\n${page.text}`);
        return 0;
    }
    if (command === 'skills') {
        const skills = new SkillRegistry();
        const [sub, ...args] = rest;
        switch (sub) {
            case undefined:
            case 'list':
                print(skills.listing());
                print(`\nfolder: ${skills.root}`);
                return 0;
            case 'read':
            case 'show': {
                const name = args.find((arg) => !arg.startsWith('--'));
                if (!name) {
                    process.stderr.write('error: usage: infagent skills read <name>\n');
                    return 2;
                }
                const skill = skills.read(name);
                print(wantsJson ? JSON.stringify(skill, null, 2) : skill.source);
                return 0;
            }
            case 'create': {
                const name = args.find((arg) => !arg.startsWith('--'));
                if (!name) {
                    process.stderr.write('error: usage: infagent skills create <name> --desc "…"\n');
                    return 2;
                }
                const created = skills.create({
                    name,
                    description: flag('desc') ?? '',
                    ...(flag('when') ? { when: flag('when') } : {}),
                    ...(flag('body') ? { body: flag('body') } : {}),
                });
                print(`✔ created ${created.relativePath}`);
                return 0;
            }
            case 'remove': {
                const name = args.find((arg) => !arg.startsWith('--'));
                if (!name) {
                    process.stderr.write('error: usage: infagent skills remove <name>\n');
                    return 2;
                }
                skills.remove(name);
                print(`✔ removed ${name}`);
                return 0;
            }
            default:
                process.stderr.write(`error: unknown skills subcommand "${sub}"\n`);
                return 2;
        }
    }
    if (command === 'mcp') {
        const manager = new McpManager();
        const [sub, ...args] = rest;
        switch (sub) {
            case undefined:
            case 'list': {
                const catalogue = manager.catalogue();
                print(`config: ${catalogue.configPath}`);
                for (const server of catalogue.servers) {
                    print(`\n${server.state === 'ready' ? '●' : '○'} ${server.name} [${server.state}] — ${server.description || server.command}`);
                    for (const tool of server.tools)
                        print(`    ${server.name}__${tool.name} — ${tool.description}`);
                    if (server.lastError)
                        print(`    error: ${server.lastError}`);
                }
                return 0;
            }
            case 'start':
            case 'stop': {
                const name = args.find((arg) => !arg.startsWith('--'));
                if (!name) {
                    process.stderr.write(`error: usage: infagent mcp ${sub} <server>\n`);
                    return 2;
                }
                if (sub === 'start') {
                    const status = await manager.start(name);
                    print(`${status.state === 'ready' ? '✔' : '✘'} ${name}: ${status.state}`);
                    for (const tool of status.tools)
                        print(`    ${tool.name} — ${tool.description}`);
                }
                else {
                    await manager.stop(name);
                    print(`✔ stopped ${name}`);
                }
                await manager.stopAll();
                return 0;
            }
            case 'call': {
                const [tool, rawArgs] = [args[0], args[1]];
                if (!tool) {
                    process.stderr.write('error: usage: infagent mcp call <server__tool> [json]\n');
                    return 2;
                }
                const parsed = rawArgs ? JSON.parse(rawArgs) : {};
                const called = await manager.call(tool, parsed);
                print(called.result.text);
                await manager.stopAll();
                return 0;
            }
            default:
                process.stderr.write(`error: unknown mcp subcommand "${sub}"\n`);
                return 2;
        }
    }
    if (command === 'run') {
        const task = rest.join(' ').trim();
        if (!task) {
            process.stderr.write('error: `infagent run` needs a task, e.g. infagent run "ping"\n');
            return 2;
        }
        const result = await new Agent().run(task);
        print(wantsJson
            ? JSON.stringify(result, null, 2)
            : `${result.ok ? '✔' : '✖'} [${result.agent}] ${result.output}`);
        return result.ok ? 0 : 1;
    }
    process.stderr.write(`error: unknown command "${command}"\n\n${HELP}`);
    return 2;
}
main()
    .then((code) => {
    if (!isEnvLoaded())
        ensureEnv({ silent: true });
    process.exitCode = code;
})
    .catch((error) => {
    if (error instanceof ChatError) {
        process.stderr.write(`error: ${error.message}\n`);
        process.exitCode = error.code === 'busy' ? 2 : 1;
        return;
    }
    if (error instanceof ScriptError) {
        process.stderr.write(`error: ${error.message}\n`);
        process.exitCode = 2;
        return;
    }
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map