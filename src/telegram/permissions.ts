import { InlineKeyboard, type Api, type Context } from "grammy";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { silentLogger, type Logger } from "../core/logger.ts";
import { targetOfKey, type Target, type ThreadKey } from "../core/types.ts";
import { escapeHtml, truncate } from "./format.ts";
import { editHtml, sendHtml, sendMarkdown } from "./send.ts";
import { displayToolName, toolSummary } from "./tools.ts";

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];
}

interface Base {
  key: ThreadKey;
  target: Target;
  messageId: number;
  resolve: (r: PermissionResult) => void;
}

interface PendingTool extends Base {
  kind: "tool";
  html: string;
  suggestions?: PermissionUpdate[];
}

interface PendingQuestion extends Base {
  kind: "question";
  input: Record<string, unknown>;
  questions: Question[];
  index: number;
  selected: Set<number>;
  answers: Record<string, string>;
}

type Pending = PendingTool | PendingQuestion;

const FEEDBACK_HINT = "Reply with text to deny and tell Claude what to do instead";

export interface BrokerHooks {
  /** A prompt opened (+1) or closed (-1) for the tab; keeps the session busy meanwhile. */
  onBlocked(key: ThreadKey, delta: number): void;
}

/**
 * Bridges Claude Code permission prompts and AskUserQuestion to inline
 * keyboards in the tab that asked. Only requests the permission mode
 * escalates reach here.
 */
export class PermissionBroker {
  private readonly api: Api;
  private readonly timeoutMs: number;
  private readonly hooks: BrokerHooks;
  private readonly log: Logger;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(api: Api, timeoutMs: number, hooks: BrokerHooks, log: Logger = silentLogger) {
    this.api = api;
    this.timeoutMs = timeoutMs;
    this.hooks = hooks;
    this.log = log;
  }

  hasPending(key: ThreadKey): boolean {
    for (const p of this.pending.values()) if (p.key === key) return true;
    return false;
  }

