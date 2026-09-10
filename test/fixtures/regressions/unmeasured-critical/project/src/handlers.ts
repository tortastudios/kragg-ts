/** Three handlers, so `recordAudit` reaches the fan-in threshold. */

import { recordAudit } from "./audit.ts";

export function handleCreate(actor: string): string {
  return recordAudit(actor, "create");
}

export function handleUpdate(actor: string): string {
  return recordAudit(actor, "update");
}

export function handleDelete(actor: string): string {
  return recordAudit(actor, "delete");
}
