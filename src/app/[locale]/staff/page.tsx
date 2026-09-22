import { notFound, redirect } from "next/navigation";
import { appSurface } from "@/server/surface";
import { requireRole } from "@/server/session";
import { StaffApp } from "@/components/staff/staff-app";

export default async function StaffPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (appSurface() !== "staff") notFound();
  if (!await requireRole("staff")) redirect(`/${locale}/login`);
  return <StaffApp />;
}
