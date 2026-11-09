// Unit/integration tests always use the LOCAL stack, whatever the repo's .env points at (like agent/tests/conftest.py).
// Pre-set variables win over .env files, so these hold. The LLM is never called: core tests script it.
Object.assign(process.env, {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "",
  CLINIC_TIMEZONE: "Asia/Kolkata",
  LLM_BASE_URL: "http://llm.invalid/v1",
  LLM_API_KEY: "test",
  STT_API_KEY: "test",
  PROMPT_VERSION: "v2",
});
