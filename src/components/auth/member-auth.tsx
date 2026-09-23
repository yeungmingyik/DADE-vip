"use client";
import { apiRequest } from "@/lib/api-client";

import Link from "next/link";
import { BrandMark } from "@/components/shared/brand-mark";
import { BRAND_LABEL } from "@/lib/brand";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Check, CreditCard, Languages, LoaderCircle, Smartphone } from "lucide-react";
import { useAppLocale } from "@/components/shared/locale-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type AuthStep = "phone" | "code" | "register";
type AuthAction = "request" | "verify" | "register";
type CodeChallenge = {
  challengeId: string;
  maskedPhone: string;
  expiresAt: string;
  resendAt: string;
  demoCode?: string;
};
type Registration = { registrationToken: string; phone: string };
type AuthRequest =
  | { action: "request"; phone: string }
  | { action: "verify"; challengeId: string; code: string }
  | { action: "register"; registrationToken: string; name: string };
type AuthResult = CodeChallenge | { status: "authenticated" } | ({ status: "registration" } & Registration);

const errorCodes = [
  "INVALID_PHONE", "OTP_INVALID", "OTP_EXPIRED", "OTP_LOCKED", "OTP_RATE_LIMITED",
  "OTP_CHALLENGE_INVALID", "OTP_DELIVERY_FAILED", "REGISTRATION_EXPIRED", "REGISTRATION_INVALID",
  "NAME_INVALID", "CODE_INVALID", "MEMBER_SUSPENDED", "INVALID_INPUT", "FORBIDDEN", "DEMO_DISABLED", "NETWORK_ERROR", "INVALID_RESPONSE",
] as const;
type AuthErrorCode = typeof errorCodes[number];

class AuthRequestError extends Error {
  constructor(readonly code: AuthErrorCode, readonly retryAt = 0) {
    super(code);
  }
}

function normalizePhone(value: string) {
  const compact = value.replace(/[\s()-]/g, "");
  const national = compact.startsWith("+65") ? compact.slice(3) : /^65\d{8}$/.test(compact) ? compact.slice(2) : compact;
  return /^[89]\d{7}$/.test(national) ? `+65${national}` : null;
}

