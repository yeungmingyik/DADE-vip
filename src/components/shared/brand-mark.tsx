import Image from "next/image";
import { BRAND_LOGO, BRAND_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

export function BrandMark({ className, onDark = false }: { className?: string; onDark?: boolean }) {
  return <span className={cn("inline-flex shrink-0 items-center", onDark && "rounded-md bg-white px-2.5 py-2", className)}><Image src={BRAND_LOGO} alt={BRAND_NAME} width={199} height={44} priority className="h-auto w-28" /></span>;
}
