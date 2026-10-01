import type { Api } from "grammy";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StreamMode } from "../core/config.ts";
import { silentLogger, type Logger } from "../core/logger.ts";
import type { Target } from "../core/types.ts";
import { escapeHtml, tail, truncate } from "./format.ts";
import type { ChatBudget } from "./limiter.ts";
import { editHtml, sendDraft, sendHtml, sendMarkdown, sendPlain, sendTyping, TopicGoneError } from "./send.ts";
import { displayToolName, toolIcon, toolSummary } from "./tools.ts";

const PREVIEW_LIMIT = 3900;
const STATUS_MAX_LINES = 20;

type ContentBlock = { type: string; [k: string]: unknown };

/** Shared, so a failing draft API switches every tab to message edits once. */
export interface StreamModeRef {
  mode: StreamMode;
}

export interface RenderOptions {
  verbose: () => boolean;
  stream: StreamModeRef;
  budget: ChatBudget;
  log?: Logger;
  /** A background update found the tab deleted. */
  onTopicGone?: (err: TopicGoneError) => void;
}

/**
 * Renders one tab's SDK message stream: a live preview of text being
 * generated, a compact status message per run of tool calls, and final
 * Markdown as Telegram HTML. One instance per tab.
 */
export class TurnRenderer {
  private readonly api: Api;
  readonly target: Target;
  private readonly opts: RenderOptions;
  private readonly log: Logger;

  private text = "";
  private draftId = 0;
  private previewMsgId: number | null = null;
  private previewTimer: NodeJS.Timeout | null = null;
  private lastPreviewAt = 0;
  private previewGen = 0;

  private statusMsgId: number | null = null;
  private statusLines: string[] = [];
  private statusHidden = 0;
  private statusTimer: NodeJS.Timeout | null = null;

  private typingTimer: NodeJS.Timeout | null = null;
  private turnHadOutput = false;
  private lastRateLimit = "";

  constructor(api: Api, target: Target, opts: RenderOptions) {
    this.api = api;
    this.target = target;
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
  }

  /** A message was sent to Claude (it may still wait for a process or behind a running turn). */
  beginTurn(): void {
    this.startTyping();
  }

  private startTyping(): void {
    if (this.typingTimer) return;
    const tick = () => sendTyping(this.api, this.target).catch(() => {});
    tick();
    this.typingTimer = setInterval(tick, 4500);
    this.typingTimer.unref();
  }

  stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  /** Stop all timers (process gone, tab closed or deleted). */
  dispose(): void {
    this.stopTyping();
    this.cancelPreview();
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.statusMsgId = null;
    this.statusLines = [];
    this.statusHidden = 0;
    this.previewMsgId = null;
    this.text = "";
    this.turnHadOutput = false;
  }

  async handle(msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case "stream_event": {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === "content_block_start" && ev.content_block.type === "text") {
          this.text = "";
          this.draftId = 1 + Math.floor(Math.random() * 2 ** 30);
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          this.text += ev.delta.text;
          this.schedulePreview();
        }
        return;
      }

