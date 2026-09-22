import { notFound, redirect } from "next/navigation";
import { appSurface } from "@/server/surface";
import { requireRole } from "@/server/session";
import { MemberApp } from "@/components/member/member-app";

export default async function MemberPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (appSurface() !== "member") notFound();
  if (!await requireRole("member")) redirect(`/${locale}/login`);
  return <MemberApp />;
}
