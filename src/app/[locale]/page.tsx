import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/server/session";
import { appSurface } from "@/server/surface";

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const surface = appSurface();
  if (!surface) notFound();
  redirect(`/${locale}/${await requireRole(surface) ? surface : "login"}`);
}
