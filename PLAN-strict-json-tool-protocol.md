# Plan — one strict JSON protocol for function calls and results

**Status: implemented and shipped** (approved, then built in one session — see
the *Tool protocol* section in `README.md` and `models/README.md` for the
user-facing description). This file stays in the tree as the design record: what
the protocol is, why the format is forced in three layers, and what the risks
are.

---

## 1. The problem

Today the reply is free text and the call is recognised by pattern-matching inside
it. The model may emit:

* `<tool_call>{"name":"listScripts","arguments":{}}</tool_call>` (Qwen3 wording)
* `[{"name":"listScripts","arguments":{}}]` (Hammer2.1 / xLAM wording)
* a fenced block, a bare object, the tool name as a key, prose around the JSON …

`src/chat/tools.ts` accepts all of them, which is why a 0.6B model still works —
but it also means **the model decides the shape**, a call and an answer can be
mixed in one message, and nothing stops the model from *writing the result itself*
("the scripts are: …") instead of calling a tool.

The goal: the model may emit **exactly one JSON object per turn**, and that object
says whether it is a *function call* or the *final answer*. Tool **results** are
never written by the model at all — they are injected by the runtime in the same
JSON shape, so "call" and "result" are indistinguishable-by-accident never happens.

---

## 2. The protocol

One object, either of these two shapes, nothing else in the message:

```jsonc
// A) the model wants to call one or more tools
{"type":"tool_call","calls":[{"name":"listScripts","arguments":{}}]}

// B) the model is answering
{"type":"final","content":"You have 3 scripts: hello, net_interfaces, system_info."}
```

The runtime answers with the third shape — **model output can never produce it**:

```jsonc
// C) injected by the engine after running the tools (a user turn, not the model)
{"type":"tool_result","calls":[
  {"name":"listScripts","ok":true,"result":{"scripts":[/* … */]}}
]}
```

Rules that fall out of this:

| Rule | Why |
| --- | --- |
| `type` is the only discriminator | one field, trivially checkable by code and by the model |
| unknown `type` → protocol error | the model cannot invent shapes |
| `type:"tool_result"` **from the model** → protocol error, retried with a correction | results are facts produced by the engine, never by the model (no hallucinated tool output) |
| `name` must be a tool that was actually offered | a call to a non-existent tool is not even representable |
| `arguments` is always an object | no more `"args"` / `"parameters"` / `"input"` guessing |
| exactly one JSON object, no prose, no fence | the whole reply is machine-parsable |

---

## 3. How the format is *forced* — three layers

### Layer 1 — constrained decoding (the hard guarantee)

`node-llama-cpp` 3.22.1 is already a dependency and exposes JSON-schema grammars:

```
llama.createGrammarForJsonSchema(schema)  →  LlamaJsonSchemaGrammar
session.prompt(prompt, { grammar })       →  every generated token obeys the grammar
```

The schema is a `oneOf` of `tool_call` and `final`, with `name` restricted to the
**enum of tool names actually exposed this turn** and `arguments` an object. With
the grammar on, malformed JSON is not improbable — it is *unrepresentable*.

Sketch:

```ts
const grammar = await llama.createGrammarForJsonSchema({
  oneOf: [
    { type: 'object', properties: {
        type: { const: 'tool_call' },
        calls: { type: 'array', items: { type: 'object', properties: {
          name: { enum: toolNames },                       // ← the toolbox, verbatim
          arguments: { type: 'object', additionalProperties: true },
        }, required: ['name', 'arguments'] } },
      }, required: ['type', 'calls'] },
    { type: 'object', properties: {
        type: { const: 'final' },
        content: { type: 'string' },                       // free text stays free
      }, required: ['type', 'content'] },
  ],
});
```

Notes:
* Grammar only constrains the **envelope**; `content` remains a normal string, so the
  answer quality is not boxed in.
* It applies to the whole completion of that prompt, so it is used when the turn is
  a tool turn. Plain chit-chat can stay unconstrained (configurable).
* Cost: a small token/s penalty and a chance the tiny models emit odd whitespace —
  measured in step 6 before it becomes the default.

### Layer 2 — the prompt contract (what the model is told)

`CALL_FORMAT` in `src/chat/prompt.ts` (three per-style variants today) becomes one
spec, shown with both examples and the "no prose, one object" line. The
`toolResultPrompt()` builder stops emitting `<tool_response>` and emits the
`tool_result` envelope instead, followed by the instruction to reply with a
`final` object. The `<tool_call>` tags stay readable as *input* for one release so
running conversations do not break.

### Layer 3 — parse, then repair (the fallback when syntax slips)

