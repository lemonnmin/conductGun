import type { AgentPlugin } from "@conductgun/core";
import { ALL_PLUGINS } from "./plugins.js";
import { formatAgentLine } from "./format.js";
import type { CommandIo } from "./commands.js";

const consoleIo: CommandIo = { print: (line) => console.log(line) };

export async function agentsCommand(
  io: CommandIo = consoleIo,
  plugins: AgentPlugin[] = ALL_PLUGINS,
): Promise<number> {
  for (const plugin of plugins) {
    let health: { ok: boolean; detail?: string };
    try {
      health = await plugin.healthCheck();
    } catch (err) {
      health = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    io.print(formatAgentLine(plugin.card, health));
  }
  return 0;
}