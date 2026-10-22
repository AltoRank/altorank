import { describe, expect, it } from "vitest";
import { EXPIRED_LINK_MESSAGE, signInMethod, signinPath } from "../signin-path";

describe("signInMethod", () => {
  it("opens on the code unless the URL asks for the password", () => {
    expect(signInMethod(undefined)).toBe("code");
    expect(signInMethod("code")).toBe("code");
    expect(signInMethod("password")).toBe("password");
    expect(signInMethod("PASSWORD")).toBe("code");
    expect(signInMethod(["password"])).toBe("code");
  });
});

describe("signinPath", () => {
  it("carries next, with its own query intact", () => {
    expect(signinPath("/signin", "/articles?status=review")).toBe("/signin?next=%2Farticles%3Fstatus%3Dreview");
    expect(signinPath("/signin/code", "/dashboard", { step: "code" })).toBe("/signin/code?step=code&next=%2Fdashboard");
  });

  it("is the bare page without anything to carry", () => {
    expect(signinPath("/signin", null)).toBe("/signin");
  });

  it("says an expired link can be replaced by a code, on the page that sends one", () => {
    expect(signinPath("/signin", "/content/a1", { error: EXPIRED_LINK_MESSAGE })).toBe(
      "/signin?error=That+link+has+expired.+We+can+email+you+a+new+code.&next=%2Fcontent%2Fa1",
    );
  });
});
