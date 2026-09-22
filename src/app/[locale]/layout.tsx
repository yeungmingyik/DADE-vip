import { notFound } from "next/navigation";
import { LocaleProvider } from "@/components/shared/locale-provider";
import { appSurface } from "@/server/surface";
import { commonMessages } from "@/messages/common";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const surface = appSurface();
  if (!surface || (locale !== "en" && locale !== "zh-CN")) return {};
  return { title: `SSPC · ${commonMessages[locale][surface]}` };
}

export default async function LocalizedLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (locale !== "en" && locale !== "zh-CN") notFound();
  const surface = appSurface();
  if (!surface) notFound();
  return <LocaleProvider initialLocale={locale} surface={surface}>{children}</LocaleProvider>;
}
