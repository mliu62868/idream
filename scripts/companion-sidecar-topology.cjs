function resolveCompanionSidecarEnabled(shellValue, chatEnvValue) {
  const effective = (shellValue ?? chatEnvValue ?? "0").trim();
  if (effective !== "0" && effective !== "1") {
    throw new Error("DSH_AGENT_ENABLED must be 0 or 1");
  }
  return effective === "1";
}

module.exports = { resolveCompanionSidecarEnabled };
