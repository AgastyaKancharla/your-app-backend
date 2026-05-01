const assert = require("node:assert/strict")
const test = require("node:test")

const { buildGuestName } = require("../services/customerService")
const { parseOrderMessage } = require("../services/orderService")
const { extractInboundMessages } = require("../services/whatsappService")

test("buildGuestName uses the last four digits of the phone number", () => {
  assert.equal(buildGuestName("+919876543210"), "Customer_3210")
})

test("parseOrderMessage detects simple WhatsApp order syntax", () => {
  assert.deepEqual(parseOrderMessage("Biryani 2"), {
    itemName: "Biryani",
    quantity: 2
  })

  assert.deepEqual(parseOrderMessage("ORDER Chicken Biryani 3"), {
    itemName: "Chicken Biryani",
    quantity: 3
  })

  assert.equal(parseOrderMessage("hello"), null)
})

test("extractInboundMessages reads Meta webhook payloads", () => {
  const payload = {
    entry: [
      {
        id: "entry-1",
        changes: [
          {
            value: {
              metadata: {
                phone_number_id: "123456789"
              },
              contacts: [
                {
                  wa_id: "919876543210",
                  profile: {
                    name: "Ravi"
                  }
                }
              ],
              messages: [
                {
                  id: "wamid.1",
                  from: "919876543210",
                  type: "text",
                  text: {
                    body: "Hi"
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  }

  const messages = extractInboundMessages(payload)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].phone, "919876543210")
  assert.equal(messages[0].name, "Ravi")
  assert.equal(messages[0].text, "Hi")
  assert.equal(messages[0].isText, true)
})
