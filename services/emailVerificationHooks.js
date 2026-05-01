const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
};

const isProduction = () => String(process.env.NODE_ENV || "").toLowerCase() === "production";
const COMPANY_NAME = "WeValue";

const postWebhook = async ({ webhookUrl, authHeader, payload, verboseLogs, logContext }) => {
  if (verboseLogs) {
    console.info(logContext, payload);
  }

  if (!webhookUrl) {
    return {
      dispatched: false,
      channel: "none"
    };
  }

  const headers = { "Content-Type": "application/json" };
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Webhook responded ${response.status}`);
  }

  return {
    dispatched: true,
    channel: "webhook"
  };
};

const buildVerificationUrl = ({ email, token }) => {
  const template = String(process.env.AUTH_EMAIL_VERIFY_URL_TEMPLATE || "").trim();
  if (template) {
    return template
      .replace(/\{\{token\}\}/g, encodeURIComponent(token))
      .replace(/\{\{email\}\}/g, encodeURIComponent(email));
  }

  const baseUrl = String(process.env.AUTH_VERIFICATION_BASE_URL || "").trim();
  if (!baseUrl) {
    return "";
  }

  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
};

const requireResendConfig = () => {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM_EMAIL || "").trim();

  if (!apiKey || !from) {
    return null;
  }

  return {
    apiKey,
    from,
    replyTo: String(process.env.RESEND_REPLY_TO_EMAIL || "").trim()
  };
};

const sendResendEmail = async ({ to, subject, html, text }) => {
  const config = requireResendConfig();
  if (!config) {
    return {
      dispatched: false,
      channel: "none",
      reason: "resend_not_configured"
    };
  }

  const payload = {
    from: config.from,
    to: [to],
    subject,
    html,
    text
  };

  if (config.replyTo) {
    payload.reply_to = config.replyTo;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Resend responded ${response.status}: ${responseText.slice(0, 200)}`);
  }

  return {
    dispatched: true,
    channel: "resend"
  };
};

const requireTwilioConfig = () => {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  const fromPhone = String(process.env.TWILIO_FROM_PHONE || "").trim();

  if (!accountSid || !authToken || !fromPhone) {
    return null;
  }

  return {
    accountSid,
    authToken,
    fromPhone
  };
};

const sendTwilioSms = async ({ toPhone, body }) => {
  const config = requireTwilioConfig();
  if (!config) {
    return {
      dispatched: false,
      channel: "none",
      reason: "twilio_not_configured"
    };
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    config.accountSid
  )}/Messages.json`;
  const formBody = new URLSearchParams({
    To: toPhone,
    From: config.fromPhone,
    Body: body
  });

  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody.toString()
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Twilio responded ${response.status}: ${responseText.slice(0, 200)}`);
  }

  return {
    dispatched: true,
    channel: "sms"
  };
};

const getTtlMinutesFromExpiry = (expiresAt, fallback = 10) => {
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) {
    return fallback;
  }

  return Math.max(1, Math.ceil((expires.getTime() - Date.now()) / (60 * 1000)));
};

