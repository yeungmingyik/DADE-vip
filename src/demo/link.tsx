import { forwardRef, type AnchorHTMLAttributes } from "react";
import { applicationHref, useRouter } from "./navigation";

const Link = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(({ href = "", onClick, ...props }, ref) => {
  const router = useRouter();
  return <a {...props} ref={ref} href={applicationHref(href)} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || props.target === "_blank" || !href.startsWith("/")) return;
    event.preventDefault();
    router.push(href);
  }} />;
});
Link.displayName = "Link";
export default Link;
