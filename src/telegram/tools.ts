import { truncate } from "./format.ts";

const ICONS: Record<string, string> = {
  Bash: "💻",
  Read: "📖",
  Write: "✏️",
  Edit: "✏️",
  MultiEdit: "✏️",
  NotebookEdit: "✏️",
  Grep: "🔎",
  Glob: "🔎",
  WebFetch: "🌐",
  WebSearch: "🌐",
  Agent: "🤖",
  Task: "🤖",
  TodoWrite: "📝",
  Skill: "🧩",
};

export function toolIcon(name: string): string {
  return ICONS[name] ?? (name.startsWith("mcp__") ? "🔌" : "🔧");
}

/** One-line human summary of a tool call's input. */
export function toolSummary(name: string, input: Record<string, unknown>, limit = 200): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  let s: string | undefined;
  switch (name) {
    case "Bash":
      s = str("command");
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      s = str("file_path");
      break;
    case "NotebookEdit":
      s = str("notebook_path");
      break;
    case "Grep":
    case "Glob":
      s = [str("pattern"), str("path")].filter(Boolean).join(" in ");
      break;
    case "WebFetch":
      s = str("url");
      break;
    case "WebSearch":
      s = str("query");
      break;
    case "Agent":
    case "Task":
      s = str("description") ?? str("prompt");
      break;
    case "Skill":
      s = [str("skill"), str("args")].filter(Boolean).join(" ");
      break;
    case "TodoWrite":
      s = Array.isArray(input.todos) ? `${input.todos.length} items` : undefined;
      break;
  }
  if (!s) {
    const json = JSON.stringify(input);
    s = json === "{}" ? "" : json;
  }
  return truncate(s.replace(/\s+/g, " ").trim(), limit);
}

export function displayToolName(name: string): string {
  // mcp__server__tool -> server:tool
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]}:${m[2]}` : name;
}
