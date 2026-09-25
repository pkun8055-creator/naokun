const CALLBACK_PATH = "/youtube-webhook";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const CALLBACK_HOST = "api.naokun.pkunyt.com";

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

function extractEntries(xmlText) {
  const entries = [];
  const entryBlocks = xmlText.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  for (const block of entryBlocks) {
    const videoId = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (block.match(/<title>([^<]*)<\/title>/) || [])[1];
    const author = (block.match(/<author>\s*<name>([^<]*)<\/name>/) || [])[1];
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1];
    const updated = (block.match(/<updated>([^<]+)<\/updated>/) || [])[1];

    if (!videoId) continue;

    entries.push({
      videoId,
      title: title || "(タイトル不明)",
      author: author || "チャンネル",
      published,
      updated,
    });
  }
  return entries;
}

function isNewUpload(entry) {
  if (!entry.published || !entry.updated) return true;
  const pub = Date.parse(entry.published);
  const upd = Date.parse(entry.updated);
  if (Number.isNaN(pub) || Number.isNaN(upd)) return true;
  return Math.abs(upd - pub) <= 10 * 60 * 1000;
}

async function notifyDiscord(env, entry) {
  const url = `https://www.youtube.com/watch?v=${entry.videoId}`;
  const content = `@everyone 📢naokun01が新しい動画を投稿したらしいよ!!!\n**${entry.title}**\n${url}\n-# ぴーより`;

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: ["everyone"] },
    }),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== CALLBACK_PATH) {
      if (url.pathname === "/debug-env") {
        return new Response(JSON.stringify({ keys: Object.keys(env).sort() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/debug-secret") {
        const val = env.CALLBACK_SECRET || "";
        return new Response(
          JSON.stringify({
            length: val.length,
            first_char: val.slice(0, 1),
            last_char: val.slice(-1),
            has_leading_space: val !== val.trimStart(),
            has_trailing_space: val !== val.trimEnd(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/subscribe-now" && url.searchParams.get("key") === env.CALLBACK_SECRET) {
        const result = await subscribeToHub(env);
        return new Response(JSON.stringify(result), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }
    if (request.method === "GET") {
      const challenge = url.searchParams.get("hub.challenge");
      if (challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Bad Request", { status: 400 });
    }

    if (request.method === "POST") {
      const bodyText = await request.text();
      const signature = request.headers.get("X-Hub-Signature") || "";

      const valid = await verifySignature(env.CALLBACK_SECRET, bodyText, signature);
      if (!valid) {
        return new Response("Forbidden", { status: 403 });
      }

      const entries = extractEntries(bodyText);

      for (const entry of entries) {
        if (!isNewUpload(entry)) continue;

        const seenKey = `seen:${entry.videoId}`;
        const alreadySeen = await env.SEEN_VIDEOS.get(seenKey);
        if (alreadySeen) continue;

        await env.SEEN_VIDEOS.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 });

        ctx.waitUntil(notifyDiscord(env, entry));
      }

      return new Response("", { status: 204 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(subscribeToHub(env));
  },
};
