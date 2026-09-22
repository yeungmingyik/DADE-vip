import { useMemo, useSyncExternalStore } from "react";
import type { Role } from "@/lib/types";

export const siteBase = process.env.NEXT_PUBLIC_SITE_BASE ?? "";
const changed = () => window.dispatchEvent(new PopStateEvent("popstate"));
const subscribe = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
};
const snapshot = () => window.location.pathname + window.location.search;

export function localPath(path = window.location.pathname): string {
  return siteBase && path.startsWith(siteBase + "/") ? path.slice(siteBase.length) : path === siteBase ? "/" : path;
}

export function surfaceFromPath(path = window.location.pathname): Role {
  const segment = localPath(path).split("/")[2];
  return segment === "staff" || segment === "admin" ? segment : "member";
}

export function applicationHref(href: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const url = new URL(localPath(href), window.location.origin);
  const match = url.pathname.match(/^\/(en|zh-CN)(?:\/login)?\/?$/);
  if (match) url.pathname = `/${match[1]}/${surfaceFromPath()}${url.pathname.includes("login") ? "/login" : ""}`;
  return `${siteBase}${url.pathname}${url.search}${url.hash}`;
}

function navigate(href: string, replace = false) {
  const destination = applicationHref(href);
  if (replace) window.history.replaceState({}, "", destination);
  else window.history.pushState({}, "", destination);
  changed();
}

const router = {
  push: (href: string) => navigate(href),
  replace: (href: string) => navigate(href, true),
  refresh: changed,
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  prefetch: () => Promise.resolve(),
};

export function useLocation() { return useSyncExternalStore(subscribe, snapshot, () => "/"); }
export function useRouter() { return router; }
export function usePathname() { return localPath(useLocation().split("?")[0]); }
export function useSearchParams() {
  const location = useLocation();
  return useMemo(() => new URLSearchParams(location.includes("?") ? location.slice(location.indexOf("?") + 1) : ""), [location]);
}
