# Models

A model is a **settings file** here plus a **weights file** in a cache folder:

```
models/Qwen3-0.6B-Q4_K_M.settings.json           ← how to run it (committed)
models/models-settings.json                      ← which model is active, and the order
~/.cache/infagent/models/Qwen3-0.6B-Q4_K_M.gguf  ← the weights (~380 MB, never in git)
```

Settings are small and versioned, so the repository is complete; the weights are
large and reproducible, so they live outside it. `infagent chat download` (or the
button in the Chat tab) fetches them in one step.

| Folder | Default | Override |
| --- | --- | --- |
| settings | `<project>/models` | `INFAGENT_SETTINGS_DIR` |
| weights | `~/.cache/infagent/models` | `INFAGENT_WEIGHTS_DIR`, `INFAGENT_MODELS_DIR` |
| single file | — | `INFAGENT_MODEL_PATH` (wins over the catalogue) |

Drop a `.gguf` into either folder and the next scan writes a settings file for it
(`infagent chat models` does it immediately). The weights may sit next to the
settings if you prefer everything in one place — both are found.

## The shipped catalogue

| Model | Weights | RAM | Answers tool calls with |
| --- | --- | --- | --- |
| `Qwen3-0.6B-Q4_K_M` **default** | 0.4 GB | ~1 GB | `<tool_call>{"name": …}</tool_call>` (`style: qwen3`) |
| `Hammer2.1-3b-Q4_K_M` | 1.9 GB | ~3 GB | a JSON array of calls (`style: xlam`) |
| `xLAM-2-3B-fc-r-Q4_K_M` | 1.9 GB | ~3 GB | a JSON array of calls (`style: xlam`) |
| `Qwen3-4B-Thinking-2507-Q4_K_M` | 2.5 GB | ~4 GB | `<tool_call>` blocks (`style: qwen3`, thinking on) |

Pick one in the Chat tab; the first reply after a switch downloads nothing — the
weights are fetched with the **Download** button (or `infagent chat download
<model-id>`) into the weights folder. Selecting a model whose weights are not
downloaded yet is accepted: the console then says *model not downloaded* and
offers the download, rather than silently keeping the previous model.

Hammer2.1 and xLAM are fine-tunes of Qwen2.5-Coder-3B trained to answer with a
bare JSON array (`[{"name": …, "arguments": {…}}]`) and no surrounding prose, so
they are declared the `xlam` style: the tool list is wrapped in the
`[BEGIN OF AVAILABLE_TOOLS]` markers Hammer2.1 was trained on, `/no_think` is not
appended to the question, and the parser accepts the array shape as well as the
Qwen3 tags. Everything else — scripts, alerts, skills, MCP tools — works the
same. Both are research/community releases: Hammer2.1 ships under the Qwen
research licence and xLAM-2-3b-fc-r under CC-BY-NC-4.0 (non-commercial).

## Settings file

| Field | Meaning |
| --- | --- |
| `id` | stable identifier, also the settings file name |
| `name` | label shown in the interface |
| `file` | GGUF file name |
| `source.url` | where the weights are fetched from when missing |
| `source.repo` | human-readable origin (Hugging Face repo) |
| `sizeBytes` | expected size, shown before the first download |
| `contextSize` | llama.cpp context window |
| `threads` | CPU threads |
| `temperature`, `maxTokens`, `thinking` | sampling defaults for this model |
| `style` | `qwen3` (default) or `xlam` — the prompting and tool-call convention |
| `chatWrapper` | `chatml` (default), `qwen`, or `auto` |
| `agentPrompt` | extra system-prompt text for this model |

Environment variables win over the settings file when set:
`INFAGENT_LLM_CONTEXT`, `INFAGENT_LLM_THREADS`, `INFAGENT_MODEL_PATH`.
