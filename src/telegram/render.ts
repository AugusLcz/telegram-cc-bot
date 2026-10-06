import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StreamMode } from "../core/config.ts";
import { silentLogger, type Logger } from "../core/logger.ts";
import type { Target } from "../core/types.ts";
import { escapeHtml, tail, truncate } from "./format.ts";
import type { ChatBudget } from "./limiter.ts";
import { sendDraft, sendHtml, sendMarkdown, sendPlain, sendTyping, TopicGoneError } from "./send.ts";
import { displayToolName } from "./tools.ts";
import { WorkingMessage } from "./working.ts";

const PREVIEW_LIMIT = 3900;
const THINKING_LIMIT = 3500;

type ContentBlock = { type: string; [k: string]: unknown };

/** Shared, so a failing draft API switches every tab to message edits once. */
export interface StreamModeRef {
  mode: StreamMode;
}

export interface RenderOptions {
  /** Show Claude's notes between steps, its thinking and timings: the chat's /thinking. */
  thinking: () => boolean;
  stream: StreamModeRef;
  budget: ChatBudget;
  /** Buttons on the working message (Stop). */
  workingKeyboard?: InlineKeyboardMarkup;
  workingDelayMs?: number;
  workingTickMs?: number;
  log?: Logger;
  /** A background update found the tab deleted. */
  onTopicGone?: (err: TopicGoneError) => void;
}

/**
 * Renders one tab's SDK message stream. By default a chat shows Claude's
 * answers only: text that a tool call follows was a note on the way, so text
 * is held until the turn's result shows it was the last. With /thinking on,
 * notes, thinking summaries and a live preview are shown as they come. Tool
 * calls are never shown. While a turn runs, a working message and the typing
 * action say so. One instance per tab.
 */
export class TurnRenderer {
  private readonly api: Api;
  readonly target: Target;
  private readonly opts: RenderOptions;
  private readonly log: Logger;
  private readonly working: WorkingMessage;

  private text = "";
  private draftId = 0;
  private previewMsgId: number | null = null;
  private previewTimer: NodeJS.Timeout | null = null;
  private lastPreviewAt = 0;
  private previewGen = 0;

  /** Text of this turn that no tool call followed (yet): the answer, if the turn ends now. */
  private pending: string[] = [];
  private blockedCount = 0;
  private typingTimer: NodeJS.Timeout | null = null;
  private turnHadOutput = false;
  private lastRateLimit = "";

  constructor(api: Api, target: Target, opts: RenderOptions) {
    this.api = api;
    this.target = target;
    this.opts = opts;
    this.log = opts.log ?? silentLogger;
    this.working = new WorkingMessage(api, target, {
      budget: opts.budget,
      keyboard: opts.workingKeyboard,
      delayMs: opts.workingDelayMs,
      tickMs: opts.workingTickMs,
      log: this.log,
      onTopicGone: opts.onTopicGone,
    });
  }

  /** A message was sent to Claude (it may still wait for a process or behind a running turn). */
  beginTurn(): void {
    this.working.start();
    if (!this.blockedCount) this.startTyping();
  }

  /** The turn ended without a result (the send failed, a queued message was cancelled). */
  async endTurn(): Promise<void> {
    this.stopTyping();
    await this.working.stop();
  }

  /** A permission prompt or question opened (+1) or closed (-1); Claude waits for the user meanwhile. */
  blocked(delta: number): void {
    const was = this.blockedCount;
    this.blockedCount = Math.max(0, was + delta);
    if (!was && this.blockedCount) {
      this.stopTyping();
      void this.working.pause();
    } else if (was && !this.blockedCount && this.working.active) {
      this.startTyping();
      void this.working.resume();
    }
  }

