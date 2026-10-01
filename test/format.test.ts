import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToTelegramHtml, splitMarkdown, tail } from "../src/telegram/format.ts";

test("escapes HTML in text, code spans and code blocks", () => {
  const html = markdownToTelegramHtml("a <b> & `x<y>&` done\n\n```ts\nif (a<b && c) {}\n```");
  assert.equal(
    html,
    'a &lt;b&gt; &amp; <code>x&lt;y&gt;&amp;</code> done\n\n<pre><code class="language-ts">if (a&lt;b &amp;&amp; c) {}</code></pre>',
  );
});

test("renders inline styles, headings and links", () => {
  const html = markdownToTelegramHtml("# Title\n\n**bold** *it* ~~del~~ [x](https://e.com/?a=1&b=\"2\")");
  assert.equal(
    html,
    '<b>Title</b>\n\n<b>bold</b> <i>it</i> <s>del</s> <a href="https://e.com/?a=1&amp;b=&quot;2&quot;">x</a>',
  );
});

test("drops non-http link targets but keeps the label", () => {
  assert.equal(markdownToTelegramHtml("[file](./src/a.ts)"), "file");
});

test("renders nested and task lists", () => {
  const html = markdownToTelegramHtml("- one\n  - two\n- [x] done\n\n3. c\n4. d");
  assert.equal(html, "• one\n  • two\n☑ done\n\n3. c\n4. d");
  assert.equal(markdownToTelegramHtml("- [ ] a\n\n- [x] b"), "☐ a\n☑ b");
});

test("renders tables as aligned preformatted text", () => {
  const html = markdownToTelegramHtml("| a | bb |\n|---|---|\n| 中文 | 1 |");
  assert.equal(html, "<pre>a    │ bb\n─────┼───\n中文 │ 1</pre>");
});

test("renders blockquotes", () => {
  assert.equal(markdownToTelegramHtml("> hi **there**"), "<blockquote>hi <b>there</b></blockquote>");
});

test("splitMarkdown keeps chunks under the limit", () => {
  const md = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const chunks = splitMarkdown(md, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500, `chunk too long: ${c.length}`);
  assert.equal(chunks.join("\n"), md);
});

test("splitMarkdown closes and reopens code fences across chunks", () => {
  const code = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
  const md = `intro\n\n\`\`\`js\n${code}\n\`\`\`\n\nouter`;
  const chunks = splitMarkdown(md, 300);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    const fences = c.split("\n").filter((l) => l.startsWith("```")).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk:\n${c}`);
  }
  assert.ok(chunks[1].startsWith("```js"));
});

test("splitMarkdown hard-wraps a single huge line", () => {
  const chunks = splitMarkdown("y".repeat(2000), 300);
  for (const c of chunks) assert.ok(c.length <= 300);
  assert.equal(chunks.join(""), "y".repeat(2000));
});

test("tail keeps the end of long text", () => {
  assert.equal(tail("short", 100), "short");
  const t = tail("aaa\nbbb\nccc", 6);
  assert.ok(t.startsWith("…") && t.endsWith("ccc"));
});
