import type { AgentPlugin } from "@conductgun/core";
import { echoPlugin } from "@conductgun/agent-echo";
import { claudePlugin } from "@conductgun/agent-claude";
import { codexPlugin } from "@conductgun/agent-codex";
import { geminiPlugin } from "@conductgun/agent-gemini";

export const ALL_PLUGINS: AgentPlugin[] = [echoPlugin, claudePlugin, codexPlugin, geminiPlugin];