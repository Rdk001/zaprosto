import { createHash } from "node:crypto";
import type { Prisma } from "../../../generated/prisma/client";
import {
  catalogIssues,
  moveCatalogSchema,
  saveMasterSchema,
  saveServiceSchema,
  type CatalogFailure,
} from "../domain/admin-input";

const orderBy = [{ displayOrder: "asc" as const }, { id: "asc" as const }];
const serviceSelect = {
  id: true,
  name: true,
  priceKopecks: true,
  durationMinutes: true,
  isActive: true,
  displayOrder: true,
  version: true,
} as const;
const masterSelect = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  displayOrder: true,
  version: true,
  services: { orderBy: { serviceId: "asc" as const }, select: { serviceId: true } },
} as const;
function orderVersion(rows: Array<{ id: string; version: number; displayOrder: number }>) {
  return createHash("sha256")
    .update(
      JSON.stringify(rows.map(({ id, version, displayOrder }) => [id, version, displayOrder])),
    )
    .digest("hex");
}
export async function readAdminCatalog(tx: Prisma.TransactionClient) {
  const services = await tx.service.findMany({ select: serviceSelect, orderBy });
  const masters = await tx.master.findMany({ select: masterSelect, orderBy });
  return {
    services,
    masters,
    serviceOrderVersion: orderVersion(services),
    masterOrderVersion: orderVersion(masters),
  };
}
export type AdminCatalog = Awaited<ReturnType<typeof readAdminCatalog>>;
export type CatalogMutationResult = { ok: true; id: string } | CatalogFailure;

// Called only inside the administrative transaction, after its write lock and session check.
export async function saveService(
  tx: Prisma.TransactionClient,
  raw: unknown,
): Promise<CatalogMutationResult> {
  const parsed = saveServiceSchema.safeParse(raw);
  if (!parsed.success) return catalogIssues(parsed.error);
  const input = parsed.data;
  const old = input.target ? await tx.service.findUnique({ where: { id: input.target.id } }) : null;
  if (input.target && !old) return { ok: false, code: "NOT_FOUND" };
  if (old && old.version !== input.target!.version) return { ok: false, code: "CONFLICT" };
  if (old?.isActive && !input.isActive && !input.confirmDeactivation)
    return { ok: false, code: "CONFIRM_REQUIRED" };
  const data = {
    name: input.name,
    priceKopecks: input.priceRubles,
    durationMinutes: input.durationMinutes,
    isActive: input.isActive,
  };
  if (old) {
    await tx.service.update({
      where: { id: old.id },
      data: { ...data, version: { increment: 1 } },
    });
    return { ok: true, id: old.id };
  }
  const last = await tx.service.aggregate({ _max: { displayOrder: true } });
  const row = await tx.service.create({
    data: { ...data, displayOrder: (last._max.displayOrder ?? -1) + 1 },
  });
  return { ok: true, id: row.id };
}
export async function saveMaster(
  tx: Prisma.TransactionClient,
  raw: unknown,
): Promise<CatalogMutationResult> {
  const parsed = saveMasterSchema.safeParse(raw);
  if (!parsed.success) return catalogIssues(parsed.error);
  const input = parsed.data;
  const old = input.target ? await tx.master.findUnique({ where: { id: input.target.id } }) : null;
  if (input.target && !old) return { ok: false, code: "NOT_FOUND" };
  if (old && old.version !== input.target!.version) return { ok: false, code: "CONFLICT" };
  if (old?.isActive && !input.isActive && !input.confirmDeactivation)
    return { ok: false, code: "CONFIRM_REQUIRED" };
  // Validate the ENTIRE assignment set before any writes, including inactive services.
  if (
    (await tx.service.count({ where: { id: { in: input.serviceIds } } })) !==
    input.serviceIds.length
  )
    return {
      ok: false,
      code: "NOT_FOUND",
      fields: { serviceIds: "Одна из услуг больше не существует. Проверьте актуальный список." },
    };
  const data = {
    name: input.name,
    description: input.description || null,
    isActive: input.isActive,
  };
  let id: string;
  if (old) {
    id = old.id;
    // photoMediaId and all schedules are intentionally absent.
    await tx.master.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  } else {
    const last = await tx.master.aggregate({ _max: { displayOrder: true } });
    id = (
      await tx.master.create({
        data: { ...data, displayOrder: (last._max.displayOrder ?? -1) + 1 },
      })
    ).id;
  }
  await tx.masterService.deleteMany({
    where: { masterId: id, serviceId: { notIn: input.serviceIds } },
  });
  await tx.masterService.createMany({
    data: input.serviceIds.map((serviceId) => ({ masterId: id, serviceId })),
    skipDuplicates: true,
  });
  return { ok: true, id };
}
export async function moveCatalog(
  tx: Prisma.TransactionClient,
  raw: unknown,
): Promise<CatalogMutationResult> {
  const parsed = moveCatalogSchema.safeParse(raw);
  if (!parsed.success) return catalogIssues(parsed.error);
  const { kind, id, direction, orderVersion: expected } = parsed.data;
  const select = { id: true, version: true, displayOrder: true };
  const rows =
    kind === "services"
      ? await tx.service.findMany({ select, orderBy })
      : await tx.master.findMany({ select, orderBy });
  if (orderVersion(rows) !== expected) return { ok: false, code: "CONFLICT" };
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return { ok: false, code: "NOT_FOUND" };
  const next = index + (direction === "up" ? -1 : 1);
  if (next < 0 || next >= rows.length) return { ok: false, code: "INVALID_INPUT" };
  [rows[index], rows[next]] = [rows[next], rows[index]];
  // Normalize ties/gaps too, in one transaction. No transient partial order is visible.
  for (const [displayOrder, row] of rows.entries()) {
    if (row.displayOrder === displayOrder) continue;
    const data = { displayOrder, version: { increment: 1 } };
    if (kind === "services") await tx.service.update({ where: { id: row.id }, data });
    else await tx.master.update({ where: { id: row.id }, data });
  }
  return { ok: true, id };
}
