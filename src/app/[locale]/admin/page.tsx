import { notFound, redirect } from "next/navigation";
import { appSurface } from "@/server/surface";
import { requireRole } from "@/server/session";
import { AdminApp } from "@/components/admin/admin-app";
import { Suspense } from "react";

export default async function AdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (appSurface() !== "admin") notFound();
  if (!await requireRole("admin")) redirect(`/${locale}/login`);
  return <Suspense><AdminApp /></Suspense>;
}