  private startTyping(): void {
    if (this.typingTimer) return;
    const tick = () => sendTyping(this.api, this.target).catch(() => {});
    tick();
    this.typingTimer = setInterval(tick, 4500);
    this.typingTimer.unref();
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  /** Stop all timers (process gone, tab closed or deleted). */
  dispose(): void {
    this.stopTyping();
    this.cancelPreview();
    this.working.dispose();
    this.previewMsgId = null;
    this.text = "";
    this.pending = [];
    this.blockedCount = 0;
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
        if (msg.parent_tool_use_id) return; // a subagent's work stays out of the chat
        const thinking = this.opts.thinking();
        for (const b of msg.message.content as unknown as ContentBlock[]) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            if (msg.error) await this.sendText(`❌ ${b.text}`);
            else if (thinking) await this.sendText(b.text);
            else this.pending.push(b.text);
          } else if (b.type === "tool_use") {
            this.pending = []; // a note on the way, not the answer
          } else if (b.type === "thinking" && thinking && typeof b.thinking === "string" && b.thinking.trim()) {
            await this.notice(`💭 <blockquote expandable>${escapeHtml(truncate(b.thinking.trim(), THINKING_LIMIT))}</blockquote>`);
          }
        }
        return;
      }

      case "system":
        switch (msg.subtype) {
          case "init": // start of a turn
            this.beginTurn();
            return;
          case "local_command_output":
            this.turnHadOutput = true;
            await this.working.sendAbove(() => sendMarkdown(this.api, this.target, msg.content));
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
            if (this.opts.thinking()) {
              await this.notice(`⛔ ${escapeHtml(displayToolName(msg.tool_name))} denied: ${escapeHtml(truncate(msg.message, 150))}`);
            }
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
        await this.working.stop();
        const answer = this.pending;
        this.pending = [];
        for (const text of answer) await this.sendText(text);
        if (msg.subtype !== "success") {
          const why = msg.errors?.length ? msg.errors.join("\n") : msg.subtype;
          await this.notice(`❌ ${escapeHtml(truncate(why, 1000))}`);
        } else if (msg.is_error) {
          // API errors (auth, rate limit…) usually already arrived as assistant text.
          if (!this.turnHadOutput) await this.notice(`❌ ${escapeHtml(truncate(msg.result || "Something went wrong", 1000))}`);
        } else if (!this.turnHadOutput && msg.result?.trim()) {
          await sendMarkdown(this.api, this.target, msg.result);
        }
        if (this.opts.thinking()) {
          await this.notice(`<i>⏱ ${(msg.duration_ms / 1000).toFixed(1)}s · ${msg.num_turns} turns</i>`);
        }
        this.turnHadOutput = false;
        return;
      }
    }
  }

  /** Send a short standalone HTML notice (above the working message). */
  async notice(html: string): Promise<void> {
    await this.working.sendAbove(() => sendHtml(this.api, this.target, html));
  }

  private async sendText(text: string): Promise<void> {
    this.turnHadOutput = true;
    this.previewGen++;
    this.cancelPreview();
    if (this.previewMsgId) {
      await this.api.deleteMessage(this.target.chatId, this.previewMsgId).catch(() => {});
      this.previewMsgId = null;
    }
    await this.working.sendAbove(() => sendMarkdown(this.api, this.target, text));
    this.text = "";
  }

  /** Errors from timer-driven (best-effort) updates: report a deleted tab, log the rest. */
  private background(what: string): (err: unknown) => void {
    return (err) => {
      if (err instanceof TopicGoneError) this.opts.onTopicGone?.(err);
      else this.log.debug(`${what} failed:`, err);
    };
  }

  // ---- live preview (only with /thinking on: until the turn ends, text may be a note) ----

  private schedulePreview(): void {
    if (!this.opts.thinking() || this.opts.stream.mode === "off" || this.previewTimer) return;
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
      const id = await this.working.sendAbove(() => sendPlain(this.api, this.target, text));
      // The final text was sent while this request was in flight: drop the stale preview.
      if (gen !== this.previewGen) await this.api.deleteMessage(this.target.chatId, id).catch(() => {});
      else this.previewMsgId = id;
    }
  }
}
