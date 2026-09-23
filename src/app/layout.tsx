import { BRAND_NAME } from "@/lib/brand";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-sans-sc";
import "./globals.css";

export const metadata: Metadata = { title: `${BRAND_NAME} VIP`, description: `${BRAND_NAME} VIP`, robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = (await cookies()).get("SSPC_LOCALE")?.value === "zh-CN" ? "zh-CN" : "en";
  return <html lang={locale}><body>{children}</body></html>;
}
