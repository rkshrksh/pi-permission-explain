# pi-permission-explain

On-demand, plain-English explanations for [`pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) permission prompts.

The permission dialog shows technical facts (which tool, which rule matched, the raw command). This extension adds a one-key "what does this actually do?" button to it: press the key, a model explains the pending action in a sentence.

```
Permission required
tool    : bash
command : git push origin main
rule    : git push*

ctrl+e: explain this action

▶ (y) Yes   (n) No   ...
```

Press the key and the hint becomes:

```
explain (AI · commandcode/gpt-6-luna)
Pushes your local main branch to the origin remote, publishing those commits.
```

The model that produced the explanation is shown on the first line.

## Requirements

- [`pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) — this extension listens to its `permissions:ui_prompt` and `permissions:decision` events. Without it, there are no ask dialogs, so the extension loads and does nothing.

No other dependency: it reads the event facts directly and does not import the permission package.

## Compatibility

Compatibility is defined by the event contract, not by the dialog: this extension works with any permission package that emits the `permissions:ui_prompt` and `permissions:decision` events with the same payload shape.

- **Works:** [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system), and faithful forks of it. Verified against [`@xzzpig/pi-permission-system`](https://www.npmjs.com/package/@xzzpig/pi-permission-system) (a fork of v35.0.0), whose payload is identical.
- **Does not work:** permission addons with their own mechanism. With these, the extension loads and stays inert — no hint, no key, no model call. Examples: [`pi-permission-system` by MasuRII](https://www.npmjs.com/package/pi-permission-system) (emits its own `pi-permission-system:permission-request` channel) and [`pi-verdict`](https://www.npmjs.com/package/pi-verdict) (no cross-extension events; it decides and prompts internally).

A fork works because it shares the contract, not by design, so a future fork release could diverge. Install only one permission system at a time.

## Install

```bash
pi install npm:pi-permission-explain
# or, from a local checkout:
pi install /path/to/pi-permission-explain
```

It works with the session's active model by default. Nothing is sent to a model until you press the key.

## Usage

While a permission dialog is open:

- A hint appears above the editor: `ctrl+e: explain this action`.
- Press **Ctrl+E** → the model's one-sentence explanation appears.
- Press **Ctrl+E** again → hide it.
- Answering the dialog clears it.

It covers every permission surface — bash commands, path reads/writes, MCP targets, and skills — and notes `requestedBy` when a subagent's ask was forwarded to your session.

The key is intercepted through terminal input, which exists only in the interactive TUI. In RPC, JSON, and print modes the hint is not shown, since there is no terminal to press a key in.

## Configuration

Optional. Create `<agent-dir>/extensions/permission-explain/config.json` (usually `~/.pi/agent/extensions/permission-explain/config.json`):

```json
{
  "key": "ctrl+e",
  "model": "openai/gpt-5-mini"
}
```

| Field   | Default            | Meaning                                                               |
| ------- | ------------------ | --------------------------------------------------------------------- |
| `key`   | `ctrl+e`           | Key that triggers the explanation, as a key identifier (`ctrl+e`, `ctrl+shift+e`, …). |
| `model` | session model      | Model to explain with, as `provider/model-id`. If it can't be resolved, the session model is used and a warning is shown every time. |

Reload pi (`/reload`) after editing. The file is optional — missing, the defaults apply. A malformed file or an unparseable `key` is reported with a warning and the default is used instead.

## How it works

- On `permissions:ui_prompt`, it records the ask's facts (`tool`, `gatedBy`, `command`/`value`, `matchedRule`).
- A `ctx.ui.onTerminalInput` listener runs before the focused dialog sees a key, so the configured key is intercepted only while a prompt is open; everywhere else it passes through untouched.
- On the key, it calls `ctx.modelRegistry.complete(...)` with the facts as JSON and renders the reply in a widget.
- On `permissions:decision` (or session shutdown), it clears the widget.

## Advisory only

The explanation is model-generated and can be wrong. It is deliberately marked `(AI)`, the prompt tells the model to describe the action rather than declare it safe, and the extension has no way to allow, deny, or change a decision. Treat it as a hint, not a verdict.

## Development

```bash
npm install
npm run check       # tsc --noEmit
npm run selfcheck   # load-time assertions, run through pi
```

The self-check runs through `pi` rather than plain `node`, because `pi` aliases `@earendil-works/pi-tui` at load.

## Notes

- The widget-and-key approach exists because `pi-permission-system` does not yet expose a public annotator seam to render model-generated text inside the dialog itself. If that changes, a future version can move the explanation into the prompt and drop the key.
