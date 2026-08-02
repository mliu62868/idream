// SPEC: character-wide primitives shared by more than one Character subdomain file.
// INTENT: kept separate so the seven subdomain files never have to import each other
// just to reach an enum. Anything used by exactly one subdomain belongs in that file.

import { z } from "zod";

export const characterProjectPhaseSchema = z.enum([
  "idea",
  "planned",
  "producing",
  "qa",
  "launch_ready",
  "live_management",
  "retired",
]);

export const characterServingStateSchema = z.enum(["inactive", "live", "paused", "retired"]);
