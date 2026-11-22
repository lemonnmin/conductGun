import { runHeadless, type Spawner } from "./spawn.js";

export async function probeBinary(command: string, spawner: Spawner): Promise<boolean> {
  const outcome = await runHeadless({
    command: "which",
    args: [command],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    spawner,
  });
  return outcome.ok && outcome.spawnError === undefined;
}