import type { Metadata } from "next";
import { CatalogPage } from "../../../components/admin/catalog-page";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Услуги — Запросто",
  robots: { index: false, follow: false },
};
export default function ServicesPage() {
  return <CatalogPage kind="services" />;
}
