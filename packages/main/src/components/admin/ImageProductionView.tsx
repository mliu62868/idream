"use client";

// SPEC: 图片生产合一 —— 通用批量 (ProductionStudioView) + 为角色生成 (CharacterPregenPanel)
//       两 tab 同壳。为角色生成需先选角色 (复用 /content/characters)，选中即挂 CharacterPregenPanel。
// INTENT: 纯前端合并，不新增生成链路/接口；两子组件均维持原有自取数行为。
import { useEffect, useState } from "react";
import { apiGet } from "@/components/admin/api";
import { useAdminI18n } from "@/components/admin/i18n";
import { cn } from "@/lib/utils";
import { ProductionStudioView } from "@/components/admin/ContentOpsViews";
import { CharacterPregenPanel } from "@/components/admin/CharacterPregenPanel";

type ProductionTab = "batch" | "character";
type CharacterOption = { id: string; name: string };

export function ImageProductionView() {
  const { t } = useAdminI18n();
  const [tab, setTab] = useState<ProductionTab>("batch");
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");

  useEffect(() => {
    if (tab !== "character" || characters.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const payload = await apiGet<{ items: Array<Record<string, unknown>> }>(
          "/api/v1/admin/content/characters",
        );
        if (cancelled) return;
        const options = payload.items
          .map((row) => ({ id: String(row.id ?? ""), name: String(row.name ?? row.id ?? "") }))
          .filter((row) => row.id.length > 0);
        setCharacters(options);
        setSelectedId((current) => current || options[0]?.id || "");
      } catch {
        if (!cancelled) setCharacters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, characters.length]);

  return (
    <div className="space-y-5">
      <div className="flex gap-2 border-b border-white/10">
        <TabButton active={tab === "batch"} label={t("Batch production")} onClick={() => setTab("batch")} />
        <TabButton
          active={tab === "character"}
          label={t("Generate for character")}
          onClick={() => setTab("character")}
        />
      </div>

      {tab === "batch" ? (
        <ProductionStudioView />
      ) : (
        <div className="space-y-4">
          <label className="flex max-w-md flex-col gap-1 text-sm">
            <span className="text-[rgb(170,170,170)]">{t("Character")}</span>
            <select
              className="h-9 border border-white/10 bg-[rgb(18,18,18)] px-3 text-sm outline-none"
              onChange={(event) => setSelectedId(event.target.value)}
              value={selectedId}
            >
              {characters.length === 0 ? <option value="">{t("Loading…")}</option> : null}
              {characters.map((character) => (
                <option className="bg-[rgb(18,18,18)]" key={character.id} value={character.id}>
                  {character.name}
                </option>
              ))}
            </select>
          </label>
          {selectedId ? <CharacterPregenPanel characterId={selectedId} /> : null}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "h-9 border-b-2 px-3 text-sm font-medium transition-colors",
        active
          ? "border-white text-white"
          : "border-transparent text-[rgb(170,170,170)] hover:text-white",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
