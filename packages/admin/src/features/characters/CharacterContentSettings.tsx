"use client";

import { useAdminI18n } from "@/components/admin/i18n";
import { CharacterChatToolsPanel } from "./CharacterChatToolsPanel";
import { CharacterTagsPanel } from "./CharacterTagsPanel";

// SPEC: 标签与聊天工具是角色「设定」的一部分，挂在人设 tab 的独立小节里。
// INTENT: 它们曾藏在概览里，运营找不到；单开一个 tab 又让导航多一格。放在人设表单之后、
//         独立成节并写明「单独保存」，因为它们不进草稿、不随 Release 发布，人设的保存按钮管不到它们。
export function CharacterContentSettings({
  canManageChatTools,
  canReadContent,
  canWriteTags,
  characterId,
}: {
  canManageChatTools: boolean;
  canReadContent: boolean;
  canWriteTags: boolean;
  characterId: string;
}) {
  const { t } = useAdminI18n();
  return (
    <section
      aria-labelledby="character-content-settings-title"
      className="rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)] p-5"
      id="character-content-settings"
    >
      <h3 className="text-lg font-semibold" id="character-content-settings-title">
        {t("Tags and chat tools")}
      </h3>
      <p className="mt-1 text-sm text-[var(--ad-text-muted)]">
        {t("Each setting saves on its own. It is not part of the persona draft or a Release.")}
      </p>
      {/* SPEC: 角色读取权限不含内容读取；缺少 content.read 时不发出必定被拒绝的请求。 */}
      {canReadContent ? (
        <>
          <CharacterTagsPanel canWrite={canWriteTags} characterId={characterId} />
          <CharacterChatToolsPanel canWrite={canManageChatTools} characterId={characterId} />
        </>
      ) : (
        <p className="mt-4 text-xs text-[var(--ad-text-muted)]" role="status">
          {t("Your effective grants do not include")} <code>{"content.read"}</code>
        </p>
      )}
    </section>
  );
}
