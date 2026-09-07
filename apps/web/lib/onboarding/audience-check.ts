// ---------------------------------------------------------------------------
// Does this read as an audience, or as something else?
// ---------------------------------------------------------------------------
//
// The first real signup answered "Target audiences" with `united states`,
// `europe`, `belgium`, `hoodie`, `clothing`, `apparel`, `custom print`: the
// markets they ship to and the things they sell. Nothing on the screen said an
// audience is the people who buy. The model's own proposal for the same site
// was fine ("Gift buyers looking for themed clothing"); the person replaced it.
//
// This is a nudge, not a gate. A value that looks like a place or a product
// gets named under the list with a one-line correction; Continue still works,
// because the person may know something the heuristic does not.

export type AudienceDoubt = "place" | "product";

const PLACES = new Set(
  [
    "usa", "us", "u.s.", "u.s.a.", "united states", "united states of america", "america", "north america",
    "south america", "latin america", "canada", "mexico", "brazil", "argentina", "chile", "colombia",
    "europe", "eu", "european union", "uk", "u.k.", "united kingdom", "england", "scotland", "wales", "ireland",
    "germany", "france", "spain", "italy", "portugal", "netherlands", "holland", "belgium", "luxembourg",
    "switzerland", "austria", "denmark", "sweden", "norway", "finland", "iceland", "poland", "czechia",
    "czech republic", "slovakia", "hungary", "romania", "bulgaria", "greece", "turkey", "croatia", "serbia",
    "slovenia", "estonia", "latvia", "lithuania", "ukraine", "russia",
    "asia", "southeast asia", "middle east", "africa", "oceania", "australia", "new zealand", "japan", "china",
    "india", "singapore", "malaysia", "indonesia", "thailand", "vietnam", "philippines", "south korea", "korea",
    "taiwan", "hong kong", "uae", "united arab emirates", "dubai", "saudi arabia", "israel", "egypt",
    "south africa", "nigeria", "kenya", "worldwide", "global", "international", "domestic", "local",
  ],
);

/** Single words that name a thing for sale rather than a person. */
const PRODUCT_WORDS = new Set(
  [
    "hoodie", "hoodies", "sweater", "sweaters", "t-shirt", "tshirt", "t-shirts", "tshirts", "shirt", "shirts",
    "clothing", "clothes", "apparel", "fashion", "accessories", "jewelry", "jewellery", "shoes", "sneakers",
    "bags", "hats", "caps", "socks", "leggings", "swimwear", "underwear", "dresses", "jeans",
    "print", "prints", "printing", "custom print", "print on demand", "merch", "merchandise",
    "furniture", "electronics", "gadgets", "software", "saas", "app", "apps", "plugin", "plugins", "tools",
    "food", "coffee", "wine", "beer", "supplements", "cosmetics", "skincare", "makeup", "perfume",
    "toys", "games", "books", "courses", "consulting", "services", "products",
  ],
);

function norm(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

/**
 * `null` when the value could be an audience; otherwise why it probably is not.
 *
 * Deliberately narrow: only an exact place name, or a value that is nothing
 * but one or two product words, is doubted. "Hoodie buyers in Belgium" passes,
 * because it names people.
 */
export function audienceDoubt(value: string): AudienceDoubt | null {
  const v = norm(value);
  if (!v) return null;
  if (PLACES.has(v)) return "place";
  if (PRODUCT_WORDS.has(v)) return "product";
  const words = v.split(" ");
  if (words.length <= 2 && words.every((w) => PRODUCT_WORDS.has(w))) return "product";
  return null;
}

/** The doubted values, grouped, for one sentence under the list. */
export function doubtedAudiences(values: string[]): { places: string[]; products: string[] } {
  const places: string[] = [];
  const products: string[] = [];
  for (const v of values) {
    const d = audienceDoubt(v);
    if (d === "place") places.push(v);
    else if (d === "product") products.push(v);
  }
  return { places, products };
}
