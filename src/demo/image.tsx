import { createElement, type ImgHTMLAttributes } from "react";
import { siteBase } from "./navigation";

type ImageProps = ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; priority?: boolean };

export default function Image({ fill, priority, style, src, alt = "", ...props }: ImageProps) {
  return createElement("img", {
    ...props, alt,
    src: typeof src === "string" && src.startsWith("/") ? `${siteBase}${src}` : src,
    loading: priority ? "eager" : props.loading ?? "lazy",
    decoding: "async",
    style: { ...(fill ? { position: "absolute", inset: 0, width: "100%", height: "100%" } : {}), ...style },
  });
}
