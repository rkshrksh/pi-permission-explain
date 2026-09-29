/**
 * pi-permission-explain — on-demand plain-English explanations for
 * pi-permission-system permission prompts.
 *
 * While a permission dialog is open, a hint shows above the editor and a key
 * (Ctrl+E by default) asks the model to explain the pending action in one
 * sentence. The explanation is advisory only: this extension cannot allow,
 * deny, or change a decision, and it makes no model call until the key is
 * pressed.
 *
 * Requires @gotgenes/pi-permission-system. Without it the extension loads and
 * does nothing.
 *
 * Self-check (runs at load): PERMISSION_EXPLAIN_SELFCHECK=1 pi -e ./src/index.ts --help
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId } from "@earendil-works/pi-tui";

const WIDGET_KEY = "permission-explain";
const HINT = "explain this action";
const DEFAULT_KEY = "ctrl+e";
const CONFIG_DIR = "permission-explain";
const CONFIG_FILE = "config.json";

/** User config, from `<agent-dir>/extensions/permission-explain/config.json`. */
interface ExplainConfig {
  /** Key identifier, e.g. "ctrl+e". Defaults to Ctrl+E. */
  key?: string;
  /** Model to explain with, "provider/model-id". Defaults to the session model. */
  model?: string;
}

/** Shape we read off the permission bus; every field is validated. */
interface UiPromptRequestFacts {
  surface?: unknown;
  toolName?: unknown;
  value?: unknown;
  matchedPattern?: unknown;
  executedUnit?: unknown;
}

/** Forwarding context for an ask raised by a subagent. */
interface ForwardedPromptContext {
  requesterAgentName?: unknown;
}

interface UiPromptEvent {
  requestId?: unknown;
  surface?: unknown;
  value?: unknown;
  request?: UiPromptRequestFacts;
  forwarding?: ForwardedPromptContext | null;
}

const SYSTEM_PROMPT = [
  "You explain, in one sentence, an action an AI coding agent is about to take",
  "and that needs a human's permission. You are given the action's facts as JSON:",
  "the tool, what gates it, the target value, and the matched rule.",
  "Reply with ONE short sentence (max 140 characters), plain English, no markdown,",
  "no code fences, no preamble. Say what the action does and what it changes.",
  "If it is destructive, irreversible, or touches the network, secrets, or remote",
  "state, say so. Describe the action; do not declare whether it is allowed or safe.",
].join(" ");

