/**
 * The plugin's host for the video: the real one, with the script's seats as the Mirador profiles the setup offers, and
 * the scripted reviewers playing them (scripted-runner.ts). Whatever the agent passes, a review it opens seats the four
 * at Standard depth (three rounds, which the script's plot needs), so the take doesn't depend on how it words its call. capture.ts links a plugin folder whose host is this
 * into a throwaway Mirador; the plugin you install never loads it.
 */
import { systemClock } from "../../core/engine.ts";
import { createCouncilHost } from "../../hosts/mirador/host.ts";
import { miradorRecords } from "../../hosts/mirador/records.ts";
import { SEATS } from "./script.ts";
import { scriptedRunners } from "./scripted-runner.ts";

const real = miradorRecords();

const host = createCouncilHost({
  records: { profiles: () => SEATS.map(({ name, harness, model }) => ({ name, harness, model })), modelOf: (id) => real.modelOf(id), replyOf: () => null },
  runnerFor: scriptedRunners(systemClock),
});

const open = host.tools.council_open!;
host.tools.council_open = {
  ...open,
  run: (input, context) => {
    const { rounds: _rounds, maxFindings: _maxFindings, ...given } = input as Record<string, unknown>;
    return open.run({ ...given, depth: "standard", agents: SEATS.map(({ name }) => `profile:${name}`) }, context);
  },
};

export default host;
