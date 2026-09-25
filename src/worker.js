/**
 * 専属BOT (Cloudflare Worker版)
 * - YouTubeのPubSubHubbub(WebSub)通知を受信し、新着動画をDiscord Webhookへ
 *   @everyone付きで通知する。
 * - discord.pyのようなBotプロセスは使わない。常時稼働サーバー不要。
 *
 * 必要な設定 (wrangler.toml の [vars] と wrangler secret):
 *   YOUTUBE_CHANNEL_ID   監視対象のYouTubeチャンネルID (vars, 非シークレット)
 *   DISCORD_WEBHOOK_URL  通知先DiscordチャンネルのWebhook URL (secret)
 *   CALLBACK_SECRET      WebSubの署名検証用シークレット (secret)
 *   SEEN_VIDEOS          KV Namespace binding (重複通知防止)
 *
 * デプロイ後のURL構成:
 *   https://<worker-url または youtube-notify.pkunyt.com>/youtube-webhook
 */

const CALLBACK_PATH = "/naokun";
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const CALLBACK_HOST = "api.naokun.pkunyt.com";

function topicUrl(channelId) {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

// ---- WebSub購読リクエスト ----
async function subscribeToHub(env) {
  const body = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": topicUrl(env.YOUTUBE_CHANNEL_ID),
    "hub.callback": `https://${CALLBACK_HOST}${CALLBACK_PATH}`,
    "hub.lease_seconds": "432000", // 5日
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

// ---- 署名検証 (HMAC-SHA1) ----
async function verifySignature(secret, bodyText, signatureHeader) {
  if (!secret) return true; // シークレット未設定なら検証スキップ
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

// ---- Atom XMLから動画情報を抽出(正規表現。Workersに標準XMLパーサが無いため) ----
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
  // タイトル編集など「更新」通知を新規投稿と誤検知しないよう、
  // published と updated の差が10分以上ある場合は除外する
  if (!entry.published || !entry.updated) return true;
  const pub = Date.parse(entry.published);
  const upd = Date.parse(entry.updated);
  if (Number.isNaN(pub) || Number.isNaN(upd)) return true;
  return Math.abs(upd - pub) <= 10 * 60 * 1000;
}

async function notifyDiscord(env, entry) {
  const url = `https://www.youtube.com/watch?v=${entry.videoId}`;
  const content = `@everyone 📢 **${entry.author}** が新しい動画を投稿しました!\n**${entry.title}**\n${url}`;

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
      // 【デバッグ用・後で削除】envに実際にバインドされているキー名の一覧(値は表示しない)
      if (url.pathname === "/debug-env") {
        return new Response(JSON.stringify({ keys: Object.keys(env).sort() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // 【デバッグ用・後で削除】CALLBACK_SECRETの長さだけを確認する(値そのものは表示しない)
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

      // 手動での再購読トリガー(デバッグ用途)。CALLBACK_SECRETをkeyクエリで要求
      if (url.pathname === "/subscribe-now" && url.searchParams.get("key") === env.CALLBACK_SECRET) {
        const result = await subscribeToHub(env);
        return new Response(JSON.stringify(result), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }

    // --- GET: YouTube(Google)からの購読検証 ---
    if (request.method === "GET") {
      const challenge = url.searchParams.get("hub.challenge");
      if (challenge) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Bad Request", { status: 400 });
    }

    // --- POST: 新着動画の通知 ---
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

        // 24時間TTLで記録(WebSub通知の再送対策として十分な長さ)
        await env.SEEN_VIDEOS.put(seenKey, "1", { expirationTtl: 60 * 60 * 24 });

        ctx.waitUntil(notifyDiscord(env, entry));
      }

      return new Response("", { status: 204 });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },

  // 5日のリース期限が切れる前に自動再購読(4日ごと)
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(subscribeToHub(env));
  },
};
