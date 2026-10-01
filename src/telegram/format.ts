import { Lexer, type Token, type Tokens } from "marked";

/** Telegram caps a message at 4096 visible chars; leave headroom for formatting. */
export const CHUNK_LIMIT = 3500;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Display width with CJK / fullwidth chars counted as 2 (for table alignment). */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    w += cp >= 0x1100 && /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1;
  }
  return w;
}

function inlinePlain(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((t) => {
      const anyT = t as Token & { tokens?: Token[]; text?: string };
      if (anyT.tokens?.length) return inlinePlain(anyT.tokens);
      return anyT.text ?? anyT.raw ?? "";
    })
    .join("");
}

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "strong":
        out += `<b>${renderInline(t.tokens)}</b>`;
        break;
      case "em":
        out += `<i>${renderInline(t.tokens)}</i>`;
        break;
      case "del":
        out += `<s>${renderInline(t.tokens)}</s>`;
        break;
      case "codespan":
        out += `<code>${escapeHtml(t.text)}</code>`;
        break;
      case "link": {
        const label = renderInline(t.tokens) || escapeHtml(t.href);
        out += /^(https?|tg|mailto):/i.test(t.href) ? `<a href="${escapeAttr(t.href)}">${label}</a>` : label;
        break;
      }
      case "image":
        out += /^https?:/i.test(t.href)
          ? `<a href="${escapeAttr(t.href)}">${escapeHtml(t.text || "image")}</a>`
          : escapeHtml(t.text || t.href);
        break;
      case "br":
        out += "\n";
        break;
      case "checkbox": // task-list marker inside loose items; rendered by renderList
        break;
      case "text":
        out += t.tokens?.length ? renderInline(t.tokens) : escapeHtml(t.text);
        break;
      case "escape":
      case "html":
        out += escapeHtml(t.text);
        break;
      default:
        out += escapeHtml((t as { raw?: string }).raw ?? "");
    }
  }
  return out;
}

function renderTable(t: Tokens.Table): string {
  const rows = [t.header.map((c) => inlinePlain(c.tokens)), ...t.rows.map((r) => r.map((c) => inlinePlain(c.tokens)))];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => displayWidth(r[i] ?? ""))));
  const line = (r: string[]) => r.map((c, i) => c + " ".repeat(widths[i] - displayWidth(c))).join(" │ ").trimEnd();
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  const text = [line(rows[0]), sep, ...rows.slice(1).map(line)].join("\n");
  return `<pre>${escapeHtml(text)}</pre>`;
}

function renderList(t: Tokens.List, depth: number): string {
  const indent = "  ".repeat(depth);
  const start = typeof t.start === "number" ? t.start : 1;
  return t.items
    .map((item, i) => {
      let bullet = t.ordered ? `${start + i}.` : "•";
      if (item.task) bullet = item.checked ? "☑" : "☐";
      const body = renderBlocks(item.tokens, depth + 1).trim();
      return `${indent}${bullet} ${body}`;
    })
    .join("\n");
}

function renderBlocks(tokens: Token[], depth = 0): string {
  const parts: string[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case "space":
      case "def":
      case "checkbox": // task-list marker; rendered by renderList
        break;
      case "heading":
        parts.push(`<b>${renderInline(t.tokens)}</b>`);
        break;
      case "paragraph":
        parts.push(renderInline(t.tokens));
        break;
      case "text":
        // Block-level text inside tight list items.
        parts.push(t.tokens?.length ? renderInline(t.tokens) : escapeHtml(t.text));
        break;
      case "code": {
        const lang = t.lang?.trim().split(/\s+/)[0];
        const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
        parts.push(`<pre><code${cls}>${escapeHtml(t.text)}</code></pre>`);
        break;
      }
      case "blockquote":
        parts.push(`<blockquote>${renderBlocks(t.tokens ?? [], depth).trim()}</blockquote>`);
        break;
      case "list":
        parts.push(renderList(t as Tokens.List, depth));
        break;
      case "table":
        parts.push(renderTable(t as Tokens.Table));
        break;
      case "hr":
        parts.push("──────────");
        break;
      case "html":
        parts.push(escapeHtml(t.text));
        break;
      default:
        parts.push(escapeHtml((t as { raw?: string }).raw ?? ""));
    }
  }
  // Nested blocks (inside list items) join tighter than top-level ones.
  return parts.join(depth > 0 ? "\n" : "\n\n");
}

/** Convert Claude's Markdown into the HTML subset Telegram accepts. */
export function markdownToTelegramHtml(md: string): string {
  return renderBlocks(Lexer.lex(md)).trim();
}

/**
 * Split Markdown into chunks of at most `limit` chars, breaking on line
 * boundaries and closing/reopening code fences so every chunk renders alone.
 */
export function splitMarkdown(md: string, limit = CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  let fence: string | null = null; // opening fence line while inside a code block

  const flush = () => {
    if (!current.trim()) return;
    chunks.push(fence ? `${current}\n${fence.match(/^(`+|~+)/)![1]}` : current);
    current = fence ? fence : "";
  };

  // Hard-wrap pathological single lines.
  const wrapAt = Math.max(1, Math.floor(limit * 0.9));
  const pieces = md.split("\n").flatMap((line) => {
    const out: string[] = [];
    for (let i = 0; i < line.length; i += wrapAt) out.push(line.slice(i, i + wrapAt));
    return out.length ? out : [""];
  });

  for (const line of pieces) {
    const isFence = /^\s*(```+|~~~+)/.test(line);
    const closesFence = isFence && fence !== null;
    const candidate = current ? `${current}\n${line}` : line;
    // Reserve room for a closing fence; a closing fence line itself always fits.
    if (!closesFence && candidate.length + 4 > limit && current) {
      flush();
      current = current ? `${current}\n${line}` : line;
    } else {
      current = candidate;
    }
    if (isFence) fence = fence ? null : line.trim();
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** Last `limit` chars of text, cut at a line start when possible (for live previews). */
export function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(-limit);
  const nl = cut.indexOf("\n");
  return "…" + (nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}
