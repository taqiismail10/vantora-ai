/**
 * The supplied Vantora logo, rendered as the rounded square chip that the
 * Figma product frames ("Vantora · Product design", page 7) place next to
 * the "Vantora AI" wordmark in the brand rows of the landing and auth
 * screens.
 *
 * The artwork is never painted on here — the file is the brand asset and is
 * served exactly as supplied (a copy of the repo-root `logo-vantora-ai.jpg`,
 * which stays the source of truth). Only the container is styled: a 32px
 * square chip with the frame's corner radius. The source file is 1280×1280,
 * so nothing is stretched; `object-cover` only guards against a future
 * non-square replacement being distorted.
 *
 * Decorative by default: every current placement sits beside a visible
 * "Vantora AI" text label, so the image announces nothing to a screen
 * reader and lists the wordmark as the accessible name for the row.
 */
export function VantoraMark() {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a fixed 28 KB static asset at a fixed 32px size; the image pipeline (srcset/preload/sizing) buys nothing for a brand chip
    <img
      src="/logo-vantora-ai.jpg"
      alt=""
      width={32}
      height={32}
      className="size-8 shrink-0 rounded-[10px] object-cover"
      aria-hidden
    />
  );
}
