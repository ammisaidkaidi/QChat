# InfAgent

Agent infrastructure toolkit — strict TypeScript, ESM-only, library **and** CLI.

- Node **≥ 20.11**, ESM (`"type": "module"`), TypeScript **strict** (incl. `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
- `tsx` for instant dev runs, `tsc` for the published build in `dist/`
- Vitest for tests, ESLint + Prettier for style, GitHub Actions CI on Node 20 & 22
- Env handled as a first-class citizen: `env.txt` → `.env`, with redaction built in

---

## Quick start

```bash
git clone https://github.com/ammisaidkaidi/InfAgent.git && cd InfAgent
npm install

# edit env.txt, then materialise the real env file
npm run env:from-txt

# sanity check
npm run typecheck && npm test

# run the CLI in watch/dev mode
npm run dev -- config
npm run dev -- run "hello infra"

# production-style build + run
npm run build && npm start -- config
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the CLI from source with `tsx watch` (hot reload) |
| `npm run build` | Compile `src/` → `dist/` (declarations + sourcemaps) |
| `npm start` | Run the compiled CLI (`node dist/cli.js`) |
| `npm run typecheck` | `tsc --noEmit` across `src/` and `tests/` |
| `npm test` / `test:watch` / `test:coverage` | Vitest run / watch / coverage |
| `npm run lint` / `lint:fix` | ESLint (flat config, typescript-eslint) |
| `npm run format` / `format:check` | Prettier |
| `npm run env:from-txt` | Generate `.env` + `.env.example` from `env.txt` |
| `npm run clean` | Remove `dist/` |

## Environment: `env.txt` is the source of truth

```
env.txt   ──(npm run env:from-txt)──▶   .env          ← read by the app, gitignored
                                   ──▶   .env.example  ← committed template, secrets blanked
```

Rules enforced by `tools/env-from-txt.mjs`:

- one `KEY=value` per line, `#` comments and blank lines are preserved in `.env`
- `export KEY=value` works; surrounding quotes are stripped
- keys matching `SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY|…` are written to `.env` but **blanked in `.env.example`** and shown as `<redacted>` in the script output
- the previous `.env` is backed up to `.env.bak`

**Never commit `env.txt` or `.env`** — both are gitignored. If you must share a config, share `.env.example`.

## CLI

```bash
infagent help                 # usage
infagent config               # resolved keys (secrets redacted)
infagent config --json        # machine-readable
infagent run "task text"      # run through the agent (stub handler)
infagent --version
```

Exit codes: `0` success, `1` task failure, `2` usage error.

## Library usage

```ts
import { Agent, getEnv, requireEnv, loadEnv, snapshot } from 'infagent';

loadEnv();                                   // reads ./.env, idempotent
const { LOG_LEVEL } = requireEnv('LOG_LEVEL'); // fails fast, lists all missing keys

const agent = new Agent({
  name: 'infra-bot',
  handler: async (task, self) => `${self.name} handled: ${task}`,
});

const result = await agent.run('drain node-3');
console.log(result);          // { ok, output, durationMs, agent }
console.table(snapshot());    // secrets shown as sk-***890
```

Because `infagent` is ESM-only and built with `module: NodeNext`, keep `.js`
extensions in relative imports (`./config/env.js`).

## Project layout

```
InfAgent/
├── src/
│   ├── cli.ts              # executable entry (bin: infagent)
│   ├── version.ts          # version + build info
│   ├── config/env.ts       # env loading, validation, redaction
│   └── lib/
│       ├── agent.ts        # Agent runtime (injectable task handler)
│       └── index.ts        # public library surface
├── tests/                  # vitest specs
├── tools/
│   ├── env-from-txt.mjs    # env.txt → .env generator
│   └── publish-github.sh   # create the GitHub repo + push in one shot
├── .github/workflows/ci.yml
├── env.txt                 # your reference config (gitignored)
└── .env.example            # committed template
```

## Publishing to GitHub

Published at **https://github.com/ammisaidkaidi/InfAgent** (private, branch `main`).

> **CI workflow is not pushed yet.** `.github/workflows/ci.yml` exists but is untracked:
> GitHub rejects any push that adds or modifies workflow files unless the token carries the
> `workflow` scope, and the token used here has only `repo`. Grant the `workflow` scope
> (or push from a machine signed in via `gh`/SSH), then:
>
> ```bash
> git add .github/workflows/ci.yml
> git commit -m "ci: add GitHub Actions workflow"
> git push
> ```
>
> Everything else in `.github/` (dependabot) is already pushed.

Helper for future/other repos:

```bash
GITHUB_TOKEN=ghp_xxx ./tools/publish-github.sh infagent            # public
GITHUB_TOKEN=ghp_xxx ./tools/publish-github.sh my-org/infagent --private
```

It creates the repo (tolerating one that already exists), sets `origin`, pushes the current
branch, and never writes the token to `.git/config`.

## License

MIT — see `LICENSE`.
