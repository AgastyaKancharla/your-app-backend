const express = require("express")

const { handleWebhook, verifyWebhook } = require("../controllers/webhookController")

const router = express.Router()

const buildBodyPreview = (body) => {
  try {
    const serialized = JSON.stringify(body)
    if (serialized.length <= 4000) {
      return serialized
    }

    return serialized.slice(0, 4000) + "...(truncated)"
  } catch {
    return "[unserializable body]"
  }
}

router.use((req, _res, next) => {
  console.log("[whatsapp] incoming webhook request", {
    method: req.method,
    path: req.originalUrl,
    queryKeys: Object.keys(req.query || {}),
    bodyPreview: req.method === "POST" ? buildBodyPreview(req.body) : undefined
  })
  next()
})

router.get("/", verifyWebhook)
router.post("/", handleWebhook)

module.exports = router
