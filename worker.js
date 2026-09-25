const CALLBACK_PATH = "/youtube-webhook";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const CALLBACK_HOST = "youtube-notify.pkunyt.com";
 
function topicUrl(channelId) {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}
async function subscribeToHub(env) {
  const body = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": topicUrl(env.YOUTUBE_CHANNEL_ID),
    "hub.callback": `https://${CALLBACK_HOST}${CALLBACK_PATH}`,
    "hub.lease_seconds": "432000",
    "hub.verify": "async",
    "hub.secret": env.CALLBACK_SECRET || "",
  });
 
  const res = await fetch(HUB_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
 
  return { status: res.status, ok: res.status === 202 || res.status === 204 };
}
async function verifySignature(secret, bodyText, signatureHeader) {
  if (!secret) return true; 
  if (!signatureHeader || !signatureHeader.includes("=")) return false;
  const [algo, sigHex] = signatureHeader.split("=");
  if (algo !== "sha1") return false;
 
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(bodyText));
  const computedHex = [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
 
  if (computedHex.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ sigHex.charCodeAt(i);
  }
  return diff === 0;
}
