import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { detailView, filterSkills, listView, type Browser } from "../src/app/skills.ts";
import { waitFor } from "./helpers/fake-process.ts";
import { harness, type Call } from "./helpers/harness.ts";

type Button = { text: string; callback_data?: string; copy_text?: { text: string } };
const rows = (kb: { inline_keyboard: Button[][] }) => kb.inline_keyboard;
const keyboardOf = (c: Call | undefined) => ((c?.payload.reply_markup as { inline_keyboard?: Button[][] })?.inline_keyboard ?? []);

const skill = (name: string, builtin = false, description = `About ${name}`, argumentHint = ""): SlashCommand => ({
  name,
  description,
  argumentHint,
  ...(builtin ? { builtin: true } : {}),
});

function browser(own: number, bundled: number, extra: Partial<Browser> = {}): Browser {
  return {
    cwd: "/w",
    own: Array.from({ length: own }, (_, i) => skill(`own-${String(i).padStart(2, "0")}`)),
    bundled: Array.from({ length: bundled }, (_, i) => skill(`cc-${i}`, true)),
    botNames: new Set(["status"]),
    tab: own ? "own" : "bundled",
    page: 0,
    ...extra,
  };
}

// ---- views -------------------------------------------------------------------------

test("listView: tabs, 2 buttons per row, 8 per page, page counter, wrap-around", () => {
  const b = browser(19, 3);
  const { html, keyboard } = listView(b);
  const kb = rows(keyboard);
  assert.deepEqual(kb[0].map((x) => [x.text, x.callback_data]), [
    ["● Yours (19)", "sk:t:own"],
    ["Claude Code (3)", "sk:t:bundled"],
  ]);
  const skills = kb.slice(1, -1);
  assert.equal(skills.length, 4, "8 skills, 2 per row");
  assert.ok(skills.every((r) => r.length === 2));
  assert.deepEqual(skills[0].map((x) => x.callback_data), ["sk:s:0", "sk:s:1"]);
  assert.deepEqual(kb.at(-1)!.map((x) => [x.text, x.callback_data]), [
    ["◀", "sk:p:-1"],
    ["1/3", "sk:n"],
    ["▶", "sk:p:1"],
  ]);
  assert.match(html, /19 yours · 3 Claude Code/);
  assert.match(html, /1\. \/own_00 — About own-00/);
  assert.ok(!html.includes("own-08"), "only this page's skills in the text");

  b.page = -1; // ◀ on the first page
  const last = rows(listView(b).keyboard);
  assert.equal(b.page, 2, "wraps to the last page");
  assert.deepEqual(last.slice(1, -1).flat().map((x) => x.callback_data), ["sk:s:16", "sk:s:17", "sk:s:18"]);
  assert.equal(last.slice(1, -1)[1].length, 1, "an odd last row");
});

test("listView: one page has no navigation; an empty tab is left out with a hint", () => {
  const { html, keyboard } = listView(browser(0, 3));
  const kb = rows(keyboard);
  assert.deepEqual(kb[0].map((x) => x.text), ["● Claude Code (3)"]);
  assert.ok(!kb.flat().some((x) => x.callback_data?.startsWith("sk:p:")));
  assert.match(html, /You have none of your own yet/);
});

test("button data stays within Telegram's 64 bytes, labels are short, names map to Telegram spelling", () => {
  const b = browser(0, 0);
  b.own = [skill("a-really-long-plugin-name:and-an-even-longer-skill-name-that-goes-on"), skill("Status")];
  b.tab = "own";
  const kb = rows(listView(b).keyboard).flat();
  assert.ok(kb.every((x) => Buffer.byteLength(x.callback_data ?? "") <= 64));
  const labels = kb.filter((x) => x.callback_data?.startsWith("sk:s:")).map((x) => x.text);
  assert.ok(labels.every((l) => l.length <= 20), labels.join(" | "));
  assert.ok(labels[0].startsWith("🧩 a-really-long"), "too long for a Telegram command: the original spelling");
  assert.equal(labels[1], "🧩 Status", "a name that would hit the bot's /status keeps its own spelling");
});

test("detailView: full description, source, and a copy button with the typed name", () => {
  const b = browser(0, 0);
  b.own = [skill("deploy-docs", false, "Publish the docs\nto an environment", "<env>")];
  b.bundled = [skill("code-review", true, "Review a change")];
  b.tab = "own";
  const view = detailView(b, 0)!;
  assert.match(view.html, /🧩 \/deploy_docs <i>&lt;env&gt;<\/i>/);
  assert.match(view.html, /Publish the docs\nto an environment/);
  assert.match(view.html, /<i>Yours<\/i>/);
  const [buttons] = rows(view.keyboard);
  assert.deepEqual(buttons[0], { text: "📋 Copy /deploy_docs", copy_text: { text: "/deploy_docs " } });
  assert.deepEqual(buttons[1], { text: "◀ Back", callback_data: "sk:b" });
  b.tab = "bundled";
  assert.match(detailView(b, 0)!.html, /<i>Claude Code skill<\/i>/);
  assert.equal(detailView(b, 5), undefined);
});

