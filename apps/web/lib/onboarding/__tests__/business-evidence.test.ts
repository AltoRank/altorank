import { expect, it } from "vitest";
import { businessPageEvidence } from "../business-evidence";
import { parseCapabilities } from "../profile-focus";
it("keeps source-labelled catalog, service-area and conditional plan evidence", () => {
  const url = "https://example.com/";
  const page = businessPageEvidence('<script>Invented product</script><header><nav><a href="/collections/wash">Beard wash</a></nav></header><main>Managed: three workspaces. Agency: unlimited workspaces.</main><footer>We serve Croydon and Wimbledon.</footer>', url);
  expect(page.text).not.toContain("Invented product");
  expect(page.links).toEqual(["https://example.com/collections/wash"]);
  expect(page.text).toContain("Beard wash");
  expect(page.text).toContain("Agency: unlimited workspaces");
  expect(parseCapabilities([{claim:"Croydon coverage",sourceUrl:url,quote:"We serve Croydon and Wimbledon."}], "example.com", page.text)[0].status).toBe("observed");
});
it("never follows off-site or executable catalog links", () => {
  expect(businessPageEvidence('<a href="https://other.test/products">Products</a><a href="javascript:products()">Products</a>', "https://example.com/").links).toEqual([]);
});