const dispatchVerificationEmailHook = async ({
  email,
  token,
  name,
  restaurantName,
  expiresAt
}) => {
  const verificationUrl = buildVerificationUrl({ email, token });
  const webhookPayload = {
    event: "auth.email_verification.requested",
    email,
    name,
    restaurantName,
    token,
    verificationUrl,
    expiresAt
  };

  const subject = `Verify your ${COMPANY_NAME} account`;
  const text =
    `Hi ${name || "there"},\n\n` +
    "Your account was created successfully. Use the verification code below:\n" +
    `Verification code: ${token}\n` +
    `${verificationUrl ? `Verification link: ${verificationUrl}\n` : ""}` +
    `Expires at: ${new Date(expiresAt).toLocaleString()}\n\n` +
    "If you did not request this, you can ignore this email.";
  const html =
    `<p>Hi ${name || "there"},</p>` +
    "<p>Your account was created successfully. Use the verification code below:</p>" +
    `<p><strong>Verification code:</strong> ${token}</p>` +
    (verificationUrl
      ? `<p><a href="${verificationUrl}" target="_blank" rel="noreferrer">Verify Email</a></p>`
      : "") +
    `<p><strong>Expires at:</strong> ${new Date(expiresAt).toLocaleString()}</p>` +
    "<p>If you did not request this, you can ignore this email.</p>";

  try {
    const resendResult = await sendResendEmail({
      to: email,
      subject,
      html,
      text
    });

    if (resendResult.dispatched) {
      return {
        dispatched: true,
        channel: resendResult.channel,
        verificationUrl
      };
    }
  } catch (err) {
    console.error("[auth] resend verification email failed", err.message);
    if (isProduction()) {
      return {
        dispatched: false,
        channel: "resend",
        verificationUrl,
        error: err.message
      };
    }
  }

  const webhookUrl = String(process.env.AUTH_EMAIL_HOOK_URL || "").trim();
  const verboseLogs = parseBoolean(
    process.env.AUTH_EMAIL_HOOK_VERBOSE,
    false
  );

  try {
    const authHeader = String(process.env.AUTH_EMAIL_HOOK_AUTH || "").trim();
    const result = await postWebhook({
      webhookUrl,
      authHeader,
      payload: webhookPayload,
      verboseLogs,
      logContext: "[auth] verification webhook payload"
    });

    return {
      dispatched: result.dispatched,
      channel: result.channel,
      verificationUrl
    };
  } catch (err) {
    console.error("[auth] verification delivery failed", err.message);
    return {
      dispatched: false,
      channel: "none",
      verificationUrl,
      error: err.message
    };
  }
};

const dispatchLoginOtpHook = async ({
  channel,
  email,
  phone,
  otpCode,
  expiresAt,
  name
}) => {
  const normalizedChannel = String(channel || "").toLowerCase();
  const expiresInMinutes = getTtlMinutesFromExpiry(expiresAt, 10);
  const smsMessage = `Your ${COMPANY_NAME} login code is ${otpCode}. Expires in ${expiresInMinutes} minutes.`;
  const emailSubject = `Your ${COMPANY_NAME} login verification code`;
  const emailText =
    `Hi ${name || "there"},\n\n` +
    `Your login verification code is: ${otpCode}\n` +
    `This code expires in ${expiresInMinutes} minutes.\n\n` +
    "If you did not request this, please secure your account.";
  const emailHtml =
    `<p>Hi ${name || "there"},</p>` +
    `<p>Your login verification code is:</p><p><strong style="font-size:20px;">${otpCode}</strong></p>` +
    `<p>This code expires in ${expiresInMinutes} minutes.</p>` +
    "<p>If you did not request this, please secure your account.</p>";

  try {
    if (normalizedChannel === "sms" && phone) {
      const smsResult = await sendTwilioSms({
        toPhone: phone,
        body: smsMessage
      });

      if (smsResult.dispatched) {
        return {
          dispatched: true,
          channel: "sms"
        };
      }
    }
  } catch (err) {
    console.error("[auth] twilio sms delivery failed", err.message);
    if (isProduction() && !email) {
      return {
        dispatched: false,
        channel: "sms",
        error: err.message
      };
    }
  }

  try {
    if ((normalizedChannel === "email" || email) && email) {
      const emailResult = await sendResendEmail({
        to: email,
        subject: emailSubject,
        html: emailHtml,
        text: emailText
      });

      if (emailResult.dispatched) {
        return {
          dispatched: true,
          channel: "email"
        };
      }
    }
  } catch (err) {
    console.error("[auth] resend otp email failed", err.message);
    if (isProduction()) {
      return {
        dispatched: false,
        channel: "email",
        error: err.message
      };
    }
  }

  const webhookPayload = {
    event: "auth.login_otp.requested",
    channel: normalizedChannel || "none",
    email,
    phone,
    otpCode,
    expiresAt,
    name
  };
  const webhookUrl = String(
    process.env.AUTH_LOGIN_OTP_HOOK_URL || process.env.AUTH_EMAIL_HOOK_URL || ""
  ).trim();
  const authHeader = String(
    process.env.AUTH_LOGIN_OTP_HOOK_AUTH || process.env.AUTH_EMAIL_HOOK_AUTH || ""
  ).trim();
  const verboseLogs = parseBoolean(
    process.env.AUTH_LOGIN_OTP_HOOK_VERBOSE,
    false
  );

  try {
    const result = await postWebhook({
      webhookUrl,
      authHeader,
      payload: webhookPayload,
      verboseLogs,
      logContext: "[auth] login otp webhook payload"
    });
    return {
      ...result
    };
  } catch (err) {
    console.error("[auth] login otp delivery failed", err.message);
    return {
      dispatched: false,
      channel: "none",
      error: err.message
    };
  }
};