async function sendAuthRequest(body: AuthRequest, signal: AbortSignal): Promise<AuthResult> {
  const response = await apiRequest("/api/auth/member", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const result: unknown = await response.json();
  if (!result || typeof result !== "object") throw new AuthRequestError("INVALID_RESPONSE");
  if (!response.ok || "error" in result) {
    const code = "error" in result && errorCodes.includes(result.error as AuthErrorCode) ? result.error as AuthErrorCode : "INVALID_RESPONSE";
    const retryAt = "resendAt" in result && typeof result.resendAt === "string" ? Date.parse(result.resendAt) : 0;
    const retryDelay = "retryAfterSeconds" in result && typeof result.retryAfterSeconds === "number" ? Date.now() + result.retryAfterSeconds * 1000 : 0;
    throw new AuthRequestError(code, Math.max(Number.isFinite(retryAt) ? retryAt : 0, retryDelay));
  }
  if ("status" in result && result.status === "authenticated") return { status: "authenticated" };
  if ("status" in result && result.status === "registration" && "registrationToken" in result && typeof result.registrationToken === "string" && "phone" in result && typeof result.phone === "string") {
    return { status: "registration", registrationToken: result.registrationToken, phone: result.phone };
  }
  if ("challengeId" in result && typeof result.challengeId === "string" && "maskedPhone" in result && typeof result.maskedPhone === "string" && "expiresAt" in result && typeof result.expiresAt === "string" && "resendAt" in result && typeof result.resendAt === "string" && Number.isFinite(Date.parse(result.expiresAt)) && Number.isFinite(Date.parse(result.resendAt))) {
    return {
      challengeId: result.challengeId,
      maskedPhone: result.maskedPhone,
      expiresAt: result.expiresAt,
      resendAt: result.resendAt,
      demoCode: "demoCode" in result && typeof result.demoCode === "string" && /^\d{6}$/.test(result.demoCode) ? result.demoCode : undefined,
    };
  }
  throw new AuthRequestError("INVALID_RESPONSE");
}

export function MemberAuth({ enabled }: { enabled: boolean }) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const router = useRouter();
  const { setLocale } = useAppLocale();
  const [step, setStep] = useState<AuthStep>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [challenge, setChallenge] = useState<CodeChallenge | null>(null);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [pending, setPending] = useState<AuthAction | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);
  const [notice, setNotice] = useState<"codeReady" | "codeResent" | null>(null);
  const [now, setNow] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [retryPhone, setRetryPhone] = useState<string | null>(null);
  const [challengeBlocked, setChallengeBlocked] = useState(false);
  const busy = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const resendButton = useRef<HTMLButtonElement>(null);
  const changePhoneButton = useRef<HTMLButtonElement>(null);

  const busyState = pending !== null || redirecting;
  const disabled = busyState || !enabled;
  const resendAt = Math.max(challenge ? Date.parse(challenge.resendAt) : 0, normalizePhone(phone) === retryPhone ? retryAt : 0);
  const resendRemaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expired = challenge !== null && now >= Date.parse(challenge.expiresAt);
  const codeUnavailable = challengeBlocked || expired;
  const visibleError = expired && (error === "OTP_INVALID" || error === "CODE_INVALID") ? "OTP_EXPIRED" : error;
  const title = step === "phone" ? "phoneTitle" : step === "code" ? "codeTitle" : "registerTitle";

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    if (!challenge && !retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const updateClock = () => setNow(Date.now());
    document.addEventListener("visibilitychange", updateClock);
    window.addEventListener("focus", updateClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", updateClock);
      window.removeEventListener("focus", updateClock);
    };
  }, [challenge, retryAt]);

  useEffect(() => {
    if (!enabled || pending !== null || redirecting) return;
    if (step === "phone") phoneInput.current?.focus();
    if (step === "code") {
      if (!codeUnavailable) codeInput.current?.focus();
      else if (resendButton.current && !resendButton.current.disabled) resendButton.current.focus();
      else changePhoneButton.current?.focus();
    }
    if (step === "register") nameInput.current?.focus();
  }, [step, enabled, pending, redirecting, codeUnavailable]);

  function changePhone() {
    if (busy.current) return;
    setStep("phone");
    setChallenge(null);
    setRegistration(null);
    setCode("");
    setName("");
    setChallengeBlocked(false);
    setError(null);
    setNotice(null);
  }

  async function submitRequest(body: AuthRequest) {
    if (busy.current || !enabled) return;
    busy.current = true;
    setPending(body.action);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    requestController.current = controller;
    let navigating = false;
    try {
      const result = await sendAuthRequest(body, controller.signal);
      setNow(Date.now());
      if ("status" in result && result.status === "authenticated") {
        navigating = true;
        setRedirecting(true);
        router.replace(`/${locale}/member`);
        router.refresh();
      } else if ("status" in result && result.status === "registration") {
        setRegistration(result);
        setChallenge(null);
        setCode("");
        setStep("register");
      } else if ("challengeId" in result) {
        setChallenge(result);
        setCode("");
        setRegistration(null);
        setChallengeBlocked(false);
        setRetryAt(Date.parse(result.resendAt));
        setRetryPhone(body.action === "request" ? body.phone : null);
        setNotice(step === "code" ? "codeResent" : "codeReady");
        setStep("code");
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      const authError = failure instanceof AuthRequestError ? failure : new AuthRequestError("NETWORK_ERROR");
      setError(authError.code);
      setNow(Date.now());
      if (authError.retryAt && body.action === "request") {
        setRetryAt(authError.retryAt);
        setRetryPhone(body.phone);
      }
      if (["OTP_EXPIRED", "OTP_LOCKED", "OTP_CHALLENGE_INVALID", "OTP_DELIVERY_FAILED", "MEMBER_SUSPENDED"].includes(authError.code)) setChallengeBlocked(true);
      if (["REGISTRATION_EXPIRED", "REGISTRATION_INVALID"].includes(authError.code)) {
        setRegistration(null);
        setChallenge(null);
        setCode("");
        setStep("phone");
      }
    } finally {
      if (!navigating && !controller.signal.aborted) {
        busy.current = false;
        setPending(null);
      }
    }
  }

  function requestCode() {
    if (busy.current || resendRemaining > 0) return;
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError("INVALID_PHONE");
      phoneInput.current?.focus();
      return;
    }
    void submitRequest({ action: "request", phone: normalized });
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !enabled) return;
    if (step === "phone") {
      requestCode();
    } else if (step === "code" && challenge && !codeUnavailable) {
      if (!/^\d{6}$/.test(code)) {
        setError("CODE_INVALID");
        codeInput.current?.focus();
        return;
      }
      void submitRequest({ action: "verify", challengeId: challenge.challengeId, code });
    } else if (step === "register" && registration) {
      const trimmedName = name.trim();
      if (!trimmedName || trimmedName.length > 80 || /[\u0000-\u001f\u007f]/.test(trimmedName)) {
        setError("NAME_INVALID");
        nameInput.current?.focus();
        return;
      }
      void submitRequest({ action: "register", registrationToken: registration.registrationToken, name: trimmedName });
    }
  }

  const submitLabel = redirecting ? t("openingCard")
    : pending === "request" ? t("sendingCode")
      : pending === "verify" ? t("verifying")
        : pending === "register" ? t("registering")
          : step === "phone" && resendRemaining > 0 ? t("requestCountdown", { seconds: resendRemaining })
            : step === "phone" ? t("sendCode") : step === "code" ? t("verify") : t("register");

  return <div className="min-h-svh bg-[#f8f6f6] text-[#282326]">
    <header className="mx-auto flex min-h-20 max-w-6xl items-center justify-between gap-3 px-4 sm:px-8">
      <Link href={`/${locale}`} aria-label={BRAND_LABEL} className="inline-flex min-h-11 items-center"><BrandMark /></Link>
      <Button type="button" variant="ghost" className="min-h-11 gap-2 px-3 text-xs" disabled={busyState} aria-label={`${t("language")}: ${t("languageOption")}`} onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}><Languages aria-hidden="true" className="size-4" />{t("languageOption")}</Button>
    </header>
    <main className="mx-auto flex w-full max-w-[480px] flex-col px-4 pb-12 pt-4 sm:pt-10">
      {step !== "phone" && <div className="mb-4"><Button ref={changePhoneButton} type="button" variant="ghost" className="min-h-11 gap-2 px-1 text-xs text-stone-600" disabled={busyState} onClick={changePhone}><ArrowLeft aria-hidden="true" className="size-4" />{t("changePhone")}</Button></div>}
      <Card className="overflow-hidden rounded-[24px] border-stone-200/80 shadow-[0_12px_40px_-24px_rgba(80,27,36,0.2)]">
        <div className="relative isolate overflow-hidden bg-[#501b24] px-6 pb-7 pt-6 text-white sm:px-8 sm:pb-8 sm:pt-8">
          <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-28 -z-10 size-72 rounded-full border border-[#efbcc4]/15" />
          <div aria-hidden="true" className="pointer-events-none absolute -right-12 -top-16 -z-10 size-48 rounded-full bg-[#df8997]/10" />
          <div className="mb-8 flex items-center justify-between gap-3"><span className="text-[10px] font-medium uppercase tracking-[0.19em] text-[#f0cdd3]">{t("membership")}</span><CreditCard aria-hidden="true" className="size-6 stroke-[1.5] text-[#f0cdd3]" /></div>
          <h1 className="text-[26px] font-medium leading-tight tracking-[-0.035em] sm:text-[30px]">{t(title)}</h1>
        </div>
        <CardContent className="p-6 sm:p-8">
          <form onSubmit={submitForm} noValidate aria-busy={busyState} className="space-y-6">
            {step === "phone" && <div className="space-y-2.5">
              <label htmlFor="member-phone" className="text-sm font-medium">{t("phone")}</label>
              <div className="relative"><span aria-hidden="true" className="absolute inset-y-0 left-4 flex items-center border-r border-transparent text-sm font-medium text-stone-600">+65</span><span id="member-phone-country" className="sr-only">{t("countryCode")} +65</span><Input ref={phoneInput} id="member-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national" enterKeyHint="next" dir="ltr" value={phone} onChange={(event) => { setPhone(event.target.value); setError(null); }} placeholder={t("phonePlaceholder")} maxLength={20} required disabled={disabled} aria-invalid={error === "INVALID_PHONE"} aria-describedby={error ? "member-phone-country member-auth-error" : "member-phone-country"} className="h-13 rounded-xl bg-white pl-16 text-base shadow-none md:text-base" /></div>
            </div>}
            {step === "code" && challenge && <div className="space-y-5">
              <p className="flex items-start gap-2 text-sm leading-relaxed text-stone-600"><Smartphone aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span>{t("verificationFor", { phone: challenge.maskedPhone })}</span></p>
              <div className="space-y-2.5"><label htmlFor="member-code" className="text-sm font-medium">{t("code")}</label><Input ref={codeInput} id="member-code" name="verification-code" type="text" inputMode="numeric" autoComplete="one-time-code" enterKeyHint="done" dir="ltr" value={code} onChange={(event) => { setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); setError(null); setNotice(null); }} onPaste={(event) => { const pastedCode = event.clipboardData.getData("text").replace(/\D/g, ""); if (/^\d{6}$/.test(pastedCode)) { event.preventDefault(); setCode(pastedCode); setError(null); setNotice(null); } }} placeholder={t("codePlaceholder")} maxLength={6} required disabled={disabled || codeUnavailable} aria-invalid={error === "OTP_INVALID" || error === "CODE_INVALID"} aria-describedby={error ? "member-auth-error" : expired ? "member-code-expired" : undefined} className="h-14 rounded-xl bg-white text-center text-xl tracking-[0.3em] shadow-none placeholder:text-sm placeholder:tracking-normal md:text-xl" /></div>
              {challenge.demoCode && <Button type="button" variant="outline" className="min-h-11 w-full rounded-xl text-sm" disabled={disabled || codeUnavailable} onClick={() => { setCode(challenge.demoCode!); setError(null); setNotice(null); codeInput.current?.focus(); }}>{t("fillCode")}</Button>}
              {expired && !error && <p id="member-code-expired" role="status" className="text-sm leading-relaxed text-destructive">{t("codeExpired")}</p>}
            </div>}
            {step === "register" && registration && <div className="space-y-5">
              <div className="flex items-center gap-3 rounded-xl bg-emerald-50 px-4 py-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-emerald-800"><Check aria-hidden="true" className="size-4" /></span><div className="min-w-0"><p className="text-xs font-medium text-emerald-900">{t("phoneVerified")}</p><p dir="ltr" className="mt-1 text-sm text-stone-600">{registration.phone}</p></div></div>
              <div className="space-y-2.5"><label htmlFor="member-name" className="text-sm font-medium">{t("name")}</label><Input ref={nameInput} id="member-name" name="name" autoComplete="name" enterKeyHint="done" value={name} onChange={(event) => { setName(event.target.value); setError(null); }} placeholder={t("namePlaceholder")} maxLength={80} required disabled={disabled} aria-invalid={error === "NAME_INVALID"} aria-describedby={error ? "member-auth-error" : undefined} className="h-13 rounded-xl bg-white text-base shadow-none md:text-base" /></div>
            </div>}
            <div className="space-y-3">
              {(!enabled || visibleError) && <p id="member-auth-error" role="alert" className="text-sm leading-relaxed text-destructive">{!enabled ? t("unavailable") : t(`errors.${visibleError}`)}</p>}
              {notice && !error && !expired && <p role="status" className="text-xs leading-relaxed text-emerald-800">{t(notice)}</p>}
              <Button type="submit" disabled={disabled || (step === "phone" && resendRemaining > 0) || (step === "code" && codeUnavailable)} className="min-h-13 w-full gap-2 rounded-xl bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90">
                {busyState ? <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : null}<span>{submitLabel}</span>{!busyState && <ArrowRight aria-hidden="true" className="size-4" />}
              </Button>
              {step === "code" && <Button ref={resendButton} type="button" variant="ghost" className="min-h-11 w-full rounded-xl text-xs text-stone-600" onClick={requestCode} disabled={disabled || resendRemaining > 0}>{resendRemaining > 0 ? t("resendCountdown", { seconds: resendRemaining }) : t("resend")}</Button>}
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  </div>;
}
