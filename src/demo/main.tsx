import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider } from "@/components/shared/locale-provider";
import { MemberAuth } from "@/components/auth/member-auth";
import { WorkplaceAuth } from "@/components/auth/workplace-auth";
import { commonMessages } from "@/messages/common";
import { demoHasSession } from "./service";
import { localPath, surfaceFromPath, useLocation, useRouter } from "./navigation";
import type { Locale } from "@/lib/types";
import "@fontsource-variable/noto-sans";
import "@fontsource-variable/noto-sans-sc";
import "@/app/globals.css";

const MemberApp = lazy(() => import("@/components/member/member-app").then((module) => ({ default: module.MemberApp })));
const StaffApp = lazy(() => import("@/components/staff/staff-app").then((module) => ({ default: module.StaffApp })));
const AdminApp = lazy(() => import("@/components/admin/admin-app").then((module) => ({ default: module.AdminApp })));

function subscribeSession(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("focus", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("focus", callback);
  };
}

function Application() {
  const location = useLocation();
  const path = localPath(location.split("?")[0]);
  const locale: Locale = path.split("/")[1] === "zh-CN" ? "zh-CN" : "en";
  const role = surfaceFromPath(path);
  const router = useRouter();
  const authenticated = useSyncExternalStore(subscribeSession, () => demoHasSession(role), () => false);
  const login = /\/login\/?$/.test(path);
  const valid = /^\/(en|zh-CN)\/(member|staff|admin)(?:\/login)?\/?$/.test(path);

  useEffect(() => {
    if (!valid || (!authenticated && !login)) router.replace(`/${locale}/${role}/login`);
    else if (authenticated && login) router.replace(`/${locale}/${role}`);
  }, [authenticated, locale, login, role, router, valid]);

  const accounts = role === "staff" ? [{ userId: "s001", name: "Jamie Tan" }, { userId: "s002", name: "Ryan Koh" }, { userId: "s003", name: "Aisha Lim" }] : [{ userId: "a001", name: "Jordan Lee" }];
  return <LocaleProvider initialLocale={locale} surface={role}>
    {!authenticated ? role === "member" ? <MemberAuth enabled /> : <WorkplaceAuth role={role} enabled accounts={accounts} /> : <Suspense fallback={<div role="status" className="grid min-h-svh place-items-center text-sm text-muted-foreground">{commonMessages[locale].loading}</div>}>
      {role === "member" ? <MemberApp /> : role === "staff" ? <StaffApp /> : <AdminApp />}
    </Suspense>}
  </LocaleProvider>;
}

createRoot(document.getElementById("root")!).render(<Application />);
