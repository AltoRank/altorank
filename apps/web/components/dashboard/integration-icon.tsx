import { BRAND_ICONS } from "@/lib/brand-icons";

/**
 * The square at the top-left of an integration tile.
 *
 * Falls back to the old two-letter monogram for anything with no brand mark -
 * Webhook and Ahrefs today - because a tile with an empty square reads as a
 * loading state rather than as a product without a logo.
 */
export function IntegrationIcon({
  id,
  name,
  size = 32,
}: {
  id: string;
  name: string;
  size?: number;
}) {
  const icon = BRAND_ICONS[id];

  if (!icon) {
    return (
      <div
        className="rounded-[7px] bg-ink text-bg grid place-items-center font-mono text-[11px] font-semibold shrink-0"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {name.slice(0, 2).toUpperCase()}
      </div>
    );
  }

  return (
    <div
      className="rounded-[7px] border border-line bg-panel grid place-items-center shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        role="img"
        viewBox="0 0 24 24"
        width={size * 0.55}
        height={size * 0.55}
        // No brand hex published for this one, so it takes the interface's own
        // colour and stays legible in both themes rather than guessing.
        fill={icon.hex ?? "currentColor"}
        className={icon.hex ? undefined : "text-ink"}
      >
        <title>{name}</title>
        <path d={icon.d} />
      </svg>
    </div>
  );
}
