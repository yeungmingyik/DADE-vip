import { memberNumberChanges, migrateMemberNumberSnapshot } from "../modules/member-numbers";
import type { DemoState } from "./domain";

export function migrateDemoState(state: DemoState): DemoState {
  const changes = memberNumberChanges(state.members);
  if (!changes.size) return state;
  return {
    ...state,
    revision: state.revision + 1,
    members: state.members.map((member) => {
      const change = changes.get(member.id);
      return change ? { ...member, number: change.next } : member;
    }),
    idempotency: Object.fromEntries(Object.entries(state.idempotency).map(([key, entry]) => [key, { ...entry, result: migrateMemberNumberSnapshot(entry.result, changes) }])),
  };
}
