import z from "@deepseek-ai/schemastery";
import * as path from "node:path";
import * as os from "node:os";
import { NovelEngine } from "./engine.js";
import { Library } from "./library.js";
import { registerWritingTools } from "./tools.js";

const name = "tool-writing";
const inject = ["tools", "systemPrompt"];

const Config = z.object({
  apiKeyEnv: z.string().default("DSH_WRITING_API_KEY"),
  apiKey: z.string().default(""),
  baseURL: z.string().default("https://api.deepseek.com"),
  model: z.string().default("deepseek-v4-flash"),
  deepModel: z.string().default("deepseek-v4-pro"),
  maxConcurrency: z.number().default(4),
  maxTokens: z.number().default(4096),
  temperature: z.number().default(0.8),
  timeoutMs: z.number().default(180000),
  projectRoot: z.string().default("."),
  libraryRoot: z.string().default(""),
  embedBackend: z.string().default("deepseek"), // 语义检索后端：deepseek（概念索引，优先）| dashscope（百炼稠密向量）| auto（百炼优先、失败降级概念索引）
  embedBaseURL: z.string().default(""),
  embedModel: z.string().default(""),
  embedApiKey: z.string().default("")
});

function resolveLibraryRoot(config) {
  if (config.libraryRoot && config.libraryRoot.length > 0) return config.libraryRoot;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "writing-library");
}

function apply(ctx, config) {
  const resolved = config || {};
  const engine = new NovelEngine(resolved, ctx.get("credentials"));
  const library = new Library(resolveLibraryRoot(resolved), { config: resolved, credentials: ctx.get("credentials"), engine: engine });
  ctx.systemPrompt.section({
    name: "tool:writing",
    order: 120,
    text: "You are operating a web-novel writing engine (dsh-tool-writing). Use the novel_* tools to orchestrate long-form fiction: novel_init to set up a project; novel_outline for outlines; novel_lore for characters/world/timeline/foreshadowing; novel_brainstorm for ideas; novel_draft for one chapter; novel_batch for parallel drafting; novel_polish to rewrite; novel_review for consistency; novel_research for research; novel_library_import/list/read/delete/search to manage the corpus library (饲料区); novel_search for full-text search across project and library. Use novel_embed to build semantic vector indexes (needed for meaning-based recall); novel_vsearch for raw vector hits with similarity scores; novel_semantic combines vector + literal recall with LLM reranking. Drafted chapters are written to files — use read rather than re-printing long text."
  });
  registerWritingTools(ctx, engine, library);
}

export { name, inject, Config, apply };
