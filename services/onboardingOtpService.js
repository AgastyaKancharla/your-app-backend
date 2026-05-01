const crypto = require("crypto");

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 3;
const MAX_OTP_RESENDS = 3;

const isProduction = () => String(process.env.NODE_ENV || "").toLowerCase() === "production";
const getSmsProvider = () => String(process.env.SMS_PROVIDER || "MSG91").trim().toUpperCase();

const normalizePhone = (phone = "") => {
  const raw = String(phone || "").trim();
  if (!raw) {
    return "";
  }

  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  return `${hasPlus ? "+" : ""}${digits}`;
};

const generateOtpCode = () => {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
};

const hashOtp = (otp = "") =>
  crypto.createHash("sha256").update(String(otp)).digest("hex");

const compareOtp = ({ plainOtp, otpHash }) => hashOtp(plainOtp) === String(otpHash || "");

const buildOtpExpiry = () => new Date(Date.now() + OTP_TTL_MS);

const buildOtpMessage = (otp) => {
  const template = String(
    process.env.SMS_OTP_TEMPLATE || process.env.MSG91_MESSAGE_TEMPLATE || "Your WeValue verification code is {{OTP}}"
  );

  return template.replace(/\{\{OTP\}\}/g, String(otp));
};

const normalizeMsg91Mobile = (phone = "") => String(phone || "").replace(/\D/g, "");

const sendOtpUsingMsg91 = async ({ phone, otp }) => {
  const endpoint = String(
    process.env.MSG91_API_URL || process.env.SMS_API_URL || "https://control.msg91.com/api/sendhttp.php"
  ).trim();
  const authkey = String(process.env.MSG91_AUTH_KEY || process.env.SMS_API_KEY || "").trim();
  const sender = String(process.env.MSG91_SENDER || process.env.SMS_SENDER_ID || "").trim();
  const route = String(process.env.MSG91_ROUTE || "4").trim();
  const country = String(process.env.MSG91_COUNTRY || "91").trim();
  const message = buildOtpMessage(otp);
  const mobile = normalizeMsg91Mobile(phone);

  if (!endpoint || !authkey || !sender || !mobile) {
    if (isProduction()) {
      throw new Error(
        "MSG91 credentials are missing. Set MSG91_API_URL, MSG91_AUTH_KEY, MSG91_SENDER, MSG91_ROUTE and MSG91_COUNTRY."
      );
    }

    console.info(`[otp-dev] phone=${phone} otp=${otp} provider=MSG91`);
    return {
      delivered: false,
      mode: "dev-log",
      provider: "MSG91"
    };
  }

  const payload = new URLSearchParams({
    mobile,
    authkey,
    sender,
    message,
    route,
    country
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json,text/plain,*/*"
    },
    body: payload.toString()
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`MSG91 API request failed (${response.status}): ${responseText}`);
  }

  return {
    delivered: true,
    mode: "msg91",
    provider: "MSG91"
  };
};

const sendOtpUsingGenericApi = async ({ phone, otp }) => {
  const smsApiUrl = String(process.env.SMS_API_URL || "").trim();
  const smsApiKey = String(process.env.SMS_API_KEY || "").trim();
  const smsApiAuthToken = String(process.env.SMS_API_AUTH_TOKEN || "").trim();
  const senderId = String(process.env.SMS_SENDER_ID || "").trim();
  const message = buildOtpMessage(otp);

  if (!smsApiUrl) {
    if (isProduction()) {
      throw new Error("SMS_API_URL is not configured for production onboarding OTP delivery");
    }

    console.info(`[otp-dev] phone=${phone} otp=${otp}`);
    return {
      delivered: false,
      mode: "dev-log"
    };
  }

  const headers = {
    "content-type": "application/json",
    accept: "application/json"
  };

  if (smsApiKey) {
    headers["x-api-key"] = smsApiKey;
  }
  if (smsApiAuthToken) {
    headers.authorization = `Bearer ${smsApiAuthToken}`;
  }

  const response = await fetch(smsApiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      phone,
      message,
      senderId
    })
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`SMS API request failed (${response.status}): ${payload}`);
  }

  return {
    delivered: true,
    mode: "sms-api",
    provider: "GENERIC"
  };
};

const sendOtpUsingSmsApi = async ({ phone, otp }) => {
  const provider = getSmsProvider();
  if (provider === "MSG91") {
    return sendOtpUsingMsg91({ phone, otp });
  }

  return sendOtpUsingGenericApi({ phone, otp });
};

module.exports = {
  OTP_LENGTH,
  OTP_TTL_MS,
  MAX_OTP_ATTEMPTS,
  MAX_OTP_RESENDS,
  normalizePhone,
  generateOtpCode,
  hashOtp,
  compareOtp,
  buildOtpExpiry,
  getSmsProvider,
  sendOtpUsingSmsApi
};
