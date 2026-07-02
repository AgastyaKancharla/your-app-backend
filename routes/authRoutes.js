const express = require("express");
const { getAnonClient } = require("../config/supabase");
const { requireAuth } = require("../middleware/requireAuth");

const router = express.Router();

const normalizeEmail = (v = "") => String(v || "").trim().toLowerCase();
const normalizeText = (v = "") => String(v || "").trim();

/**
 * POST /auth/signup
 * Creates a Supabase Auth user, then a public.users profile row, then
 * (in a follow-up call from the client) a restaurant. We deliberately
 * keep restaurant creation as a SEPARATE step (POST /restaurants) rather
 * than bundling it into signup — this matches the "account first,
 * business type second" onboarding flow we designed, and keeps this
 * endpoint's job singular: create a login-capable account.
 */
router.post("/signup", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const name = normalizeText(req.body?.name);
    const phone = normalizeText(req.body?.phone);

    if (!email || !password || !name) {
      return res.status(400).json({ message: "name, email, and password are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const supabase = getAnonClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name, phone } }
    });

    if (error) {
      const status = error.status === 422 ? 409 : error.status || 400;
      return res.status(status).json({ message: error.message });
    }

    if (!data?.user?.id) {
      return res.status(500).json({ message: "Signup did not return a user" });
    }

    // Create the app-profile row. Uses the session we just got back (if
    // email confirmation is off, signUp returns an active session).
    if (data.session?.access_token) {
      const { createClient } = require("@supabase/supabase-js");
      const sessionClient = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
        { global: { headers: { Authorization: `Bearer ${data.session.access_token}` } } }
      );
      await sessionClient
        .from("users")
        .upsert({ id: data.user.id, name, email, phone }, { onConflict: "id" });
    }

    return res.status(201).json({
      user: { id: data.user.id, email, name, phone },
      session: data.session
        ? {
            accessToken: data.session.access_token,
            refreshToken: data.session.refresh_token,
            expiresAt: data.session.expires_at
          }
        : null,
      emailConfirmationRequired: !data.session
    });
  } catch (err) {
    return res.status(500).json({ message: "Unable to create account" });
  }
});

/**
 * POST /auth/login
 */
router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ message: "email and password are required" });
    }

    const supabase = getAnonClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data?.session) {
      // Deliberately generic — do not reveal whether the email exists.
      return res.status(401).json({ message: "Invalid email or password" });
    }

    return res.json({
      user: {
        id: data.user.id,
        email: data.user.email,
        name: data.user.user_metadata?.name || "",
        phone: data.user.user_metadata?.phone || ""
      },
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at
      }
    });
  } catch (err) {
    return res.status(500).json({ message: "Unable to log in" });
  }
});

/**
 * POST /auth/refresh
 */
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = String(req.body?.refreshToken || "");
    if (!refreshToken) {
      return res.status(401).json({ message: "No active session" });
    }

    const supabase = getAnonClient();
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });

    if (error || !data?.session) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    return res.json({
      session: {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at
      }
    });
  } catch (err) {
    return res.status(500).json({ message: "Unable to refresh session" });
  }
});

/**
 * POST /auth/logout
 * Requires a valid session to log out of (matches the earlier product
 * decision: logout should actually invalidate server-side state, not
 * just be a client-side token drop).
 */
router.post("/logout", requireAuth, async (req, res) => {
  try {
    await req.supabase.auth.signOut();
    return res.json({ message: "Logged out successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Unable to log out" });
  }
});

/**
 * GET /auth/me
 * Returns the current user's profile plus their restaurant memberships.
 * This is the one place the frontend should call to know "who am I and
 * what can I access" — everything here comes from RLS-scoped queries.
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    let { data: profile, error: profileError } = await req.supabase
      .from("users")
      .select("*")
      .eq("id", req.userId)
      .single();

    if (profileError && profileError.code !== "PGRST116") {
      return res.status(500).json({ message: "Unable to load profile" });
    }

    // Self-heal: if signup happened while email confirmation was required
    // (or any other reason the profile upsert didn't run at signup time),
    // create the missing row now using metadata Supabase Auth already
    // has on file. This guarantees /me never returns a user with no
    // profile, regardless of the auth confirmation settings in effect
    // at the time they originally signed up.
    if (!profile) {
      const { data: authUser } = await req.supabase.auth.getUser();
      const metadata = authUser?.user?.user_metadata || {};

      const { data: created, error: createError } = await req.supabase
        .from("users")
        .upsert(
          {
            id: req.userId,
            name: metadata.name || "",
            email: req.userEmail,
            phone: metadata.phone || ""
          },
          { onConflict: "id" }
        )
        .select()
        .single();

      if (!createError) {
        profile = created;
      }
    }

    const { data: memberships, error: membershipError } = await req.supabase
      .from("memberships")
      .select("restaurant_id, role, restaurants(id, name, business_type_label, has_tables, has_delivery, has_multiple_outlets, inventory_deduction_enabled, city, subscription_plan, subscription_status)")
      .eq("user_id", req.userId);

    if (membershipError) {
      return res.status(500).json({ message: "Unable to load workspaces" });
    }

    return res.json({
      user: profile || { id: req.userId, email: req.userEmail },
      memberships: (memberships || []).map((m) => ({
        restaurantId: m.restaurant_id,
        role: m.role,
        restaurant: m.restaurants
      }))
    });
  } catch (err) {
    return res.status(500).json({ message: "Unable to load session" });
  }
});


module.exports = router;

