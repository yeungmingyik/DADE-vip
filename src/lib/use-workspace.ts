"use client";
import { apiRequest } from "@/lib/api-client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ActionInput, ActionPayload, ActionResult, AppData, Role, StateQuery } from "./types";

export function useWorkspace(role: Role, query: StateQuery = {}) {
  const t = useTranslations("common");
  const [data, setData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutationLock = useRef(false);
  const pendingMutations = useRef(new Map<string, ActionInput>());
  const actorId = useRef<string | null>(null);
  const currentRequest = useRef(0);
  const failures = useRef(0);
  const params = new URLSearchParams({ role });
  Object.entries(query).forEach(([key, value]) => { if (value !== undefined && value !== "") params.set(key, String(value)); });
  const queryString = params.toString();
  const queryRef = useRef(queryString);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (queryRef.current !== queryString || !mounted.current) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const requestId = ++currentRequest.current;
    try {
      const response = await apiRequest(`/api/state?${queryString}`, { cache: "no-store", signal: abort.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "INTERNAL_ERROR");
      if (mounted.current && queryRef.current === queryString && requestId === currentRequest.current) {
        setData(body as AppData);
        actorId.current = (body as AppData).session.userId;
        setErrorCode(null);
        failures.current = 0;
      }
    } catch (cause) {
      if (abort.signal.aborted) return;
      if (mounted.current && queryRef.current === queryString && requestId === currentRequest.current) {
        const code = cause instanceof Error ? cause.message : "NETWORK";
        if (code === "UNAUTHORIZED" || code === "FORBIDDEN") { setData(null); actorId.current = null; }
        setErrorCode(code);
        failures.current += 1;
      }
    } finally {
      if (mounted.current && requestId === currentRequest.current) setLoading(false);
    }
  }, [queryString]);
  const latestRefresh = useRef(refresh);

  useEffect(() => {
    mounted.current = true;
    queryRef.current = queryString;
    latestRefresh.current = refresh;
    setLoading(true);
    void refresh();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (disposed) return;
      if (document.visibilityState === "visible" && navigator.onLine) await refresh();
      if (!disposed) timer = setTimeout(tick, Math.min(3000 * 2 ** failures.current, 30000));
    };
    timer = setTimeout(tick, 3000);
    const resumed = () => { if (document.visibilityState === "visible" && navigator.onLine) void refresh(); };
    window.addEventListener("focus", resumed);
    window.addEventListener("online", resumed);
    document.addEventListener("visibilitychange", resumed);
    return () => {
      mounted.current = false;
      disposed = true;
      controller.current?.abort();
      currentRequest.current += 1;
      clearTimeout(timer);
      window.removeEventListener("focus", resumed);
      window.removeEventListener("online", resumed);
      document.removeEventListener("visibilitychange", resumed);
    };
  }, [refresh, queryString]);

  const submit = useCallback(async (payload: ActionPayload): Promise<ActionResult | null> => {
    if (mutationLock.current) return null;
    mutationLock.current = true;
    setBusy(true);
    setErrorCode(null);
    const actorAtStart = actorId.current;
    const signature = JSON.stringify([role, actorAtStart, payload]);
    if (!pendingMutations.current.has(signature)) pendingMutations.current.set(signature, { ...payload, requestId: crypto.randomUUID() });
    try {
      const response = await apiRequest(`/api/actions?role=${role}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pendingMutations.current.get(signature)) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) pendingMutations.current.delete(signature);
        throw new Error(result.error || "INTERNAL_ERROR");
      }
      pendingMutations.current.delete(signature);
      await latestRefresh.current();
      return mounted.current && actorId.current === actorAtStart ? result as ActionResult : null;
    } catch (cause) {
      if (mounted.current && actorId.current === actorAtStart) setErrorCode(cause instanceof Error ? cause.message : "NETWORK");
      return null;
    } finally {
      mutationLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [role]);
  const mutate = useCallback(async (payload: ActionPayload) => Boolean(await submit(payload)), [submit]);

  const error = errorCode ? (t.has(`errors.${errorCode}`) ? t(`errors.${errorCode}`) : errorCode === "NETWORK" || errorCode === "Failed to fetch" ? t("networkError") : t("unknownError")) : null;
  return { data, loading, error, busy, refresh, mutate, submit };
}
