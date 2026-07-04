import { Mastra } from "@mastra/core";
import { mentorJuristeAgent } from "./agents/mentor-juriste/index.js";
import { mentorParlementAgent } from "./agents/mentor-parlement/index.js";
import { naiaAgent } from "./agents/naia/index.js";

export const mastra = new Mastra({
  agents: {
    naia: naiaAgent,
    "mentor-juriste": mentorJuristeAgent,
    "mentor-parlement": mentorParlementAgent,
  },
});