      case "assistant": {
        const blocks = msg.message.content as unknown as ContentBlock[];
        if (msg.parent_tool_use_id) {
          for (const b of blocks) if (b.type === "tool_use") await this.addStatus(this.toolLine(b, "  ↳ "));
          return;
        }
        for (const b of blocks) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            await this.sendText(msg.error ? `❌ ${b.text}` : b.text);
          } else if (b.type === "tool_use") {
            await this.addStatus(this.toolLine(b));
          }
        }
        return;
      }

      case "user": {
        if (!this.opts.verbose() || msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const b of content as unknown as ContentBlock[]) {
          if (b.type !== "tool_result") continue;
          const out =
            typeof b.content === "string"
              ? b.content
              : Array.isArray(b.content)
                ? (b.content as ContentBlock[]).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
                : "";
          if (!out.trim()) continue;
          await this.closeStatus();
          await sendHtml(this.api, this.target, `${b.is_error ? "⚠️" : "↩️"} <pre>${escapeHtml(truncate(out.trim(), 1500))}</pre>`);
        }
        return;
      }

      case "system":
        switch (msg.subtype) {
          case "init": // start of a turn
            this.startTyping();
            return;
          case "local_command_output":
            this.turnHadOutput = true;
            await this.closeStatus();
            await sendMarkdown(this.api, this.target, msg.content);
            return;
          case "compact_boundary": {
            const { pre_tokens, post_tokens } = msg.compact_metadata;
            const post = post_tokens ? ` → ${post_tokens.toLocaleString()}` : "";
            await this.notice(`🗜 Context compacted: ${pre_tokens.toLocaleString()}${post} tokens`);
            return;
          }
          case "status":
            if (msg.status === "compacting") await this.notice("🗜 Compacting context…");
            return;
          case "api_retry":
            if (msg.attempt === 1 || msg.attempt === msg.max_retries) {
              await this.notice(
                `⏳ API error (${msg.error}${msg.error_status ? ` ${msg.error_status}` : ""}), retry ${msg.attempt}/${msg.max_retries}…`,
              );
            }
            return;
          case "permission_denied":
            await this.addStatus(`⛔ ${escapeHtml(displayToolName(msg.tool_name))} denied: ${escapeHtml(truncate(msg.message, 150))}`);
            return;
          case "informational":
            if (msg.level === "warning" || msg.level === "notice") await this.notice(`ℹ️ ${escapeHtml(msg.content)}`);
            return;
          case "notification":
            if (msg.priority === "high" || msg.priority === "immediate") await this.notice(`🔔 ${escapeHtml(msg.text)}`);
            return;
        }
        return;

      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        const key = `${info.status}:${info.rateLimitType}`;
        if (info.status === "allowed" || key === this.lastRateLimit) return;
        this.lastRateLimit = key;
        const pct = info.utilization != null ? ` ${Math.round(info.utilization * 100)}%` : "";
        const reset = info.resetsAt ? `, resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : "";
        const icon = info.status === "rejected" ? "🛑" : "⚠️";
        await this.notice(`${icon} Usage limit ${info.rateLimitType ?? ""}${pct}${reset}`);
        return;
      }

      case "conversation_reset":
        await this.notice("🧹 Conversation cleared; this tab now continues in a new session");
        return;

      case "result": {
        this.stopTyping();
        this.cancelPreview();
        await this.flushStatus();
        if (msg.subtype !== "success") {
          const why = msg.errors?.length ? msg.errors.join("\n") : msg.subtype;
          await this.notice(`❌ ${escapeHtml(truncate(why, 1000))}`);
        } else if (msg.is_error) {
          // API errors (auth, rate limit…) usually already arrived as assistant text.
          if (!this.turnHadOutput) await this.notice(`❌ ${escapeHtml(truncate(msg.result || "Something went wrong", 1000))}`);
        } else if (!this.turnHadOutput && msg.result?.trim()) {
          await sendMarkdown(this.api, this.target, msg.result);
        }
        if (this.opts.verbose()) {
          await this.notice(`<i>⏱ ${(msg.duration_ms / 1000).toFixed(1)}s · ${msg.num_turns} turns</i>`);
        }
        this.statusMsgId = null;
        this.statusLines = [];
        this.statusHidden = 0;
        this.turnHadOutput = false;
        return;
      }
    }
  }

  private toolLine(b: ContentBlock, prefix = ""): string {
    const name = String(b.name);
    const summary = toolSummary(name, (b.input ?? {}) as Record<string, unknown>, 120);
    return `${prefix}${toolIcon(name)} <b>${escapeHtml(displayToolName(name))}</b>${summary ? ` <code>${escapeHtml(summary)}</code>` : ""}`;
  }

  /** Send a short standalone HTML notice, after closing the current status block. */
  async notice(html: string): Promise<void> {
    await this.closeStatus();
    await sendHtml(this.api, this.target, html);
  }

  private async sendText(text: string): Promise<void> {
    this.turnHadOutput = true;
    this.previewGen++;
    this.cancelPreview();
    await this.closeStatus();
    if (this.previewMsgId) {
      await this.api.deleteMessage(this.target.chatId, this.previewMsgId).catch(() => {});
      this.previewMsgId = null;
    }
    await sendMarkdown(this.api, this.target, text);
    this.text = "";
  }

  /** Errors from timer-driven (best-effort) updates: report a deleted tab, log the rest. */
  private background(what: string): (err: unknown) => void {
    return (err) => {
      if (err instanceof TopicGoneError) this.opts.onTopicGone?.(err);
      else this.log.debug(`${what} failed:`, err);
    };
  }

  // ---- live preview ------------------------------------------------------

  private schedulePreview(): void {
    if (this.opts.stream.mode === "off" || this.previewTimer) return;
    const interval = this.opts.stream.mode === "draft" ? 700 : 1500;
    const wait = Math.max(0, this.lastPreviewAt + interval - Date.now());
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (!this.opts.budget.take(this.target.chatId)) {
        this.schedulePreview(); // over budget: try again later
        return;
      }
      this.lastPreviewAt = Date.now();
      this.pushPreview().catch(this.background("preview"));
    }, wait);
  }

  private cancelPreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
  }

  private async pushPreview(): Promise<void> {
    const text = tail(this.text, PREVIEW_LIMIT);
    if (!text.trim()) return;
    if (this.opts.stream.mode === "draft") {
      try {
        await sendDraft(this.api, this.target, this.draftId, text);
        return;
      } catch (err) {
        if (err instanceof TopicGoneError) throw err;
        this.log.warn("sendMessageDraft unavailable, falling back to message edits:", err);
        this.opts.stream.mode = "edit";
      }
    }
    if (this.previewMsgId) {
      await this.api.editMessageText(this.target.chatId, this.previewMsgId, text).catch(() => {});
    } else {
      const gen = this.previewGen;
      const id = await sendPlain(this.api, this.target, text);
      // The final text was sent while this request was in flight: drop the stale preview.
      if (gen !== this.previewGen) await this.api.deleteMessage(this.target.chatId, id).catch(() => {});
      else this.previewMsgId = id;
    }
  }

  // ---- tool status -------------------------------------------------------

  private async addStatus(line: string): Promise<void> {
    this.statusLines.push(line);
    if (this.statusLines.length > STATUS_MAX_LINES) {
      this.statusLines.shift();
      this.statusHidden++;
    }
    if (this.statusMsgId === null) {
      // Create immediately so it stays in order with the text around it.
      this.statusMsgId = await sendHtml(this.api, this.target, this.statusHtml());
      return;
    }
    this.scheduleStatus();
  }

  private scheduleStatus(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (!this.opts.budget.take(this.target.chatId)) {
        this.scheduleStatus();
        return;
      }
      this.flushStatus().catch(this.background("status edit"));
    }, 1000);
  }

  private statusHtml(): string {
    const hidden = this.statusHidden ? `<i>…${this.statusHidden} earlier</i>\n` : "";
    return hidden + this.statusLines.join("\n");
  }

  private async flushStatus(): Promise<void> {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    if (this.statusMsgId !== null && this.statusLines.length) {
      await editHtml(this.api, this.target, this.statusMsgId, this.statusHtml());
    }
  }

  /** Finish the current status message; later tool calls start a new one below. */
  private async closeStatus(): Promise<void> {
    await this.flushStatus();
    this.statusMsgId = null;
    this.statusLines = [];
    this.statusHidden = 0;
  }
}
