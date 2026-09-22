"use client";

import { forwardRef, useState, type AnchorHTMLAttributes } from "react";
import { useTranslations } from "next-intl";
import { downloadExport, staticDemo } from "@/lib/api-client";

export const ExportLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(({ href = "", children, onClick, ...props }, ref) => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const t = useTranslations("common");
  return <a ref={ref} {...props} href={href} aria-busy={busy} onClick={async (event) => {
    onClick?.(event);
    if (!staticDemo || event.defaultPrevented) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try { await downloadExport(href); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }}>{failed ? <span role="alert">{t("retry")}</span> : children}</a>;
});
ExportLink.displayName = "ExportLink";
