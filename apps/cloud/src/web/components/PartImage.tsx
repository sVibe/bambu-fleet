import type { PartListItem } from "../../api-types.ts";
import { cx } from "./ui.tsx";

/** A part's picture: its own top-down cut-out, or the plate it was printed on. */
export function PartImage({
  image,
  alt,
  className,
}: {
  image: PartListItem["image"];
  alt: string;
  className?: string;
}) {
  if (!image) {
    return (
      <div aria-hidden className={cx("grid place-items-center rounded-md bg-wash text-muted", className)}>
        ▢
      </div>
    );
  }
  return (
    <div className={cx("part-well flex rounded-md p-[8%]", className)}>
      <img
        src={image.url}
        alt={alt}
        loading="lazy"
        className={cx("h-full w-full object-contain", image.kind === "part" && "part-cutout")}
      />
    </div>
  );
}
