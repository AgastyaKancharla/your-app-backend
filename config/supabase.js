const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_ANON_KEY are required. Set them in your environment."
  );
}

/**
 * Creates a Supabase client scoped to the requesting user's own session
 * token. Every query made with this client is subject to RLS as *that
 * user* — not as an all-access service role. This is the primary client
 * the app should use for almost everything.
 *
 * @param {string} accessToken - the user's Supabase session access token
 */
const getUserClient = (accessToken) => {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
};

/**
 * Creates an unauthenticated Supabase client (anon role). RLS still
 * applies — this can only do what an anonymous, logged-out visitor is
 * allowed to do, which per our policies is effectively nothing on
 * restaurant data. Used for signup/login itself, before a session exists.
 */
const getAnonClient = () => {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
};

/**
 * Creates a service-role Supabase client that BYPASSES RLS entirely.
 * This must only be used for operations that genuinely cannot be scoped
 * to a user session (e.g. internal admin/cron tasks). Every call site
 * using this client is a place where RLS is NOT protecting the query —
 * the code itself must be trusted to filter correctly.
 *
 * As of this build, the core request path (signup/login/orders/menu/
 * inventory) does NOT use this client. If you're reaching for this,
 * stop and ask whether a user-scoped client would work instead.
 */
const getServiceClient = () => {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Service-role operations are unavailable."
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
};

module.exports = { getUserClient, getAnonClient, getServiceClient };
