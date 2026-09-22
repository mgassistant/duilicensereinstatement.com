// Vercel serverless function: receives a lead from the duilicensereinstatement.com
// intake form and (1) forwards it to BrokerIQ and (2) emails the agency, mirroring
// how the other funnel sites handle leads.
//
// Config (Vercel env vars):
//   BROKERIQ_URL         - defaults to the BrokerIQ inbound endpoint
//   BROKERIQ_TENANT_ID   - defaults to the DUI-Help tenant; override in Vercel
//   RESEND_API_KEY       - Resend key for the notification email
//   LEAD_NOTIFY_TO       - recipient(s), comma-separated
//   LEAD_NOTIFY_FROM     - from address (verified Resend sender)
//
// Fail-open: never blocks the visitor — always returns { ok: true } even if a
// downstream (BrokerIQ / Resend) call fails; errors are logged server-side.

const BROKERIQ_URL = process.env.BROKERIQ_URL || "https://www.broker-iq.com/api/leads/inbound";
// Defaults to the DUI-Help BrokerIQ tenant so DUI leads route to DUI auto-contact.
const BROKERIQ_TENANT_ID = process.env.BROKERIQ_TENANT_ID || "6db07734-dd08-49ff-9a23-2e5c5f9fb46a";
const RESEND_API_KEY = *** || "";
const NOTIFY_TO = process.env.LEAD_NOTIFY_TO || "";
const NOTIFY_FROM = process.env.LEAD_NOTIFY_FROM || "DUI License Reinstatement <support@duilicensereinstatement.com>";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

async function forwardToBrokerIQ(lead) {
  try {
    const res = await fetch(BROKERIQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
    return res.ok;
  } catch (err) {
    console.error("BrokerIQ forward failed:", err);
    return false;
  }
}

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY || !NOTIFY_TO) return false; // not configured — skip silently
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ***}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: NOTIFY_TO.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        html,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Lead email notification failed:", err);
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const b = await readBody(req);
  const firstName = String(b.first_name || b.firstName || "").trim();
  const lastName = String(b.last_name || b.lastName || "").trim();
  const name = `${firstName} ${lastName}`.trim();
  const email = String(b.email || "").trim();
  const phone = String(b.phone || "").trim();
  const notes = String(b.notes || b.message || b.details || "").trim();

  // Any additional intake fields the form collects (hearing date, county, etc.).
  const known = new Set(["first_name", "firstName", "last_name", "lastName", "email", "phone", "notes", "message", "details"]);
  const details = {};
  for (const [k, v] of Object.entries(b)) {
    if (!known.has(k) && v != null && v !== "") details[k] = v;
  }
  const detailLines = Object.entries(details)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");

  const lead = {
    source: "duilicensereinstatement.com",
    tenant_id: BROKERIQ_TENANT_ID,
    lead_type: "dui_license_reinstatement",
    name,
    email,
    phone,
    message: [notes, detailLines].filter(Boolean).join("\n\n"),
    lead_status: (b.partial === true || b.partial === "true") ? "partial" : "complete",
    partial: (b.partial === true || b.partial === "true"),
    ...details,
  };

  await Promise.allSettled([
    forwardToBrokerIQ(lead),
    sendEmail(
      `${(b.partial===true||b.partial==="true") ? "[PARTIAL LEAD] " : ""}New DUI License Reinstatement lead: ${name || email || phone || "(no name)"}`,
      `<h2>${(b.partial===true||b.partial==="true") ? "[PARTIAL — form not completed] " : ""}New DUI License Reinstatement lead</h2>
       <p><b>Name:</b> ${esc(name)}</p>
       <p><b>Email:</b> ${esc(email)}</p>
       <p><b>Phone:</b> ${esc(phone)}</p>
       ${detailLines ? `<p><b>Details:</b></p><pre>${esc(detailLines)}</pre>` : ""}
       ${notes ? `<p><b>Notes:</b> ${esc(notes)}</p>` : ""}
       <p style="color:#888">Source: duilicensereinstatement.com</p>`
    ),
  ]);

  return res.status(200).json({ ok: true });
}