const dispatchAccountRecoveryOtpHook = async ({
  channel,
  email,
  phone,
  otpCode,
  expiresAt,
  name,
  purpose = "password_reset"
}) => {
  const normalizedChannel = String(channel || "").toLowerCase();
  const normalizedPurpose = String(purpose || "password_reset").toLowerCase();
  const expiresInMinutes = getTtlMinutesFromExpiry(expiresAt, 10);
  const purposeLabel =
    normalizedPurpose === "username_recovery" ? "username recovery" : "password reset";
  const smsMessage =
    `Your ${COMPANY_NAME} ${purposeLabel} code is ${otpCode}. ` +
    `Expires in ${expiresInMinutes} minutes.`;
  const emailSubject =
    normalizedPurpose === "username_recovery"
      ? `Your ${COMPANY_NAME} username recovery code`
      : `Your ${COMPANY_NAME} password reset code`;
  const emailText =
    `Hi ${name || "there"},\n\n` +
    `Your ${purposeLabel} code is: ${otpCode}\n` +
    `This code expires in ${expiresInMinutes} minutes.\n\n` +
    "If you did not request this, you can ignore this message.";
  const emailHtml =
    `<p>Hi ${name || "there"},</p>` +
    `<p>Your ${purposeLabel} code is:</p>` +
    `<p><strong style="font-size:20px;">${otpCode}</strong></p>` +
    `<p>This code expires in ${expiresInMinutes} minutes.</p>` +
    "<p>If you did not request this, you can ignore this message.</p>";

  try {
    if (normalizedChannel === "sms" && phone) {
      const smsResult = await sendTwilioSms({
        toPhone: phone,
        body: smsMessage
      });

      if (smsResult.dispatched) {
        return {
          dispatched: true,
          channel: "sms"
        };
      }
    }
  } catch (err) {
    console.error("[auth] recovery sms delivery failed", err.message);
    if (isProduction() && !email) {
      return {
        dispatched: false,
        channel: "sms",
        error: err.message
      };
    }
  }

  try {
    if ((normalizedChannel === "email" || email) && email) {
      const emailResult = await sendResendEmail({
        to: email,
        subject: emailSubject,
        html: emailHtml,
        text: emailText
      });

      if (emailResult.dispatched) {
        return {
          dispatched: true,
          channel: "email"
        };
      }
    }
  } catch (err) {
    console.error("[auth] recovery email delivery failed", err.message);
    if (isProduction()) {
      return {
        dispatched: false,
        channel: "email",
        error: err.message
      };
    }
  }

  const webhookPayload = {
    event: "auth.account_recovery_otp.requested",
    purpose: normalizedPurpose,
    channel: normalizedChannel || "none",
    email,
    phone,
    otpCode,
    expiresAt,
    name
  };
  const webhookUrl = String(
    process.env.AUTH_ACCOUNT_RECOVERY_HOOK_URL ||
      process.env.AUTH_LOGIN_OTP_HOOK_URL ||
      process.env.AUTH_EMAIL_HOOK_URL ||
      ""
  ).trim();
  const authHeader = String(
    process.env.AUTH_ACCOUNT_RECOVERY_HOOK_AUTH ||
      process.env.AUTH_LOGIN_OTP_HOOK_AUTH ||
      process.env.AUTH_EMAIL_HOOK_AUTH ||
      ""
  ).trim();
  const verboseLogs = parseBoolean(
    process.env.AUTH_ACCOUNT_RECOVERY_HOOK_VERBOSE,
    false
  );

  try {
    const result = await postWebhook({
      webhookUrl,
      authHeader,
      payload: webhookPayload,
      verboseLogs,
      logContext: "[auth] recovery otp webhook payload"
    });
    return {
      ...result
    };
  } catch (err) {
    console.error("[auth] recovery otp delivery failed", err.message);
    return {
      dispatched: false,
      channel: "none",
      error: err.message
    };
  }
};

module.exports = {
  dispatchVerificationEmailHook,
  dispatchLoginOtpHook,
  dispatchAccountRecoveryOtpHook,
  buildVerificationUrl,
  parseBoolean
};
