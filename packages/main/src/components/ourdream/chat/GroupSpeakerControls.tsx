"use client";

import type { GroupChatMember } from "@idream/shared/contracts";

/**
 * SPEC: 开头的 `@名字` 指定这一轮由谁回答；认不出来就返回 null，由调用方保持原说话人。
 *
 * INTENT: 原本只认完整角色名。而角色名常常很长（"Bailey Price: One Safe Night"），
 *   真实用户打的是 `@Bailey` —— 匹配不上，于是这句话连同那个 @ 一起发给了当前说话人，
 *   没有任何提示。现在接受**无歧义的前缀**：`@Bailey` 命中唯一的 Bailey；两个 B 开头的
 *   成员则仍然返回 null，宁可不切换也不猜错人。
 */
export function mentionedGroupCharacter(content: string, members: readonly GroupChatMember[]): string | null {
  const text = content.trimStart().toLocaleLowerCase();
  if (!text.startsWith("@")) return null;
  const exact = members.filter(member => {
    const mention = `@${member.name.toLocaleLowerCase()}`;
    return text === mention || text.startsWith(`${mention} `) || text.startsWith(`${mention},`) || text.startsWith(`${mention}:`);
  });
  // 一个成员的完整名字可能是另一个的前缀（Mira / Mira Vale），取最具体的那个。
  if (exact.length > 0) {
    const longest = exact.reduce((best, member) =>
      member.name.length > best.name.length ? member : best,
    );
    const tied = exact.filter(member => member.name.length === longest.name.length);
    return tied.length === 1 ? longest.characterId : null;
  }

  const typed = text.slice(1).split(/[\s,:]/u)[0] ?? "";
  if (!typed) return null;
  const prefixed = members.filter(member =>
    member.name.toLocaleLowerCase().startsWith(typed),
  );
  return prefixed.length === 1 ? prefixed[0].characterId : null;
}

export function GroupSpeakerControls({ members, selectedCharacterId, disabled, onSelect }: Readonly<{
  members: readonly GroupChatMember[];
  selectedCharacterId: string | null;
  disabled: boolean;
  onSelect: (characterId: string) => void;
}>) {
  return <div className="mt-4 rounded-xl border border-white/15 p-4">
    <label className="flex flex-wrap items-center gap-3 text-sm font-bold">
      Next reply from
      <select aria-label="Group speaker" className="min-h-11 max-w-full rounded-lg bg-[rgb(36,36,36)] px-3 text-white disabled:opacity-50"
        value={selectedCharacterId ?? ""} disabled={disabled} onChange={event => onSelect(event.target.value)}>
        {members.map(member => <option key={member.characterId} value={member.characterId}>{member.name}</option>)}
      </select>
    </label>
    <p className="mt-2 text-xs leading-5 text-white/65">One Character replies to each message. Start with @Name to choose a speaker. Memory and conversation preferences below apply to the selected Character.</p>
  </div>;
}
