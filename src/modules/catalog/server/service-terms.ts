import { createHash } from "node:crypto";

type ServiceTerms = {
  id: string;
  name: string;
  priceKopecks: number;
  durationMinutes: number;
};

/** Fingerprint exactly the public terms; ordering/admin edits alone do not change it. */
export function publicServiceTerms(service: ServiceTerms) {
  const { id, name, priceKopecks, durationMinutes } = service;
  const termsHash = createHash("sha256")
    .update(JSON.stringify(["service-terms-v1", id, name, priceKopecks, durationMinutes]))
    .digest("hex");
  return { id, name, priceKopecks, durationMinutes, termsHash };
}
export type PublicServiceTerms = ReturnType<typeof publicServiceTerms>;
