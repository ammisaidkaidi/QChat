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
| `chatWrapper` | `chatml` (default), `qwen`, or `auto` |
| `agentPrompt` | extra system-prompt text for this model |

Environment variables win over the settings file when set:
`INFAGENT_LLM_CONTEXT`, `INFAGENT_LLM_THREADS`, `INFAGENT_MODEL_PATH`.
