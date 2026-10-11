import { and, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";

import { messages } from "./schema";

// Total order over messages: (createdAt, role order, id). The chat history
// cursor, the extraction cursor, and the extraction window boundary must all
// agree on this order byte-for-byte — a window is "after cursor AND through
// boundary" in exactly this ordering, so the conditions live here once.
export type MessageCursor = {
  id: string;
  role: string;
  createdAt: Date;
};

// The same total order, evaluated in JS over already-fetched rows. Canonical
// lowercase uuid text compares identically to Postgres uuid byte order.
export function compareMessageCursors(
  left: MessageCursor,
  right: MessageCursor,
): number {
  const timeDelta = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDelta !== 0) {
    return timeDelta;
  }
  const roleDelta =
    messageRoleOrder(left.role) - messageRoleOrder(right.role);
  if (roleDelta !== 0) {
    return roleDelta;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

export function messageRoleOrder(role: string): number {
  if (role === "user") {
    return 0;
  }
  if (role === "assistant") {
    return 1;
  }
  return 2;
}

export function messageRoleOrderSql(): SQL<number> {
  return sql<number>`
    case
      when ${messages.role} = 'user' then 0
      when ${messages.role} = 'assistant' then 1
      else 2
    end
  `;
}

export function afterMessageCondition(
  cursor?: MessageCursor,
): SQL | undefined {
  if (!cursor) {
    return undefined;
  }
  const roleOrder = messageRoleOrderSql();
  const cursorRoleOrder = messageRoleOrder(cursor.role);
  return or(
    gt(messages.createdAt, cursor.createdAt),
    and(
      eq(messages.createdAt, cursor.createdAt),
      gt(roleOrder, cursorRoleOrder),
    ),
    and(
      eq(messages.createdAt, cursor.createdAt),
      eq(roleOrder, cursorRoleOrder),
      gt(messages.id, cursor.id),
    ),
  );
}

export function throughMessageCondition(boundary: MessageCursor): SQL {
  const roleOrder = messageRoleOrderSql();
  const boundaryRoleOrder = messageRoleOrder(boundary.role);
  const condition = or(
    lt(messages.createdAt, boundary.createdAt),
    and(
      eq(messages.createdAt, boundary.createdAt),
      lt(roleOrder, boundaryRoleOrder),
    ),
    and(
      eq(messages.createdAt, boundary.createdAt),
      eq(roleOrder, boundaryRoleOrder),
      sql`${messages.id} <= ${boundary.id}`,
    ),
  );
  return condition as SQL;
}
