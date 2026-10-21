/**
 * 専属BOT (Cloudflare Worker / 作り直し版)
 * YouTubeのWebSub(PubSubHubbub)通知を受信 → Discord Webhookへ @everyone 付きで通知
 *
 * 必要な設定:
 *   YOUTUBE_CHANNEL_ID   (wrangler.toml の vars)
 *   DISCORD_WEBHOOK_URL  (secret)
 *   CALLBACK_SECRET      (secret)
 *   SEEN_VIDEOS          (KV binding)
 */

const CALLBACK_PATH = "/youtube-webhook";
const CALLBACK_HOST = "api.naokun.pkunyt.com";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const MENTION_ROLE_ID = "1558400772784525362"; // 通知でメンションするDiscordロール

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// ---- WebSub購読 ----
async function subscribeToHub(env) {
  const body = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${env.YOUTUBE_CHANNEL_ID}`,
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
  console.log(`hub subscribe: status=${res.status}`);
  return { status: res.status, ok: res.status === 202 || res.status === 204 };
}

// ---- 署名検証 (HMAC-SHA1) ----
async function verifySignature(secret, bodyText, header) {
  if (!secret) return true;
  if (!header || !header.startsWith("sha1=")) return false;
  const sigHex = header.slice(5);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, enc.encode(bodyText));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}

// ---- Atom XML解析 ----
const pick = (s, re) => (s.match(re) || [])[1];

function extractEntries(xml) {
  return (xml.match(/<entry>[\s\S]*?<\/entry>/g) || [])
    .map((b) => ({
      videoId: pick(b, /<yt:videoId>([^<]+)<\/yt:videoId>/),
      title: pick(b, /<title>([^<]*)<\/title>/) || "(タイトル不明)",
      author: pick(b, /<author>\s*<name>([^<]*)<\/name>/) || "チャンネル",
      published: pick(b, /<published>([^<]+)<\/published>/),
      updated: pick(b, /<updated>([^<]+)<\/updated>/),
    }))
    .filter((e) => e.videoId);
}

// タイトル編集などの「更新」通知を新規投稿と誤判定しない
function isNewUpload(e) {
  const pub = Date.parse(e.published);
  const upd = Date.parse(e.updated);
  if (Number.isNaN(pub) || Number.isNaN(upd)) return true;
  return Math.abs(upd - pub) <= 10 * 60 * 1000;
}

// ---- Discord送信 (成功したかどうかを返す) ----
async function notifyDiscord(env, e) {
  const content =
    `<@&${MENTION_ROLE_ID}> 📢 **${e.author}** が新しい動画を投稿しました!\n` +
    `**${e.title}**\nhttps://www.youtube.com/watch?v=${e.videoId}`;

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { roles: [MENTION_ROLE_ID] } }),
  });
  const text = await res.text();
  console.log(`discord webhook: status=${res.status} body=${text.slice(0, 300)}`);
  return res.ok;
}

// 重複防止しつつ送信。失敗したら記録を消して次回再試行できるようにする
async function processEntry(env, e) {
  const key = `seen:${e.videoId}`;
  if (await env.SEEN_VIDEOS.get(key)) {
    console.log(`skip (already seen): ${e.videoId}`);
    return;
  }
  await env.SEEN_VIDEOS.put(key, "1", { expirationTtl: 60 * 60 * 24 });
  let ok = false;
  try {
    ok = await notifyDiscord(env, e);
  } catch (err) {
    console.log(`discord webhook exception: ${err}`);
  }
  if (!ok) await env.SEEN_VIDEOS.delete(key);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 管理用エンドポイント (CALLBACK_SECRETをkeyに要求)
    const authed = url.searchParams.get("key") === env.CALLBACK_SECRET && !!env.CALLBACK_SECRET;

    if (url.pathname === "/subscribe-now" && authed) {
      return json(await subscribeToHub(env));
    }

    // Discord送信だけを単体テスト
    if (url.pathname === "/test-notify" && authed) {
      const ok = await notifyDiscord(env, {
        videoId: "aDs2dSJbzws",
        title: "(テスト通知)",
        author: "テストチャンネル",
      });
      return json({ sent: ok });
    }

    if (url.pathname !== CALLBACK_PATH) return new Response("Not Found", { status: 404 });

    // WebSub 購読検証
    if (request.method === "GET") {
      const challenge = url.searchParams.get("hub.challenge");
      return challenge
        ? new Response(challenge, { status: 200 })
        : new Response("Bad Request", { status: 400 });
    }

    // 新着通知
    if (request.method === "POST") {
      const body = await request.text();
      const ok = await verifySignature(env.CALLBACK_SECRET, body, request.headers.get("X-Hub-Signature"));
      if (!ok) {
        console.log("invalid signature");
        return new Response("Forbidden", { status: 403 });
      }
      const entries = extractEntries(body);
      console.log(`webhook received: entries=${entries.length}`);
      for (const e of entries) {
        if (!isNewUpload(e)) {
          console.log(`skip (update only): ${e.videoId}`);
          continue;
        }
        ctx.waitUntil(processEntry(env, e));
      }
      return new Response(null, { status: 204 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },

  // 4日ごとに自動で再購読
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(subscribeToHub(env));
  },
};
