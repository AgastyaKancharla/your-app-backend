/**
 * requireTenant
 *
 * Must run AFTER requireAuth. Resolves which restaurant this request is
 * acting on behalf of, and attaches it as req.restaurantId.
 *
 * Critically: the restaurant_id is NOT trusted from the request (query
 * param, header, or body) on its own. We look up the user's actual
 * memberships via req.supabase — which is itself RLS-scoped to this
 * user — so a request can only ever resolve to a restaurant the caller
 * genuinely belongs to. If someone tries to pass a different
 * restaurant_id they're not a member of, the membership lookup simply
 * won't find it, and this middleware rejects with 403.
 *
 * This is what prevents "change the ID in the URL and see someone
 * else's data" — even if a downstream route handler is sloppy and
 * trusts req.restaurantId blindly, that value has already been proven
 * to belong to the caller before the route ever runs. And even if a
 * route DIDN'T use this middleware at all, RLS would still block
 * cross-tenant reads at the database level as a second, independent
 * layer of defense.
 */
const requireTenant = async (req, res, next) => {
  try {
    if (!req.userId || !req.supabase) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const requestedRestaurantId = String(
      req.headers["x-restaurant-id"] || req.query?.restaurantId || ""
    ).trim();

    const { data: memberships, error } = await req.supabase
      .from("memberships")
      .select("restaurant_id, role")
      .eq("user_id", req.userId);

    if (error) {
      return res.status(500).json({ message: "Unable to resolve workspace" });
    }

    if (!memberships || memberships.length === 0) {
      return res
        .status(403)
        .json({ message: "No restaurant workspace found for this account" });
    }

    const activeMembership = requestedRestaurantId
      ? memberships.find((m) => m.restaurant_id === requestedRestaurantId)
      : memberships[0];

    if (!activeMembership) {
      // The caller asked for a restaurant_id they are not a member of.
      // Reject explicitly rather than silently falling back — this is
      // the exact "change the ID and see someone else's data" attempt.
      return res
        .status(403)
        .json({ message: "You do not have access to this workspace" });
    }

    req.restaurantId = activeMembership.restaurant_id;
    req.membershipRole = activeMembership.role;

    return next();
  } catch (err) {
    return res.status(500).json({ message: "Unable to resolve workspace" });
  }
};

module.exports = { requireTenant };
