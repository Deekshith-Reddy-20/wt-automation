import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // Supabase mock mode: unit tests replace the Supabase clients with
      // vi.mock(), but the config validation in src/lib/supabase/env.ts
      // still needs well-formed values. `.invalid` never resolves, so a
      // test that forgets to mock fails instead of reaching a real
      // project. Tests of the missing-config path override these with
      // vi.stubEnv(). Real-database tests use the disposable stack
      // (WACRM_DISPOSABLE_DB=1), never these values.
      NEXT_PUBLIC_SUPABASE_URL: "https://vitest.supabase.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "vitest-dummy-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "vitest-dummy-service-role-key",
    },
    clearMocks: true,
  },
});
