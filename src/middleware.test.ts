import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

const createServerClient = vi.hoisted(() =>
  vi.fn(
    (
      _url: string,
      _key: string,
      opts: {
        cookies: { setAll: (c: Array<{ name: string; value: string; options: Record<string, unknown> }>) => void };
      },
    ) => ({
      auth: {
        // Mirrors real auth-js: an expired access token is transparently
        // refreshed inside getUser(), which rotates the refresh token and
        // pushes the new cookies through setAll() before resolving.
        getUser: async () => {
          if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
          return { data: { user: mockUser } };
        },
      },
    }),
  ),
);
vi.mock("@supabase/ssr", () => ({ createServerClient }));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — public WhatsApp webhook", () => {
  it("lets a signed-out Meta verification GET through untouched", async () => {
    mockUser = null;

    const res = await middleware(
      new NextRequest(
        "https://app.test/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=1&hub.verify_token=t",
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("still requires a session for other /api/whatsapp routes", async () => {
    mockUser = null;

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/config"),
    );

    expect(res.status).toBe(401);
  });

  it("requires a session for the resort admin APIs", async () => {
    mockUser = null;

    const res = await middleware(
      new NextRequest("https://app.test/api/admin/bookings"),
    );

    expect(res.status).toBe(401);
  });
});

describe("middleware — every dashboard route requires a session", () => {
  // Read the route group rather than hard-coding a list, so a new page added
  // under src/app/(dashboard)/ fails here until it is added to
  // protectedPaths. /flows, /agents and /notifications were missed that way
  // and rendered a broken page to signed-out visitors instead of redirecting.
  const dashboardRoutes = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("finds the dashboard route group", () => {
    expect(dashboardRoutes).toContain("/dashboard");
  });

  it.each(dashboardRoutes)("redirects a signed-out visitor from %s to /login", async (route) => {
    mockUser = null;

    const res = await middleware(new NextRequest(`https://app.test${route}`));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("middleware — Supabase configuration", () => {
  it("passes the configured URL and anon key to the client", async () => {
    mockUser = { id: "user-1" };
    await middleware(new NextRequest("https://app.test/dashboard"));
    expect(createServerClient).toHaveBeenCalledWith("https://test.supabase.co", "anon-key", expect.anything());
  });

  describe.each([
    ["NEXT_PUBLIC_SUPABASE_URL", ""],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ""],
    ["NEXT_PUBLIC_SUPABASE_URL", "https://your-project.supabase.co"],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "your-anon-key"],
    ["NEXT_PUBLIC_SUPABASE_URL", "not a url"],
  ])("with %s = %j", (name, value) => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv(name, value);
    });

    it("refuses protected pages with 503 instead of crashing or letting them through", async () => {
      const res = await middleware(new NextRequest("https://app.test/inbox"));
      expect(res.status).toBe(503);
      expect(res.headers.get("x-middleware-next")).toBeNull();
      expect(await res.text()).toContain(name);
      expect(createServerClient).not.toHaveBeenCalled();
    });

    it("refuses protected APIs with a 503 JSON error", async () => {
      const res = await middleware(new NextRequest("https://app.test/api/whatsapp/config"));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe("supabase_not_configured");
      expect(body.detail).toContain(name);
    });

    it("still serves the public home page", async () => {
      const res = await middleware(new NextRequest("https://app.test/"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });

    it("lets the login page render (it reports the same error itself)", async () => {
      const res = await middleware(new NextRequest("https://app.test/login"));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    });
  });

  it("keeps production error responses generic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const page = await middleware(new NextRequest("https://app.test/dashboard"));
    expect(page.status).toBe(503);
    expect(await page.text()).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
    const api = await middleware(new NextRequest("https://app.test/api/whatsapp/config"));
    const body = await api.json();
    expect(body.detail).toBeUndefined();
    expect(body.missing).toBeUndefined();
  });
});
