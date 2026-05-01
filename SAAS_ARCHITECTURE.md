# SaaS Multi-Tenant Architecture

## Tenant Strategy

- Tenant key: `restaurantId`
- Every domain document is tenant scoped through:
  - `req.user.restaurantId` (JWT claim)
  - `requireTenantContext` middleware
  - `withTenantFilter` and `withTenantDocFilter` utilities

## Core Folder Structure

```text
backend/
  config/
    planLimits.js
  controllers/
    onboardingController.js
    restaurantController.js
    subscriptionController.js
  middleware/
    authMiddleware.js
    authorizeRoles.js
    requireTenantContext.js
    subscriptionMiddleware.js
  models/
    User.js
    Restaurant.js
    Subscription.js
    OtpVerification.js
    Order.js
    MenuItem.js
    Ingredient.js
  routes/
    authRoutes.js
    onboardingAuthRoutes.js
    restaurantRoutes.js
    staffRoutes.js
    subscriptionRoutes.js
  services/
    onboardingOtpService.js
    subscriptionPlans.js
```

## Required APIs

- `POST /api/auth/send-otp`
- `POST /api/auth/verify-otp`
- `POST /api/auth/login`
- `POST /api/restaurant/create`
- `POST /api/staff/create`
- `GET /api/staff/list`
- `POST /api/subscription/select-plan`
- `GET /api/subscription/status`

## Onboarding Lifecycle

1. `send-otp`: validates owner + restaurant bootstrap data, hashes OTP, stores OTP with 5-minute expiry.
2. `verify-otp`: verifies OTP, creates:
   - owner user (`role=OWNER`)
   - restaurant workspace
   - 14-day trial subscription
3. Returns JWT access token, refresh token, user payload, and tenant identity.

## Security Controls

- Password hashing with `bcryptjs`
- OTP stored as hash only
- OTP expiry enforced (5 minutes)
- OTP attempts and resend limits enforced
- Login/auth rate limiting middleware enabled
- Role-based access middleware
- Subscription expiry enforcement middleware

