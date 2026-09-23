import { BRAND_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function BrandMark({ className, accentClassName }: { className?: string; accentClassName?: string }) {
  return <span className={cn("inline-flex items-baseline font-extrabold tracking-[-0.055em]", className)}>{BRAND_NAME}<span aria-hidden="true" className={cn("text-[#9ba971]", accentClassName)}>.</span></span>;
}