  canUseToolFor(key: ThreadKey): CanUseTool {
    const target = targetOfKey(key);
    return async (toolName, input, opts) => {
      const id = String(++this.seq);
      this.hooks.onBlocked(key, +1);
      return new Promise<PermissionResult>((resolve) => {
        let done = false;
        const finish = (r: PermissionResult) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          opts.signal.removeEventListener("abort", onAbort);
          this.hooks.onBlocked(key, -1);
          resolve(r);
        };
        const timer = setTimeout(() => {
          this.settle(id, "⌛ No response in time, denied");
          finish({ behavior: "deny", message: "The user did not respond to the permission request in time." });
        }, this.timeoutMs);
        const onAbort = () => {
          this.settle(id, "🚫 Cancelled");
          finish({ behavior: "deny", message: "Request cancelled." });
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });

        const register = (p: Pending) => {
          this.pending.set(id, p);
          // Finished while the prompt was still being sent: clear the stale buttons.
          if (done) this.settle(id, "🚫 Cancelled");
        };
        const ask =
          toolName === "AskUserQuestion"
            ? this.askQuestion(id, key, target, input, finish, register)
            : this.askPermission(id, key, target, toolName, input, opts, finish, register);
        ask.catch((err) => {
          this.log.error("failed to send permission prompt:", err);
          finish({ behavior: "deny", message: "Could not reach the user on Telegram." });
        });
      });
    };
  }

  private async askPermission(
    id: string,
    key: ThreadKey,
    target: Target,
    toolName: string,
    input: Record<string, unknown>,
    opts: Parameters<CanUseTool>[2],
    resolve: (r: PermissionResult) => void,
    register: (p: Pending) => void,
  ): Promise<void> {
    if (toolName === "ExitPlanMode" && typeof input.plan === "string") {
      await sendMarkdown(this.api, target, `📋 **Plan**\n\n${input.plan}`);
    }
    const title = opts.title ?? `Claude wants to use ${displayToolName(toolName)}`;
    const detail = toolName === "ExitPlanMode" ? "" : toolSummary(toolName, input, 1500);
    let html = `🔐 <b>${escapeHtml(title)}</b>`;
    if (detail) html += `\n<pre>${escapeHtml(detail)}</pre>`;
    if (opts.description) html += `\n${escapeHtml(opts.description)}`;
    if (opts.decisionReason) html += `\n<i>${escapeHtml(truncate(opts.decisionReason, 300))}</i>`;
    html += `\n\n<i>${FEEDBACK_HINT}</i>`;

    const allow = toolName === "ExitPlanMode" ? "✅ Approve plan" : "✅ Allow";
    const kb = new InlineKeyboard();
    const canAlways = !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule;
    if (opts.defaultToNo) kb.text("❌ Deny", `p:${id}:d`);
    kb.text(allow, `p:${id}:a`);
    if (canAlways) kb.text("♾ Always allow", `p:${id}:A`);
    if (!opts.defaultToNo) kb.text("❌ Deny", `p:${id}:d`);

    const messageId = await sendHtml(this.api, target, html, { keyboard: kb });
    register({ kind: "tool", key, target, messageId, html, suggestions: opts.suggestions, resolve });
  }

  private async askQuestion(
    id: string,
    key: ThreadKey,
    target: Target,
    input: Record<string, unknown>,
    resolve: (r: PermissionResult) => void,
    register: (p: Pending) => void,
  ): Promise<void> {
    const questions = (Array.isArray(input.questions) ? input.questions : []) as Question[];
    if (questions.length === 0) {
      resolve({ behavior: "allow", updatedInput: input });
      return;
    }
    const p: PendingQuestion = {
      kind: "question",
      key,
      target,
      messageId: 0,
      input,
      questions,
      index: 0,
      selected: new Set(),
      answers: {},
      resolve,
    };
    const { html, kb } = this.renderQuestion(id, p);
    p.messageId = await sendHtml(this.api, target, html, { keyboard: kb });
    register(p);
  }

  private renderQuestion(id: string, p: PendingQuestion): { html: string; kb: InlineKeyboard } {
    const q = p.questions[p.index];
    const progress = p.questions.length > 1 ? ` (${p.index + 1}/${p.questions.length})` : "";
    let html = `❓ <b>${escapeHtml(q.header ?? "Question")}</b>${progress}\n${escapeHtml(q.question)}\n`;
    q.options.forEach((o, i) => {
      html += `\n<b>${i + 1}. ${escapeHtml(o.label)}</b>`;
      if (o.description) html += ` — ${escapeHtml(o.description)}`;
      if (o.preview) html += `\n<pre>${escapeHtml(truncate(o.preview, 600))}</pre>`;
    });
    html += `\n\n<i>${q.multiSelect ? "Pick any number, then tap Done. " : ""}Or reply with text to answer.</i>`;

    const kb = new InlineKeyboard();
    q.options.forEach((o, i) => {
      const mark = q.multiSelect && p.selected.has(i) ? "☑ " : "";
      kb.text(truncate(`${mark}${o.label}`, 60), `q:${id}:${i}`).row();
    });
    if (q.multiSelect) kb.text("✅ Done", `q:${id}:done`);
    return { html, kb };
  }

  /** Handle a prompt button. Returns false when the callback is not a prompt button. */
  async handleCallback(ctx: Context): Promise<boolean> {
    const data = ctx.callbackQuery?.data ?? "";
    const m = data.match(/^([pq]):(\d+):(.+)$/);
    if (!m) return false;
    const [, kind, id, action] = m;
    const p = this.pending.get(id);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "This request has already ended" });
      return true;
    }
    if (kind === "p" && p.kind === "tool") {
      if (action === "a") {
        this.settle(id, "✅ Allowed");
        p.resolve({ behavior: "allow" });
      } else if (action === "A") {
        this.settle(id, "♾ Allowed (won't ask again this session)");
        p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
      } else {
        this.settle(id, "❌ Denied");
        p.resolve({ behavior: "deny", message: "The user denied this action." });
      }
    } else if (kind === "q" && p.kind === "question") {
      const q = p.questions[p.index];
      if (action === "done") {
        await this.answer(id, p, [...p.selected].sort((a, b) => a - b).map((i) => q.options[i].label).join(", "));
      } else {
        const i = Number(action);
        if (q.options[i]) {
          if (q.multiSelect) {
            if (p.selected.has(i)) p.selected.delete(i);
            else p.selected.add(i);
            const { html, kb } = this.renderQuestion(id, p);
            await editHtml(this.api, p.target, p.messageId, html, kb);
          } else {
            await this.answer(id, p, q.options[i].label);
          }
        }
      }
    }
    await ctx.answerCallbackQuery();
    return true;
  }

  /**
   * Free text in a tab with an open prompt: answers its question, or denies
   * its oldest permission request with the text as feedback. Returns false
   * when the tab has nothing pending.
   */
  async handleText(key: ThreadKey, text: string): Promise<boolean> {
    const entry = [...this.pending.entries()].find(([, p]) => p.key === key);
    if (!entry) return false;
    const [id, p] = entry;
    if (p.kind === "question") {
      await this.answer(id, p, text);
    } else {
      this.settle(id, `💬 Denied with feedback: ${escapeHtml(truncate(text, 200))}`);
      p.resolve({ behavior: "deny", message: `The user declined and said: ${text}` });
    }
    return true;
  }

  private async answer(id: string, p: PendingQuestion, answer: string): Promise<void> {
    const q = p.questions[p.index];
    p.answers[q.question] = answer;
    if (p.index + 1 < p.questions.length) {
      p.index++;
      p.selected.clear();
      const { html, kb } = this.renderQuestion(id, p);
      await editHtml(this.api, p.target, p.messageId, html, kb);
      return;
    }
    const summary = Object.entries(p.answers)
      .map(([question, a]) => `• ${escapeHtml(truncate(question, 80))}\n  → <b>${escapeHtml(a)}</b>`)
      .join("\n");
    this.settle(id, `✅ Answered\n${summary}`, true);
    p.resolve({ behavior: "allow", updatedInput: { ...p.input, answers: p.answers } });
  }

  /** Remove a pending request and replace its buttons with a final status line. */
  private settle(id: string, status: string, replace = false): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const html =
      replace || p.kind === "question"
        ? status
        : `${p.html.replace(new RegExp(`\\n\\n<i>${FEEDBACK_HINT}</i>$`), "")}\n\n${status}`;
    editHtml(this.api, p.target, p.messageId, html).catch((err) => this.log.debug("settle edit failed:", err));
  }

  /** Deny everything still waiting in one tab (e.g. /stop, process exit). */
  cancel(key: ThreadKey): void {
    for (const [id, p] of [...this.pending]) {
      if (p.key !== key) continue;
      this.settle(id, "🚫 Cancelled");
      p.resolve({ behavior: "deny", message: "Request cancelled by the user." });
    }
  }

  cancelAll(): void {
    for (const [id, p] of [...this.pending]) {
      this.settle(id, "🚫 Cancelled");
      p.resolve({ behavior: "deny", message: "Request cancelled." });
    }
  }
}
