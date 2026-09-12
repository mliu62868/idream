"use client";

import type { GroupChatMember } from "@idream/shared/contracts";

export function mentionedGroupCharacter(content: string, members: readonly GroupChatMember[]): string | null {
  const text = content.trimStart().toLocaleLowerCase();
  const matches = members.filter(member => {
    const mention = `@${member.name.toLocaleLowerCase()}`;
    return text === mention || text.startsWith(`${mention} `) || text.startsWith(`${mention},`) || text.startsWith(`${mention}:`);
  });
  return matches.length === 1 ? matches[0].characterId : null;
}

export function GroupSpeakerControls({ members, selectedCharacterId, disabled, onSelect }: Readonly<{
  members: readonly GroupChatMember[];
  selectedCharacterId: string | null;
  disabled: boolean;
  onSelect: (characterId: string) => void;
}>) {
  return <div className="mt-4 rounded-xl border border-white/15 p-4">
    <label className="flex flex-wrap items-center gap-3 text-sm font-bold">
      Reply as
      <select aria-label="Group speaker" className="min-h-11 max-w-full rounded-lg bg-[rgb(36,36,36)] px-3 text-white disabled:opacity-50"
        value={selectedCharacterId ?? ""} disabled={disabled} onChange={event => onSelect(event.target.value)}>
        {members.map((member, index) => <option key={member.characterId} value={member.characterId}>{member.name} · {index + 1}</option>)}
      </select>
    </label>
    <p className="mt-2 text-xs leading-5 text-white/65">One Character replies to each message. Start with @Name to choose a speaker. Memory and conversation preferences below apply to the selected Character.</p>
  </div>;
}
