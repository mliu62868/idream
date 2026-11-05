// @vitest-environment happy-dom

import type { AdminPermissionKey, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import * as transport from "@/lib/admin-v2-api";
import { CandidateDiscardAction } from "./CandidateDiscardAction";
import { CharacterDistributionCard } from "./CharacterDistributionCard";
import { CharacterHandoffAction, CharacterHandoffNotice } from "./CharacterHandoff";
import { createCharacterCommandJournal } from "./character-command-journal";
import { CharacterWorkspaceActionsProvider } from "./character-workspace-actions";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { characterWorkspacePermissions } from "./character-workspace-permissions";
import { ReleasePanel } from "./ReleasePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handoff = NonNullable<CharacterWorkspaceDetail["handoff"]>;

const handoff = (overrides: Partial<Handoff> = {}): Handoff => ({
  id: "handoff-1", characterId: "character-fixture", projectId: "project-fixture",
  contentVersionId: "content-fixture", visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null,
  selectableImageCount: 3, note: null, createdById: "creator-1", createdAt: "2026-07-30T11:30:00.000Z",
  createdByName: "Rin", drift: [], ...overrides,
});

const stamp = "2026-07-30T12:00:00.000Z";
const release = (overrides: Partial<CharacterWorkspaceDetail["releases"][number]["release"]>): CharacterWorkspaceDetail["releases"][number] => ({
  release: {
    id: "candidate", projectId: "project-fixture", revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
    visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
    snapshotHash: "snapshot", readiness: "ready", status: "approved", legacy: false, publishedAt: null, supersedesId: null, rollbackOfReleaseId: null,
    version: 4, createdAt: stamp, updatedAt: stamp, ...overrides,
  },
  checks: [],
  monitors: [],
});

describe("character workspace one-line actions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  }

  describe("creation handoff", () => {
    const mutation = () => vi.fn(async ({ commit }: { commit: () => Promise<unknown> }) => ({ result: await commit(), refreshed: true }));

    async function renderAction(data: CharacterWorkspaceDetail, run = mutation()) {
      await act(async () => root.render(
        <AdminI18nProvider locale="zh">
          <CharacterHandoffAction canWrite data={data} runCommittedMutation={run as never} />
        </AdminI18nProvider>,
      ));
    }

    // SPEC: 一键记录：请求里没有任何运营要填的东西。
    it("records with one click and an empty body", async () => {
      const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue(handoff());
      await renderAction(characterWorkspaceDetail());
      expect(request).not.toHaveBeenCalled();
      await act(async () => button("标记为可发布")!.click());
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "/api/v2/admin/characters/character-fixture/handoffs",
        expect.objectContaining({ method: "POST", body: {} }),
      );
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    });

    it("shows the record instead of the button while nothing has drifted, and offers it again after drift", async () => {
      await renderAction(characterWorkspaceDetail({ handoff: handoff() }));
      expect(button("标记为可发布")).toBeUndefined();
      expect(container.textContent).toContain("已于");
      await renderAction(characterWorkspaceDetail({ handoff: handoff({ drift: ["content"] }) }));
      expect(button("标记为可发布")).toBeDefined();
    });

    it("is not offered before the persona compiles, or on a retired Character", async () => {
      await renderAction(characterWorkspaceDetail({ soul: { valid: false } }));
      expect(button("标记为可发布")).toBeUndefined();
      await renderAction(characterWorkspaceDetail({ serving: { characterId: "character-fixture", state: "retired", currentReleaseId: null, version: 1, updatedAt: stamp } }));
      expect(button("标记为可发布")).toBeUndefined();
    });

    async function renderPanel(data: CharacterWorkspaceDetail) {
      await act(async () => root.render(
        <AdminI18nProvider locale="zh">
          <ReleasePanel
            data={data}
            journal={createCharacterCommandJournal({ actorId: "release-operator", characterId: data.character.id, storage: null })}
            permissions={characterWorkspacePermissions(new Set<AdminPermissionKey>(["character.release.publish"]), false)}
            runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
            writesLocked={false}
          />
        </AdminI18nProvider>,
      ));
    }

    it("tells the publisher who marked it and what changed since, on top of the Release panel", async () => {
      await renderPanel(characterWorkspaceDetail({ handoff: handoff({ drift: ["content", "reference_set"] }) }));
      const notice = container.querySelector('[data-testid="character-handoff-notice"]');
      expect(notice?.textContent).toContain("Rin");
      expect(notice?.textContent).toContain("30分钟前");
      expect(notice?.textContent).toContain("之后有 2 处改动");
      expect(notice?.textContent).toContain("角色内容");
    });

    it("stops describing a handoff once something was published after it", async () => {
      await act(async () => root.render(
        <AdminI18nProvider locale="zh">
          <CharacterHandoffNotice data={characterWorkspaceDetail({
            handoff: handoff(),
            releases: [release({ id: "later", status: "published", publishedAt: "2026-07-30T11:45:00.000Z" })],
          })} />
        </AdminI18nProvider>,
      ));
      expect(container.querySelector('[data-testid="character-handoff-notice"]')).toBeNull();
    });

    // SPEC: 没有交接照样能发布，不出现警告；有漂移的交接也不改变发布按钮。
    it.each([
      ["without a handoff", null],
      ["with a drifted handoff", handoff({ drift: ["content", "visual_identity", "reference_set"] })],
    ] as const)("leaves Publish identical %s", async (_label, value) => {
      await renderPanel(characterWorkspaceDetail({
        handoff: value,
        releases: [release({})],
      }));
      const publish = button("发布角色")!;
      expect(publish.disabled).toBe(false);
      expect(container.querySelector('[data-testid="release-blockers"]')).toBeNull();
    });
  });

  describe("candidate discard", () => {
    async function render(granted: AdminPermissionKey[], data = characterWorkspaceDetail({ releases: [release({})] })) {
      const journal = createCharacterCommandJournal({ actorId: "operator", characterId: data.character.id, storage: null });
      await act(async () => root.render(
        <AdminI18nProvider locale="zh">
          <CharacterWorkspaceActionsProvider
            journal={journal}
            permissions={characterWorkspacePermissions(new Set(granted), false)}
            runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
            writesLocked={false}
          >
            <CandidateDiscardAction data={data} />
          </CharacterWorkspaceActionsProvider>
        </AdminI18nProvider>,
      ));
      return journal;
    }

    it("withdraws in place through the durable command, without leaving the tab", async () => {
      const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "withdraw-command" });
      const journal = await render(["character.release.publish"]);
      await act(async () => button("放弃候选并继续编辑")!.click());
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        "/api/v2/admin/characters/character-fixture/releases/candidate/commands/withdraw",
        expect.objectContaining({ body: expect.objectContaining({ entityVersion: 4, confirmation: "character-fixture:candidate:withdraw" }) }),
      );
      expect(journal.getSnapshot().command?.commandId).toBe("withdraw-command");
      expect(journal.getSnapshot().writesLocked).toBe(true);
    });

    it("renders nothing without publish permission, without a candidate, or outside the workspace", async () => {
      await render(["character.project.write"]);
      expect(button("放弃候选并继续编辑")).toBeUndefined();
      await render(["character.release.publish"], characterWorkspaceDetail({ releases: [] }));
      expect(button("放弃候选并继续编辑")).toBeUndefined();
      await act(async () => root.render(
        <AdminI18nProvider locale="zh">
          <CandidateDiscardAction data={characterWorkspaceDetail({ releases: [release({})] })} />
        </AdminI18nProvider>,
      ));
      expect(button("放弃候选并继续编辑")).toBeUndefined();
    });
  });

  describe("distribution card", () => {
    const featuredBody = (ids: string[], version: number) => ({
      items: ids.map((id, configuredPosition) => ({
        id, name: id, visibility: "public", status: "approved", thumbnailUrl: null, configuredPosition, configured: true,
        effective: id !== "character-fixture",
        blockers: id === "character-fixture" ? [{ code: "serving_not_live", message: "Character Serving is not live.", repairDeepLink: "/admin/characters/character-fixture?tab=release" }] : [],
      })),
      characterIds: ids, configuredCharacterIds: ids, effectiveCharacterIds: ids.filter((id) => id !== "character-fixture"),
      settingVersion: version, settingDiagnostics: [],
    });

    async function render(granted: AdminPermissionKey[]) {
      const data = characterWorkspaceDetail();
      await act(async () => root.render(
        <AdminI18nProvider locale="zh">
          <CharacterWorkspaceActionsProvider
            journal={createCharacterCommandJournal({ actorId: "operator", characterId: data.character.id, storage: null })}
            permissions={characterWorkspacePermissions(new Set(granted), false)}
            runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
            writesLocked={false}
          >
            <CharacterDistributionCard data={data} />
          </CharacterWorkspaceActionsProvider>
        </AdminI18nProvider>,
      ));
    }

    it("sends no request and renders nothing without content.read", async () => {
      const request = vi.spyOn(transport, "adminV2Request");
      await render(["character.project.read"]);
      expect(container.querySelector('[data-testid="character-distribution-card"]')).toBeNull();
      expect(request).not.toHaveBeenCalled();
    });

    // SPEC: 一键加入：保留其他角色的顺序，带读到的版本，无需填写任何东西。
    it("adds a Character at the end in one click, then shows its position and live state", async () => {
      let ids = ["other"];
      const request = vi.spyOn(transport, "adminV2Request").mockImplementation(async (path, init) => {
        if (String(path).includes("/content/placements")) {
          return { items: [{ id: "placement-1", slot: "home_hero", status: "published" }], pageInfo: { endCursor: null, hasNextPage: false } };
        }
        if (init?.method === "PUT") {
          ids = (init.body as { characterIds: string[] }).characterIds;
          return {};
        }
        return featuredBody(ids, ids.length);
      });
      await render(["content.read", "content.placement.write", "creative.placement.read"]);
      expect(container.textContent).toContain("未加入精选");
      expect(container.textContent).toContain("home hero");
      await act(async () => button("加入精选")!.click());
      const put = request.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(put?.[1]?.body).toEqual({ characterIds: ["other", "character-fixture"], expectedVersion: 1, reason: "Update Featured (+1, -0)" });
      expect(container.textContent).toContain("精选 · 第 2 位");
      expect(container.textContent).toContain("已配置 · 未上线");
      expect(container.querySelector('a[href="/admin/characters/character-fixture?tab=release"]')).not.toBeNull();
      expect(button("移出精选")).toBeDefined();
    });

    it("reloads instead of overwriting when another operator saved first", async () => {
      let version = 1;
      const request = vi.spyOn(transport, "adminV2Request").mockImplementation(async (_path, init) => {
        if (init?.method === "PUT") {
          version = 2;
          throw new transport.AdminV2RequestError("conflict", 409, "conflict", {
            reason: "featured_setting_version_conflict", settingVersion: 2, configuredCharacterIds: ["newer"],
          });
        }
        return featuredBody(version === 1 ? [] : ["newer"], version);
      });
      await render(["content.read", "content.placement.write"]);
      await act(async () => button("加入精选")!.click());
      expect(request.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("请再点一次");
      await act(async () => button("加入精选")!.click());
      const puts = request.mock.calls.filter(([, init]) => init?.method === "PUT");
      expect(puts[1]?.[1]?.body).toMatchObject({ characterIds: ["newer", "character-fixture"], expectedVersion: 2 });
    });

    it("keeps the toggle read-only without content.placement.write", async () => {
      vi.spyOn(transport, "adminV2Request").mockResolvedValue(featuredBody([], 0));
      await render(["content.read"]);
      expect(button("加入精选")?.disabled).toBe(true);
    });
  });
});