`parseEnvelope(text)` does a strict `JSON.parse` + schema check and returns either
the parsed object or a precise reason ("`type` missing", "`calls[0].name` is not a
tool", "the model emitted tool_result"). On failure the engine:

1. emits `{type:'reset'}` (the UI already handles it — the partial bubble is cleared),
2. sends one correction turn: *"Your reply was not valid JSON. Error: X. Reply with
   exactly one JSON object of the form …"*,
3. retries up to 2 times, then falls back to the current lenient
   `extractToolCalls()` salvage so a stubborn model still works,
4. counts repairs per turn and exposes them (`stats` event + a `protocol` field in
   `models/<id>.settings.json`), so we can see which model needs the grammar.

---

## 4. Files touched

| File | Change |
| --- | --- |
| `src/chat/protocol.ts` *(new)* | schema + grammar builder + `parseEnvelope()` + repair/wording helpers + `Envelope` types |
| `src/chat/prompt.ts` | one `ENVELOPE_SPEC` instead of `CALL_FORMAT`; `toolResultPrompt()` emits the `tool_result` object; tool listing keeps names in sync with the grammar enum |
| `src/chat/qwen.ts` | build the grammar per turn, pass `{ grammar }` to `session.prompt`, parse envelopes, repair loop, telemetry |
| `src/chat/tools.ts` | `extractToolCalls()` kept as last-resort salvage; `dispatchTool()` gains argument validation whose failure becomes `{ok:false,error}` inside the result envelope |
| `src/chat/types.ts` | `ChatToolCall` gains `raw`/`ok` already there; add `Envelope` types and a `repairs` count on the `stats` event |
| `models/<id>.settings.json` | optional `toolProtocol: "strict-json" \| "native"` (see §5) |
| UI (`ChatPanel.vue`) | one small line: show "repaired ×1" only when a repair happened (otherwise invisible) |
| `tests/protocol.test.ts` *(new)*, `tests/chat.test.ts` | see §7 |
| `tools/eval-protocol.mjs` *(new)* | scripted evaluation per model (§7) |
| `README.md` | a short "Tool protocol" section |

No new dependency: the grammar API ships with `node-llama-cpp` 3.22.1, which is
already installed.

---

## 5. The per-model nuance (why "strict" is not blindly universal)

Hammer2.1 and xLAM were **fine-tuned** to answer with a bare JSON array and their
chat template says "NO other text"; Qwen3 was fine-tuned on `<tool_call>` tags.
Forcing the envelope on every model is possible (the grammar makes it valid), but
a 3B fine-tune can behave worse when its trained shape is forbidden.

So: the canonical protocol is what the **runtime** speaks — always. For the
models where the eval shows a quality loss, `toolProtocol: "native"` keeps their
trained call shape in the prompt, the grammar still enforces **JSON syntax**
(a JSON-array grammar), and the engine translates the array into the same
`calls` structure before dispatch. The result envelope is identical everywhere.
Net effect: the model cannot invent a shape; only the *syntax* differs, never the
contract.

---

## 6. Streaming

The splitter already hides `<tool_call>` blocks while they stream. With one JSON
object per turn the same idea applies, with one improvement: the engine buffers
until `"type"` is readable, then

* `tool_call` → keep buffering, emit nothing but a "calling `listScripts`…" status,
* `final` → stream `content` token-by-token (the JSON escapes are decoded as it goes),
* malformed → the reset + repair of §3.

`{type:'reset'}` already exists, so the UI needs no new concept.

---

## 7. How it is verified

**Unit (`tests/protocol.test.ts`, extending `tests/chat.test.ts`)**
* valid call, valid final, multiple calls, empty `calls` (rejected);
* prose around the object, code fence, trailing comma, single quotes → rejected with a precise reason;
* unknown tool name and `type:"tool_result"` from the model → rejected, repair text names the problem;
* grammar schema snapshot contains every tool name that the prompt lists (a test that fails if the two drift apart);
* repair loop: a scripted fake session that answers malformed once, then correctly.

**Live eval (`tools/eval-protocol.mjs`, 12 fixed prompts)**
For each downloaded model the script reports valid-JSON rate, repairs, unknown-tool
attempts and latency, before/after enabling the grammar. I can run it here on
`Qwen3-0.6B-Q4_K_M` (≈397 MB, fits this sandbox) and you run it on your machine for
the rest of the catalogue; the numbers decide which models stay `strict-json` and
which move to `native`.

**Gate** as always: `tsc --noEmit`, `vue-tsc`, `eslint`, `vitest run`, `npm run
build`, `ui:build`, plus a live chat turn against the running console.

---

## 8. Risks, stated honestly

* Grammar guarantees **syntax, not judgement** — a model can still call the wrong
  tool or answer "hello" with a `listScripts` call. That is a prompting problem,
  not a parsing one; unchanged by this plan.
* Constrained decoding can slightly reduce answer quality/latency inside the
  constrained turn; mitigated by leaving `final.content` unconstrained and by
  measuring before switching the default.
* If a future `node-llama-cpp` changes the grammar API, `protocol.ts` is the only
  file that needs adjusting (one seam).
* Backwards compatibility: the lenient parser stays in the tree for one release
  behind `INFAGENT_TOOL_PROTOCOL=legacy`, so `git revert` is not needed if
  something misbehaves — a flag flip is.

---

## 9. Order of work (one session, one commit each)

1. `protocol.ts` + tests (no behaviour change yet).
2. Prompt contract + result envelope + parser wired into the engine, **grammar off**
   (proves the protocol alone; still green on the existing chat tests).
3. Grammar on for `strict-json` models + telemetry.
4. Eval script + run it on Qwen3-0.6B here, report the numbers.
5. README + docs, screenshots of a call and a result round trip in the Chat tab.

Say the word and I start at step 1.
