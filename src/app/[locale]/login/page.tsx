import { notFound, redirect } from "next/navigation";
import { MemberAuth } from "@/components/auth/member-auth";
import { WorkplaceAuth } from "@/components/auth/workplace-auth";
import { requireRole } from "@/server/session";
import { appSurface } from "@/server/surface";
import { getService } from "@/server/runtime";

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const surface = appSurface();
  if (!surface) notFound();
  if (await requireRole(surface)) redirect(`/${locale}/${surface}`);
  const enabled = process.env.APP_MODE === "demo";
  if (surface === "member") return <MemberAuth enabled={enabled} />;
  const accounts = enabled ? (surface === "staff" ? ["s001", "s002", "s003"] : ["a001"]).flatMap((id) => {
    try {
      const session = getService().persona(surface, id);
      return [{ userId: session.userId, name: session.name }];
    } catch { return []; }
  }) : [];
  return <WorkplaceAuth role={surface} enabled={enabled} accounts={accounts} />;
}
