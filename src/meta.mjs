import { openToken } from './tokens.mjs';

// Minimal Instagram API client.
// host = 'graph.facebook.com'  -> Unified Login (system user token, the one we use)
// host = 'graph.instagram.com' -> Instagram Login (older apps, Instagram token)
const VERSION = process.env.GRAPH_VERSION || 'v27.0';
export const DEFAULT_HOST = 'graph.facebook.com';

export async function call(host, method, path, token, body) {
  if (host !== DEFAULT_HOST && host !== 'graph.instagram.com') throw new Error('Unexpected Meta API host');
  const res = await fetch(`https://${host}/${VERSION}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${openToken(token)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(e.message || `HTTP ${res.status}`);
    err.code = e.code; err.subcode = e.error_subcode; err.status = res.status;
    throw err;
  }
  return json;
}

// Instagram account data (username) from its ID.
export const getAccount = (host, token, igId) => call(host, 'GET', `/${igId}?fields=id,username,name`, token);

// Instagram Login only: /me returns the token's account.
export const getMe = async (host, token) => {
  const r = await call(host, 'GET', '/me?fields=user_id,username,name,account_type', token);
  return Array.isArray(r.data) ? r.data[0] : r;
};

export const listMedia = (host, token, igId) =>
  call(host, 'GET', `/${igId}/media?fields=id,caption,media_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count&limit=24`, token);

// Followers and number of posts of the account (needs no extra permissions)
export const getAccountStats = (host, token, igId) => call(host, 'GET', `/${igId}?fields=followers_count,media_count`, token);

// One specific post or reel (to know its publish time and link)
export const getMedia = (host, token, mediaId) =>
  call(host, 'GET', `/${mediaId}?fields=id,caption,media_type,permalink,timestamp,thumbnail_url,media_url`, token);

// Top-level comments of a post/reel (replies to comments are not returned here).
// `after` is the next page cursor (paging.cursors.after).
export const listComments = (host, token, mediaId, limit = 50, after = null) =>
  call(host, 'GET', `/${mediaId}/comments?fields=id,text,username,timestamp,from&limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`, token);

export const getComment = (host, token, commentId) =>
  call(host, 'GET', `/${encodeURIComponent(commentId)}?fields=timestamp`, token);

// ---- Direct messages (for email capture) ----
const MSG_FIELDS = 'id,updated_time,messages.limit(8){id,created_time,from,message}';
// Most recent conversations with their latest messages (1 call covers everyone waiting)
export const listConversations = (host, token, igId, limit = 30) =>
  call(host, 'GET', `/${igId}/conversations?platform=instagram&fields=${MSG_FIELDS}&limit=${limit}`, token);
// The conversation with one specific person (for those missing from the recent list)
export const conversationByUser = (host, token, igId, igsid) =>
  call(host, 'GET', `/${igId}/conversations?platform=instagram&user_id=${encodeURIComponent(igsid)}&fields=${MSG_FIELDS}`, token);
// Insights (instagram_manage_insights permission). They return {metric: value}; whatever Meta does not give for that post type is omitted.
const flat = (r) => Object.fromEntries((r.data || []).map((d) => [d.name, d.total_value?.value ?? d.values?.[0]?.value ?? null]));
export const getMediaInsights = async (host, token, mediaId) => {
  try { return flat(await call(host, 'GET', `/${mediaId}/insights?metric=views,reach,saved,shares,total_interactions,ig_reels_avg_watch_time`, token)); }
  catch (e) { return flat(await call(host, 'GET', `/${mediaId}/insights?metric=views,reach,saved,shares,total_interactions`, token)); } // photos and carousels have no watch time
};
export const getAccountInsights = async (host, token, igId) =>
  flat(await call(host, 'GET', `/${igId}/insights?metric=reach,views,accounts_engaged&period=day&metric_type=total_value`, token));
// Regular message to a person. Only allowed within 24 h of their last message.
export const sendText = (host, token, igId, recipientId, text) =>
  call(host, 'POST', `/${igId}/messages`, token, { recipient: { id: recipientId }, message: { text } });
export const sendButton = (host, token, igId, recipientId, text, title, url) =>
  call(host, 'POST', `/${igId}/messages`, token, {
    recipient: { id: recipientId },
    message: { attachment: { type: 'template', payload: { template_type: 'button', text: text.slice(0, 640), buttons: [{ type: 'web_url', url, title: title.slice(0, 20) }] } } },
  });

export const subscribeWebhooks = (host, token, igId) =>
  call(host, 'POST', `/${igId}/subscribed_apps?subscribed_fields=comments,messages`, token);

export const replyToComment = (host, token, commentId, message) =>
  call(host, 'POST', `/${commentId}/replies`, token, { message });

// Private reply: a single DM per comment, within 7 days of the comment.
export const privateReplyText = (host, token, igUserId, commentId, text) =>
  call(host, 'POST', `/${igUserId}/messages`, token, { recipient: { comment_id: commentId }, message: { text } });

export const privateReplyButton = (host, token, igUserId, commentId, text, title, url) =>
  call(host, 'POST', `/${igUserId}/messages`, token, {
    recipient: { comment_id: commentId },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: text.slice(0, 640),
          buttons: [{ type: 'web_url', url, title: title.slice(0, 20) }],
        },
      },
    },
  });
