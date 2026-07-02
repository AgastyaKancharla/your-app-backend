const { getUserClient } = require("../config/supabase");

/**
 * requireAuth
 *
 * Verifies the incoming request carries a valid Supabase session token,
 * then attaches TWO things to req:
 *   - req.userId    : the authenticated user's UUID (from Supabase Auth)
 *   - req.supabase  : a Supabase client scoped to THIS user's session
 *
 * Every route handler downstream should use req.supabase for queries,
 * never a service-role client. This means RLS is enforced by the
 * database on every single query automatically — there is no code path
 * where a route can "forget" to filter by restaurant_id, because the
 * database itself won't return rows the user isn't a member of.
 *
 * If the token is missing, malformed, or expired, this middleware
 * rejects the request with 401 before any route handler runs. A
 * logged-out user cannot reach any route that uses this middleware,
 * regardless of what the route itself does.
 */
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";

    if (!token) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const supabase = getUserClient(token);
    const { data, error } = await supabase.auth.getUser();

    if (error || !data?.user?.id) {
      return res.status(401).json({ message: "Invalid or expired session" });
    }

    req.userId = data.user.id;
    req.userEmail = data.user.email || "";
    req.supabase = supabase;

    return next();
  } catch (err) {
    return res.status(500).json({ message: "Unable to verify session" });
  }
};

module.exports = { requireAuth };
