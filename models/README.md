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

Fourteen models. Every one is a GGUF from Hugging Face, checked against the
repository it claims to come from (the URL, the byte size and the `GGUF` magic
bytes are all verified in `tests/models.test.ts`).

| Model | Weights | Style | Notes |
| --- | --- | --- | --- |
| `Qwen3-0.6B-Q4_K_M` **default** | 0.4 GB | `qwen3` | tool calling, CPU-friendly |
| `Qwen3-4B-Thinking-2507-Q4_K_M` | 2.5 GB | `qwen3` | reasons before answering (thinking on) |
| `Hammer2.1-3b-Q4_K_M` | 1.9 GB | `xlam` | MadeAgents function-calling fine-tune |
| `xLAM-2-3B-fc-r-Q4_K_M` | 1.9 GB | `xlam` | Salesforce function calling (non-commercial) |
| `xLAM-1b-fc-r-Q4_K_M` | 0.9 GB | `xlam` | the 1B member of the same family |
| `Nexus-TinyFunction-1.2B-Q4_K_M` | 0.7 GB | `plain` | LFM2.5-1.2B fine-tune, ChatML + `<tool_call>` |
| `Yantra-1B-Agent-Q4_K_M` | 0.7 GB | `plain` | MiniCPM5—based router + argument writer |
| `FunctionGemma-270M-Q4_K_M` | 0.3 GB | `plain` | Google function calling (own call syntax) |
| `MiniCPM5-1B-Q4_K_M` | 0.7 GB | `plain` | OpenBMB 1B instruct |
| `Gemma-3-1B-IT-Q4_K_M` | 0.8 GB | `plain` | Google Gemma 3 1B instruct |
| `Llama-3.2-1B-Instruct-Q4_K_M` | 0.8 GB | `plain` | Meta Llama 3.2 1B, 4-bit |
| `Qwen2.5-0.5B-Instruct-Q4_K_M` | 0.5 GB | `plain` | small general-purpose Qwen |
| `LFM2.5-350M-Q4_K_M` | 0.2 GB | `plain` | Liquid AI on-device model |
| `SmolLM2-360M-Instruct-Q4_K_M` | 0.3 GB | `plain` | Hugging Face chat model |

Pick one in the Chat tab; the weights are fetched on demand with the **Download**
button (or `infagent chat download <model-id>`) into the weights folder.
Selecting a model whose weights are not downloaded yet is accepted: the console
says *model not downloaded* and offers the download rather than silently keeping
the previous model.

### Styles

A model's `style` says how it is prompted and how it answers tool calls. It is
the one setting that changes the system prompt, so it has to match what the
model was trained on:

| Style | Tool list | Call format |
| --- | --- | --- |
| `qwen3` (default) | `<tools>` | `<tool_call>{"name": …, "arguments": {…}}</tool_call>`, plus the `/no_think` switch |
| `xlam` | `[BEGIN OF AVAILABLE_TOOLS]` | a bare JSON array `[{"name": …, "arguments": {…}}]` |
| `plain` | `<tools>` | `<tool_call>{"name": …, "arguments": {…}}</tool_call>`, no thinking switch |

`plain` is the ChatML/Hermes convention that most small non-Qwen3 models answer
to. It is the right default for the Gemma, Llama, SmolLM2, LFM2.5 and MiniCPM
entries — but a model only calls tools as well as it was trained to: FunctionGemma
answers in Google's `<start_function_call>` syntax and MiniCPM5 and Yantra in
their own XML formats, none of which InfAgent parses yet, so for those three
tool calls are best-effort and chat is the main use. `Qwen2.5-0.5B`,
`SmolLM2-360M`, `LFM2.5-350M`, `Gemma 3 1B` and `Llama 3.2 1B` have little or no
tool-calling training at all.

### Tool protocol

Every reply is one JSON object that names its own kind — the model never writes a
tool *result*:

```json
{"type":"tool_call","calls":[{"name":"listScripts","arguments":{}}]}
{"type":"final","content":"You have three scripts: hello, disk, ping."}
```

After the engine runs the calls it injects the third shape itself, as a user turn:
`{"type":"tool_result","calls":[{"name":"listScripts","ok":true,"result":[…]}]}`. A
reply that is not one of the model's two shapes is rejected with a precise reason
and one correction turn is spent; after two the lenient parser salvages a call
from the text instead of failing the turn. With the grammar on (default) the
envelope is forced token by token, so malformed JSON cannot be generated.

`strict-json` is the default for every model. `toolProtocol: "native"` keeps a
model's own trained call shape in the prompt (`xlam`-style bare array) while the
*results* still arrive as the engine-written envelope — it is set for `Hammer2.1`
and both `xLAM` entries, which were fine-tuned to answer with nothing but that
array. `tools/eval-protocol.mjs` measures first-try validity, repairs, unknown-tool
attempts and latency per model, grammar on and off, so the choice is made on
numbers rather than taste. The environment overrides everything:
`INFAGENT_TOOL_PROTOCOL=legacy` restores the pre-protocol wording for every model
and `INFAGENT_TOOL_GRAMMAR=0` turns the grammar off while keeping the contract.

### Licences

The catalogue mixes permissive and restricted weights — check before shipping:
Apache-2.0 (`Qwen2.5`, `SmolLM2`, `MiniCPM5`, Nexus fine-tune), MIT (Yantra),
Llama 3.2 Community Licence, Gemma Terms of Use, Liquid LFM Open Licence
(LFM2.5 and the Nexus base), Qwen research licence (Hammer2.1), and
**CC-BY-NC-4.0 for both xLAM models — non-commercial, research use only**.

### Requested but not shipped

Two of the models asked for have no GGUF anywhere and cannot run through
llama.cpp, so they are deliberately absent:

- **Needle 2** (`Cactus-Compute/needle2`) — a 45M model compiled into a 14 MB
  binary that runs inside Cactus's own engine (its own 2-bit format, ARM/x86/
  WASM builds). It is not a GGUF model and there is nothing to download for
  llama.cpp.
- **Sakthai-context-0.5B** (`Nanthasit/sakthai-context-0.5b-tools`) —
  safetensors only; the model card itself tells you to run `llama-quantize`
  yourself. Converting it needs PyTorch plus the full-precision weights (~1 GB)
  and a `llama-quantize` build, which does not fit this machine; drop a GGUF in
  the weights folder and the next scan picks it up.

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
| `toolProtocol` | `strict-json` (default) or `native` — see *Tool protocol* below |
| `agentPrompt` | extra system-prompt text for this model |

Environment variables win over the settings file when set:
`INFAGENT_LLM_CONTEXT`, `INFAGENT_LLM_THREADS`, `INFAGENT_MODEL_PATH`.
