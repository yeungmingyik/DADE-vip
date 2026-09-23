export interface MemberNumberChange {
  previous: string;
  next: string;
}

function highestMemberSequence(numbers: Iterable<string>): bigint {
  let highest = 10000n;
  for (const number of numbers) {
    const match = /^(?:DADE|SSPC) ([0-9]+)$/.exec(number);
    if (match) {
      const sequence = BigInt(match[1]);
      if (sequence > highest) highest = sequence;
    }
  }
  return highest;
}

export function nextMemberNumber(numbers: Iterable<string>): string {
  return `DADE ${highestMemberSequence(numbers) + 1n}`;
}

export function memberNumberChanges(members: readonly { id: string; number: string }[]): Map<string, MemberNumberChange> {
  const changes = new Map<string, MemberNumberChange>();
  const legacy = members.filter((member) => /^SSPC [0-9]+$/.test(member.number));
  if (!legacy.length) return changes;
  const occupied = new Set(members.map((member) => member.number));
  let sequence = highestMemberSequence(occupied);
  for (const member of legacy.sort((a, b) => a.id.localeCompare(b.id))) {
    const match = /^SSPC ([0-9]+)$/.exec(member.number);
    if (!match) continue;
    let next = `DADE ${match[1]}`;
    if (occupied.has(next)) next = `DADE ${++sequence}`;
    occupied.add(next);
    changes.set(member.id, { previous: member.number, next });
  }
  return changes;
}

export function migrateMemberNumberSnapshot<T extends { member?: { id: string; number: string } }>(result: T, changes: ReadonlyMap<string, MemberNumberChange>): T {
  const member = result.member;
  const change = member && changes.get(member.id);
  if (!member || !change || member.number !== change.previous) return result;
  return { ...result, member: { ...member, number: change.next } };
}