test("filterSkills: every word in the name or the description", () => {
  const list = [skill("stock-correlation", false, "Find correlated stocks"), skill("yfinance-data", false, "Stock prices"), skill("dataviz")];
  assert.deepEqual(filterSkills(list, "stock").map((s) => s.name), ["stock-correlation", "yfinance-data"]);
  assert.deepEqual(filterSkills(list, "STOCK prices").map((s) => s.name), ["yfinance-data"]);
  assert.deepEqual(filterSkills(list, "nothing"), []);
});

// ---- in the bot ----------------------------------------------------------------------

function skillsHarness() {
  const h = harness();
  h.factory.onCreate = (p) => {
    p.commands = [
      { name: "compact", description: "Free up context", argumentHint: "", builtin: true },
      ...Array.from({ length: 10 }, (_, i) => skill(`mine-${i}`, false, i === 3 ? "Stock tools" : `Mine ${i}`)),
      skill("code-review", true, "Review a change", "[path]"),
      skill("deploy-docs", false, "Publish the docs", "<env>"),
    ];
  };
  return h;
}

test("/skills browses in one message: pages, tabs, details, back", async () => {
  const h = skillsHarness();
  await h.send("/skills", { thread: 500 });
  const sent = h.messages.at(-1)!;
  assert.match(String(sent.payload.text), /11 yours · 1 Claude Code/);
  assert.match(String(sent.payload.text), /1\. \/deploy_docs <i>&lt;env&gt;<\/i> — Publish the docs/, "sorted by name");
  const first = keyboardOf(h.calls.at(-1));
  assert.equal(first.at(-1)!.map((x) => x.text).join(" "), "◀ 1/2 ▶");
  const edits = () => h.calls.filter((c) => c.method === "editMessageText");

  await h.press("sk:p:1", 500, sent.id);
  assert.match(String(edits().at(-1)!.payload.text), /9\. \/mine_7/, "page 2");
  await h.press("sk:t:bundled", 500, sent.id);
  assert.match(String(edits().at(-1)!.payload.text), /1\. \/code_review/);
  await h.press("sk:s:0", 500, sent.id);
  const detail = edits().at(-1)!;
  assert.match(String(detail.payload.text), /🧩 \/code_review <i>\[path\]<\/i>/);
  assert.deepEqual(keyboardOf(detail)[0][0], { text: "📋 Copy /code_review", copy_text: { text: "/code_review " } });
  await h.press("sk:b", 500, sent.id);
  assert.match(String(edits().at(-1)!.payload.text), /● Claude Code|1\. \/code_review/);
  assert.deepEqual(keyboardOf(edits().at(-1))[0].map((x) => x.text), ["Yours (11)", "● Claude Code (1)"], "back to the same tab");

  await h.press("sk:p:0", 500, 424242);
  const answer = h.calls.filter((c) => c.method === "answerCallbackQuery").at(-1)!;
  assert.match(String(answer.payload.text), /outdated/);
});

test("/skills <words> filters; a single match opens its details", async () => {
  const h = skillsHarness();
  await h.send("/skills mine", { thread: 600 });
  assert.match(String(h.messages.at(-1)!.payload.text), /🔎 Skills matching “mine” · 10/);
  assert.ok(!keyboardOf(h.calls.at(-1)).flat().some((x) => x.callback_data?.startsWith("sk:t:")), "no tabs in a filter");
  await h.send("/skills stock", { thread: 600 });
  assert.match(String(h.messages.at(-1)!.payload.text), /🧩 \/mine_3/);
  assert.match(String(h.messages.at(-1)!.payload.text), /Stock tools/);
  await h.send("/skills zzz", { thread: 600 });
  assert.match(String(h.messages.at(-1)!.payload.text), /No skill matches/);
});

test("skills seen in /skills run by their menu spelling", async () => {
  const h = skillsHarness();
  await h.send("hello", { thread: 700 });
  await waitFor(() => h.texts(h.inThread(700)).some((t) => t.includes("reply: hello")), 1000, "reply");
  await h.send("/skills", { thread: 700 });
  await h.send("/deploy_docs staging", { thread: 700 });
  await waitFor(() => h.factory.created[0].sent.length === 2, 1000, "skill sent");
  assert.equal(h.factory.created[0].sent[1], "/deploy-docs staging");
});
