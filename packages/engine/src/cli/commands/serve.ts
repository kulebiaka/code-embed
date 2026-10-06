import { createLocalEngine } from "../../engine/service";
import { serveStdio } from "../../server/serve";
import { EXIT, type CommandRun } from "../types";

export const run: CommandRun = async () => {
  await serveStdio({
    createEngine: (init) =>
      createLocalEngine({
        root: init.root,
        clientName: init.clientName,
        settings: init.settings,
        apiKeys: init.apiKeys,
        watch: true,
        vectorPhase: true,
      }),
  });
  return EXIT.OK;
};
