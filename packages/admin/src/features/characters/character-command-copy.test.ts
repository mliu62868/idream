import { describe, expect, it } from "vitest";
import type { adminV2Request } from "@/lib/admin-v2-api";
import { translateAdmin, hasAdminZh } from "@/components/admin/i18n-dictionary";
import { characterCommandMessage, renderCharacterCommandMessage } from "./character-command-copy";
import { committedCharacterProjectionWarning, createCharacterCommandJournal } from "./character-command-journal";
import { characterWorkspaceLoadError } from "./CharacterWorkspace";

const zh = (key: string, values?: Parameters<typeof translateAdmin>[2]) => translateAdmin("zh", key, values);
const en = (key: string, values?: Parameters<typeof translateAdmin>[2]) => translateAdmin("en", key, values);

describe("character notices retain translation intent until render", () => {
  it("translates the committed warning and action while preserving raw authority evidence", () => {
    const message = committedCharacterProjectionWarning("Release publish", new Error("upstream 503"));
    expect(renderCharacterCommandMessage(message, zh)).toBe("发布版本已生效，但角色工作台的权威数据未能刷新: upstream 503。请先刷新权威数据，再进行下一次写入。");
    expect(renderCharacterCommandMessage(message, en)).toContain("Release publish was committed");
  });
  it("renders journal notices in the current locale without replacing the journal or unlocking writes", async () => {
    const request: typeof adminV2Request = async (_path, options) => {
      if (!options?.schema) throw new Error("Expected a response contract");
      return options.schema.parse({ status: "accepted", requestId: "request-1", commandId: "command-1", verificationDeepLink: "/admin/system/audit?commandId=command-1" });
    };
    const journal = createCharacterCommandJournal({ actorId: "operator", characterId: "character", storage: null, request });
    await journal.submit({ action: "Release publish", signature: "publish", endpoint: "/publish", body: {} });
    const message = journal.getSnapshot().notice!.message;
    expect(renderCharacterCommandMessage(message, zh)).toContain("发布版本命令正在处理");
    expect(renderCharacterCommandMessage(message, en)).toContain("Release publish command is pending");
    expect(journal.getSnapshot().writesLocked).toBe(true);
  });
  it("translates validation failures and dynamic acceptance warnings", () => {
    expect(zh(characterWorkspaceLoadError(new Error("Validation failed: legacy")))).toContain("旧版运营证据");
    const key = "{action} acceptance is unknown. The same command will be replayed safely.";
    expect(hasAdminZh(key)).toBe(true);
    expect(renderCharacterCommandMessage(characterCommandMessage(key, { action: "Release publish" }), zh)).toBe("发布版本受理状态不明确。将安全重放同一命令。");
  });
});