export default function permissionExplainExtension(pi: ExtensionAPI): void {
  let ctxRef: ExtensionContext | undefined;
  let unsubscribeInput: (() => void) | undefined;
  let config: { key: string; model?: string } = { key: DEFAULT_KEY };
  // The prompt currently on screen, if any, and what the key acts on.
  let activeRequestId: string | undefined;
  let activeFacts: Record<string, string> | undefined;
  // Why seq: a slow explanation for a prompt that is already answered must not
  // paint over the next one.
  let seq = 0;
  let explanation: string | undefined;
  let explanationModel: string | undefined;
  let visible = false;
  /** `seq` of the prompt whose explanation is being fetched, if any. */
  let inFlightTicket: number | undefined;

  const show = (lines: string[] | undefined) => {
    if (ctxRef?.hasUI) ctxRef.ui.setWidget(WIDGET_KEY, lines);
  };

  const reset = () => {
    activeRequestId = undefined;
    activeFacts = undefined;
    explanation = undefined;
    explanationModel = undefined;
    visible = false;
    inFlightTicket = undefined;
    show(undefined);
  };

  const showExplanation = (text: string, model: string) => {
    explanation = text;
    explanationModel = model;
    visible = true;
    show([`explain (AI · ${model})`, text]);
  };

  const onExplainKey = (): void => {
    const ctx = ctxRef;
    if (!ctx || !activeRequestId || !activeFacts) return;
    if (inFlightTicket === seq) return;
    if (visible) {
      visible = false;
      show([hint()]);
      return;
    }
    if (explanation && explanationModel) {
      showExplanation(explanation, explanationModel);
      return;
    }
    const model = resolveModel(ctx);
    if (!model) {
      ctx.ui.notify(
        'permission-explain: no model available to explain; select a session model or set "model" in the config',
        "warning",
      );
      show([hint()]);
      return;
    }
    const label = `${model.provider}/${model.id}`;
    const ticket = seq;
    const facts = activeFacts;
    inFlightTicket = ticket;
    show(["explain: thinking…"]);
    void explain(ctx, facts, model)
      .then((text) => {
        if (ticket !== seq || !activeRequestId) return;
        if (!text) {
          show([hint()]);
          return;
        }
        showExplanation(text, label);
      })
      .catch(() => {
        if (ticket === seq && activeRequestId) show([hint()]);
      })
      .finally(() => {
        // Clear only if no later prompt has taken over the slot.
        if (inFlightTicket === ticket) inFlightTicket = undefined;
      });
  };

  const hint = () => `${config.key}: ${HINT}`;

  /**
   * Pick the model to explain with: the configured one, or the session model.
   *
   * A configured model that cannot be resolved falls back to the session model
   * and warns every time, so it is not missed.
   */
  const resolveModel = (ctx: ExtensionContext) => {
    const usable = (model: ReturnType<typeof ctx.modelRegistry.find>) =>
      model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;

    const configured = config.model;
    if (!configured) return usable(ctx.model);

    const slash = configured.indexOf("/");
    const provider = slash > 0 ? configured.slice(0, slash) : "";
    const id = slash > 0 ? configured.slice(slash + 1) : "";
    const found = usable(provider && id ? ctx.modelRegistry.find(provider, id) : undefined);
    if (found) return found;

    ctx.ui.notify(
      `permission-explain: model "${configured}" not found or not authenticated; using the session model`,
      "warning",
    );
    return usable(ctx.model);
  };

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    const loaded = loadConfig();
    config = resolveConfig(loaded.config);
    if (loaded.error) {
      ctx.ui.notify(`permission-explain: ignoring config (${loaded.error})`, "warning");
    }
    // A key pi-tui cannot parse would silently never fire; a typo like
    // "control+e" would be read as the plain key "e" and swallow every press.
    if (!isValidKeyId(config.key)) {
      ctx.ui.notify(
        `permission-explain: key "${config.key}" is not a valid key identifier; using ${DEFAULT_KEY}`,
        "warning",
      );
      config = { ...config, key: DEFAULT_KEY };
    }
    unsubscribeInput?.();
    // Consuming the key here is what makes it work while the permission dialog
    // holds focus: TUI input listeners run before the focused component.
    unsubscribeInput =
      ctx.hasUI && ctx.mode === "tui" ? ctx.ui.onTerminalInput(onInput) : undefined;
  });

  function onInput(data: string): { consume: boolean } | undefined {
    // Kitty/modifyOtherKeys can deliver a press and a release for one key, and
    // both match. Acting on either twice would fire two model calls.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (!activeRequestId || !matchesKey(data, config.key as KeyId)) return undefined;
    onExplainKey();
    return { consume: true };
  }

  pi.events.on("permissions:decision", (raw) => {
    const requestId = (raw as { requestId?: unknown } | null)?.requestId;
    if (requestId === activeRequestId) reset();
  });

  pi.events.on("permissions:ui_prompt", (raw) => {
    const event = (raw ?? {}) as UiPromptEvent;
    if (!ctxRef?.hasUI || ctxRef.mode !== "tui" || typeof event.requestId !== "string") return;

    const facts = describeRequest(event);
    if (!facts) return;

    activeRequestId = event.requestId;
    activeFacts = facts;
    explanation = undefined;
    visible = false;
    seq += 1;
    show([hint()]);
  });

  pi.on("session_shutdown", () => {
    unsubscribeInput?.();
    unsubscribeInput = undefined;
    ctxRef = undefined;
    reset();
  });
}

interface LoadedConfig {
  config: ExplainConfig;
  /** Present when a config file exists but could not be used. */
  error: string | undefined;
}

/** Read the config file. A missing file is normal; an unreadable one is reported. */
function loadConfig(): LoadedConfig {
  try {
    const path = join(getAgentDir(), "extensions", CONFIG_DIR, CONFIG_FILE);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { config: {}, error: "not a JSON object" };
    }
    return { config: parsed as ExplainConfig, error: undefined };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { config: {}, error: undefined };
    }
    return { config: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

const MODIFIER_NAMES = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * Whether a config `key` string looks like a key identifier pi-tui can match.
 *
 * pi-tui does not export its parser, so this checks the part that matters: an
 * unknown modifier makes pi-tui treat "control+e" as the plain key "e", which
 * would swallow every "e" press while a prompt is open. An unrecognized final
 * key name simply never matches, so it needs no check.
 */
function isValidKeyId(keyId: string): boolean {
  const parts = keyId.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  return key !== "" && parts.slice(0, -1).every((part) => MODIFIER_NAMES.has(part));
}

/** Apply defaults and reject empty values. */
function resolveConfig(config: ExplainConfig): { key: string; model?: string } {
  const key = firstString(config.key) ?? DEFAULT_KEY;
  return { key, model: firstString(config.model) };
}

/** Ask the model for a one-sentence explanation; undefined on any failure. */
async function explain(
  ctx: ExtensionContext,
  facts: Record<string, string>,
  model: NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>,
): Promise<string | undefined> {
  const response = await ctx.modelRegistry.complete(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: JSON.stringify(facts) }],
          timestamp: Date.now(),
        },
      ],
    },
    ctx.signal ? { signal: ctx.signal } : undefined,
  );
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/**
 * Turn the bus event's facts into a short JSON object for the model.
 *
 * One shape for every surface: a bash command, a path, an MCP target, or a
 * skill name.
 */
function describeRequest(event: UiPromptEvent): Record<string, string> | undefined {
  const request = event.request ?? {};
  const facts: Record<string, string> = {};

  const tool = firstString(request.toolName, event.surface);
  if (tool) facts.tool = tool;

  const gate = firstString(request.surface);
  if (gate && gate !== tool) facts.gatedBy = gate;

  const value = firstString(request.executedUnit, request.value, event.value);
  if (value) facts[gate === "bash" ? "command" : "value"] = value;

  const rule = firstString(request.matchedPattern);
  if (rule) facts.matchedRule = rule;

  if (event.forwarding) {
    facts.requestedBy = `subagent ${firstString(event.forwarding.requesterAgentName) ?? "unknown"}`;
  }

  return Object.keys(facts).length > 0 ? facts : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

if (process.env.PERMISSION_EXPLAIN_SELFCHECK) {
  const bash = describeRequest({
    surface: "bash",
    value: "git push",
    request: { surface: "bash", toolName: "bash", value: "git push", matchedPattern: "git push*" },
  });
  if (JSON.stringify(bash) !== '{"tool":"bash","command":"git push","matchedRule":"git push*"}') {
    throw new Error(`describeRequest(bash) = ${JSON.stringify(bash)}`);
  }
  const path = describeRequest({
    surface: "read",
    value: "/x/.ssh/id",
    request: { surface: "external_directory", toolName: "read", value: "/x/.ssh/id", matchedPattern: "~/.ssh/*" },
  });
  if (
    JSON.stringify(path) !==
    '{"tool":"read","gatedBy":"external_directory","value":"/x/.ssh/id","matchedRule":"~/.ssh/*"}'
  ) {
    throw new Error(`describeRequest(path) = ${JSON.stringify(path)}`);
  }
  if (describeRequest({}) !== undefined) {
    throw new Error("describeRequest(empty) should be undefined");
  }
  const forwarded = describeRequest({
    surface: "bash",
    value: "rm -rf /tmp/x",
    request: { surface: "bash", toolName: "bash", value: "rm -rf /tmp/x" },
    forwarding: { requesterAgentName: "Explore" },
  });
  if (forwarded?.requestedBy !== "subagent Explore") {
    throw new Error(`describeRequest(forwarded) = ${JSON.stringify(forwarded)}`);
  }
  if (describeRequest({ forwarding: null }) !== undefined) {
    throw new Error("describeRequest(null forwarding) should be undefined");
  }
  if (resolveConfig({}).key !== DEFAULT_KEY) {
    throw new Error("resolveConfig default key");
  }
  if (resolveConfig({ key: "  ", model: " openai/gpt " }).key !== DEFAULT_KEY) {
    throw new Error("resolveConfig should reject blank key");
  }
  if (resolveConfig({ model: " openai/gpt " }).model !== "openai/gpt") {
    throw new Error("resolveConfig should trim model");
  }
  if (!isValidKeyId("ctrl+e") || !isValidKeyId("ctrl+shift+x") || !isValidKeyId("f2")) {
    throw new Error("isValidKeyId should accept modifiers and named keys");
  }
  if (isValidKeyId("control+e") || isValidKeyId("")) {
    throw new Error("isValidKeyId should reject unknown modifiers and empty keys");
  }
  console.log("permission-explain selfcheck ok");
}
