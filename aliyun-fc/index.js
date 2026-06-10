const crypto = require("node:crypto");

const jsonHeaders = {
  "content-type": "application/json;charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization"
};

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TIERS = {
  free: { name: "免费版", maxPlanets: 3, maxPhotosPerPlanet: 80, maxTotalPhotos: 200, maxStorageMb: 100 },
  plus: { name: "Plus", maxPlanets: 10, maxPhotosPerPlanet: 200, maxTotalPhotos: 1000, maxStorageMb: 1024 },
  pro: { name: "Pro", maxPlanets: 50, maxPhotosPerPlanet: 500, maxTotalPhotos: 5000, maxStorageMb: 10240 }
};
const DEFAULT_ADMIN_CONFIG = { reviewRequired: false, defaultTier: "free" };

function json(data, statusCode = 200) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(data) };
}

function normalizeEvent(event) {
  if (Buffer.isBuffer(event)) {
    try { return JSON.parse(event.toString("utf8")); } catch { return {}; }
  }
  if (typeof event === "string") {
    try { return JSON.parse(event); } catch { return {}; }
  }
  return event || {};
}

function getBody(event) {
  event = normalizeEvent(event);
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

function getMethod(event) {
  event = normalizeEvent(event);
  return event.httpMethod || event.requestContext?.http?.method || event.requestContext?.httpMethod || event.method || "GET";
}

function getPath(event) {
  event = normalizeEvent(event);
  const rawPath = event.path || event.rawPath || event.requestContext?.http?.path || event.requestContext?.path || "/";
  const routePrefix = event.requestContext?.http?.triggerPath || event.requestContext?.triggerPath || "";
  const path = String(rawPath).replace(/^https?:\/\/[^/]+/i, "") || "/";
  if (routePrefix && path.startsWith(routePrefix)) return path.slice(routePrefix.length) || "/";
  return path;
}

function header(event, name) {
  const headers = normalizeEvent(event).headers || {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || "") : "";
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function normalizeUsername(username = "") {
  return String(username).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function safeName(name = "photo") {
  return String(name)
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "photo";
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString("hex")}`;
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, stored = "") {
  const [, salt, derived] = String(stored).split(":");
  if (!salt || !derived) return false;
  const next = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(derived, "hex"), next);
}

function publicUser(user, tiers = DEFAULT_TIERS) {
  const tier = tiers[user.tier] || tiers.free || DEFAULT_TIERS.free;
  return {
    userId: user.userId,
    username: user.username,
    status: user.status,
    tier: user.tier,
    tierConfig: tier,
    projectIds: Array.isArray(user.projectIds) ? user.projectIds : [],
    stats: user.stats || emptyStats(),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || ""
  };
}

function emptyStats() {
  return { projectCount: 0, planetCount: 0, photoCount: 0, storageBytes: 0 };
}

async function ossFetch(method, key, body = null, contentType = "application/json") {
  const bucket = env("OSS_BUCKET");
  const endpoint = env("OSS_ENDPOINT").replace(/^https?:\/\//, "");
  const accessKeyId = env("ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = env("ALIYUN_ACCESS_KEY_SECRET");
  if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) throw new Error("OSS credentials not configured");
  const resource = `/${bucket}/${key}`;
  const date = new Date().toUTCString();
  const stringToSign = [method, "", contentType, date, resource].join("\n");
  const signature = crypto.createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
  const response = await fetch(`https://${bucket}.${endpoint}/${key}`, {
    method,
    headers: {
      "Content-Type": contentType,
      "Date": date,
      "Authorization": `OSS ${accessKeyId}:${signature}`
    },
    body
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OSS ${method} failed: ${response.status} ${detail}`);
  }
  return response;
}

async function readJson(key, fallback = null) {
  try {
    const response = await ossFetch("GET", key, null, "");
    return JSON.parse(await response.text());
  } catch {
    return fallback;
  }
}

async function putJson(key, data) {
  await ossFetch("PUT", key, JSON.stringify(data));
  return data;
}

function xmlDecode(value = "") {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function publicOssUrl(key) {
  const bucket = env("OSS_BUCKET");
  const endpoint = env("OSS_ENDPOINT").replace(/^https?:\/\//, "");
  const publicDomain = env("OSS_PUBLIC_DOMAIN") || `https://${bucket}.${endpoint}`;
  return `${publicDomain.replace(/\/+$/, "")}/${key}`;
}

async function listOssKeys(prefix) {
  const bucket = env("OSS_BUCKET");
  const endpoint = env("OSS_ENDPOINT").replace(/^https?:\/\//, "");
  const accessKeyId = env("ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = env("ALIYUN_ACCESS_KEY_SECRET");
  if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) throw new Error("OSS credentials not configured");
  const keys = [];
  let marker = "";
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ prefix, "max-keys": "1000" });
    if (marker) params.set("marker", marker);
    const date = new Date().toUTCString();
    const resource = `/${bucket}/`;
    const stringToSign = ["GET", "", "", date, resource].join("\n");
    const signature = crypto.createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
    const response = await fetch(`https://${bucket}.${endpoint}/?${params.toString()}`, {
      method: "GET",
      headers: { Date: date, Authorization: `OSS ${accessKeyId}:${signature}` }
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OSS LIST failed: ${response.status} ${detail}`);
    }
    const xml = await response.text();
    keys.push(...Array.from(xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)).map((match) => xmlDecode(match[1])));
    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
    const nextMarker = xml.match(/<NextMarker>([\s\S]*?)<\/NextMarker>/i)?.[1];
    if (!truncated || !nextMarker) break;
    marker = xmlDecode(nextMarker);
  }
  return keys;
}

async function getAdminConfig() {
  return { ...DEFAULT_ADMIN_CONFIG, ...(await readJson("admin/config.json", {})) };
}

async function getTiers() {
  return { ...DEFAULT_TIERS, ...(await readJson("admin/tiers.json", {})) };
}

async function getUsersIndex() {
  return await readJson("admin/users-index.json", { users: [], updatedAt: "" });
}

async function putUsersIndex(index) {
  index.updatedAt = new Date().toISOString();
  return putJson("admin/users-index.json", index);
}

async function calcOssPhotoBytes(userId, projectId) {
  try {
    const prefix = `planets/${userId}/${projectId}/`;
    const keys = await listOssKeys(prefix);
    if (!keys.length) return 0;
    const bucket = process.env.OSS_BUCKET || "";
    const endpoint = (process.env.OSS_ENDPOINT || "").replace(/^https?:\/\//, "");
    const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID || "";
    const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET || "";
    if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) return 0;
    let totalBytes = 0;
    for (const key of keys) {
      const date = new Date().toUTCString();
      const resource = "/" + bucket + "/" + key;
      const stringToSign = ["HEAD", "", "", date, resource].join("\n");
      const signature = crypto.createHmac("sha1", accessKeySecret).update(stringToSign, "utf8").digest("base64");
      const resp = await fetch("https://" + bucket + "." + endpoint + "/" + key, {
        method: "HEAD",
        headers: { Date: date, Authorization: "OSS " + accessKeyId + ":" + signature }
      });
      if (resp.ok) {
        const size = parseInt(resp.headers.get("content-length") || "0", 10);
        if (!isNaN(size)) totalBytes += size;
      }
    }
    return totalBytes;
  } catch { return 0; }
}

async function getUser(userId) {
  return readJson(`users/${userId}.json`, null);
}

async function putUser(user) {
  user.updatedAt = new Date().toISOString();
  await putJson(`users/${user.userId}.json`, user);
  await upsertUserIndex(user);
  return user;
}

async function upsertUserIndex(user) {
  const index = await getUsersIndex();
  const summary = {
    userId: user.userId,
    username: user.username,
    status: user.status,
    tier: user.tier,
    stats: user.stats || emptyStats(),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || ""
  };
  const existing = index.users.findIndex((item) => item.userId === user.userId);
  if (existing >= 0) index.users[existing] = summary;
  else index.users.push(summary);
  index.users.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  await putUsersIndex(index);
}

function projectStats(payload = {}, ossPhotoBytes = 0) {
  const albums = [];
  if (payload.universe?.galaxies) {
    payload.universe.galaxies.forEach((galaxy) => (galaxy.albums || []).forEach((album) => albums.push(album)));
  } else if (payload.albums) {
    payload.albums.forEach((album) => albums.push(album));
  } else {
    albums.push({ photos: payload.photos || [] });
  }
  const perPlanet = albums.map((album) => (album.photos || []).length);
  const metaBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  return {
    planetCount: Math.max(1, albums.length),
    photoCount: perPlanet.reduce((sum, count) => sum + count, 0),
    maxPhotosInPlanet: perPlanet.reduce((max, count) => Math.max(max, count), 0),
    storageBytes: metaBytes + ossPhotoBytes
  };
}

function payloadAlbums(payload = {}) {
  const albums = [];
  if (payload.universe?.galaxies) {
    payload.universe.galaxies.forEach((galaxy) => (galaxy.albums || []).forEach((album) => albums.push(album)));
  } else if (payload.albums) {
    payload.albums.forEach((album) => albums.push(album));
  } else {
    albums.push(payload);
  }
  return albums;
}

function photoNameFromKey(key) {
  const file = String(key).split("/").pop() || "photo";
  return file.replace(/^[a-z0-9]+-[a-f0-9]+-/i, "").replace(/\.[^.]+$/, "") || "photo";
}

function defaultProjectPayload(projectId, userId) {
  const album = {
    id: "album-default",
    title: "我的记忆星球",
    subtitle: "科技蓝 · 星球",
    author: "",
    theme: "tech",
    shape: "sphere",
    settings: {},
    photos: [],
    updatedAt: new Date().toISOString()
  };
  return {
    version: 2,
    title: album.title,
    subtitle: album.subtitle,
    author: album.author,
    theme: album.theme,
    shape: album.shape,
    audio: { volume: 0.4, sfxEnabled: true, track: "none" },
    settings: {},
    universe: {
      title: "我的星球",
      audio: { volume: 0.4, sfxEnabled: true, track: "none" },
      activeGalaxyId: "galaxy-default",
      activeAlbumId: album.id,
      galaxies: [{ id: "galaxy-default", name: "宇宙", albums: [album] }]
    },
    exportedAt: new Date().toISOString(),
    photos: [],
    cloud: { provider: "aliyun-oss", planetId: projectId, userId }
  };
}

function appendPhotoToPayload(payload = {}, photo) {
  const clone = JSON.parse(JSON.stringify(payload || {}));
  const albums = payloadAlbums(clone);
  if (!albums.length) {
    clone.photos = [...(clone.photos || []), photo];
  } else {
    const activeId = clone.universe?.activeAlbumId || clone.activeAlbumId;
    const target = albums.find((album) => album.id === activeId) || albums[0];
    const exists = (target.photos || []).some((item) => item.url === photo.url);
    if (!exists) target.photos = [...(target.photos || []), photo];
  }
  return clone;
}

function preferAlbumWithPhotos(payload = {}) {
  if (!payload.universe?.galaxies) return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  const active = clone.universe.galaxies
    .flatMap((galaxy) => (galaxy.albums || []).map((album) => ({ galaxy, album })))
    .find((item) => item.album.id === clone.universe.activeAlbumId);
  if (active?.album?.photos?.length) return clone;
  const firstWithPhotos = clone.universe.galaxies
    .flatMap((galaxy) => (galaxy.albums || []).map((album) => ({ galaxy, album })))
    .find((item) => (item.album.photos || []).length > 0);
  if (!firstWithPhotos) return clone;
  clone.universe.activeGalaxyId = firstWithPhotos.galaxy.id;
  clone.universe.activeAlbumId = firstWithPhotos.album.id;
  clone.title = firstWithPhotos.album.title || clone.title;
  clone.subtitle = firstWithPhotos.album.subtitle || clone.subtitle;
  clone.author = firstWithPhotos.album.author || clone.author;
  clone.theme = firstWithPhotos.album.theme || clone.theme;
  clone.shape = firstWithPhotos.album.shape || clone.shape;
  clone.photos = firstWithPhotos.album.photos || [];
  return clone;
}

async function hydratePayloadPhotosFromOss(user, projectId, payload = {}) {
  if (!user?.userId || !projectId) return { payload, hydrated: false };
  const prefix = `planets/${user.userId}/${projectId}/`;
  const allKeys = (await listOssKeys(prefix))
    .filter((key) => /\.(png|jpe?g|webp|gif|avif)$/i.test(key))
    .sort();
  if (!allKeys.length) return { payload, hydrated: false };
  const ossCount = allKeys.length;
  const payloadCount = payloadAlbums(payload).reduce((sum, album) => sum + ((album.photos || []).length), 0);
  if (ossCount === payloadCount) return { payload, hydrated: false };
  const clone = JSON.parse(JSON.stringify(payload || {}));
  const albums = payloadAlbums(clone);
  const target = (() => {
    if (!albums.length) return null;
    const activeId = clone.universe?.activeAlbumId || clone.activeAlbumId;
    return albums.find((album) => album.id === activeId) || albums[0];
  })();
  const existingUrls = new Set((target?.photos || clone.photos || []).map((p) => p?.url));
  const missing = allKeys.filter((key) => !existingUrls.has(publicOssUrl(key)));
  if (!missing.length) return { payload, hydrated: false };
  const newPhotos = missing.map((key, index) => ({
    name: photoNameFromKey(key),
    url: publicOssUrl(key),
    story: "",
    date: "",
    location: "",
    favorite: false,
    index: payloadCount + index
  }));
  if (!target) {
    clone.photos = [...(clone.photos || []), ...newPhotos];
  } else {
    target.photos = [...(target.photos || []), ...newPhotos];
  }
  return { payload: clone, hydrated: true };
}

function quotaError(stats, tier, currentProjectStats = emptyStats()) {
  if (stats.planetCount > tier.maxPlanets) return `当前等级最多创建 ${tier.maxPlanets} 个星球。`;
  if (currentProjectStats.maxPhotosInPlanet > tier.maxPhotosPerPlanet) return `当前等级每颗星球最多 ${tier.maxPhotosPerPlanet} 张照片。`;
  if (stats.photoCount > tier.maxTotalPhotos) return `当前等级总照片最多 ${tier.maxTotalPhotos} 张。`;
  if (stats.storageBytes > tier.maxStorageMb * 1024 * 1024) return `当前等级总存储最多 ${tier.maxStorageMb} MB。`;
  return "";
}

async function sessionUser(event, adminRequired = false) {
  const token = header(event, "authorization").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const session = await readJson(`${adminRequired ? "admin-sessions" : "sessions"}/${hashText(token)}.json`, null);
  if (!session || Date.parse(session.expiresAt || "") < Date.now()) return null;
  if (adminRequired) return { admin: true, username: session.username };
  const user = await getUser(session.userId);
  return user || null;
}

async function requireActiveUser(event) {
  const user = await sessionUser(event);
  if (!user) return { error: json({ error: "login required" }, 401) };
  if (user.status === "pending") return { error: json({ error: "account pending review" }, 403) };
  if (user.status === "blocked") return { error: json({ error: "account blocked" }, 403) };
  return { user };
}

async function createSession(user) {
  const token = randomToken("s");
  await putJson(`sessions/${hashText(token)}.json`, {
    userId: user.userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  });
  return token;
}

async function register(body) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  if (username.length < 3) return json({ error: "用户名至少 3 位，可使用字母、数字、下划线和短横线" }, 400);
  if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);
  const exists = await readJson(`usernames/${username}.json`, null);
  if (exists?.userId) return json({ error: "用户名已存在" }, 409);
  const config = await getAdminConfig();
  const now = new Date().toISOString();
  const user = {
    userId: `u_${crypto.randomBytes(12).toString("hex")}`,
    username,
    passwordHash: passwordHash(password),
    status: config.reviewRequired ? "pending" : "active",
    tier: config.defaultTier || "free",
    projectIds: [],
    projectStats: {},
    stats: emptyStats(),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: ""
  };
  await putJson(`usernames/${username}.json`, { userId: user.userId, username, createdAt: now });
  await putUser(user);
  const token = await createSession(user);
  const tiers = await getTiers();
  return json({ ok: true, sessionToken: token, user: publicUser(user, tiers), reviewRequired: config.reviewRequired });
}

async function login(body) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const ref = await readJson(`usernames/${username}.json`, null);
  const user = ref?.userId ? await getUser(ref.userId) : null;
  if (!user || !verifyPassword(password, user.passwordHash)) return json({ error: "用户名或密码错误" }, 401);
  user.lastLoginAt = new Date().toISOString();
  await putUser(user);
  const token = await createSession(user);
  const tiers = await getTiers();
  return json({ ok: true, sessionToken: token, user: publicUser(user, tiers) });
}

async function logout(event) {
  const token = header(event, "authorization").replace(/^Bearer\s+/i, "").trim();
  if (token) {
    await putJson(`sessions/${hashText(token)}.json`, { expired: true, expiresAt: new Date(0).toISOString() });
  }
  return json({ ok: true });
}

async function changePassword(event, body) {
  const user = await sessionUser(event);
  if (!user) return json({ error: "login required" }, 401);
  const oldPassword = String(body.oldPassword || "");
  const newPassword = String(body.newPassword || "");
  if (!verifyPassword(oldPassword, user.passwordHash)) return json({ error: "原密码错误" }, 403);
  if (newPassword.length < 6) return json({ error: "新密码至少 6 位" }, 400);
  user.passwordHash = passwordHash(newPassword);
  await putUser(user);
  return json({ ok: true });
}

async function me(event) {
  const user = await sessionUser(event);
  if (!user) return json({ user: null });
  const tiers = await getTiers();
  return json({ user: publicUser(user, tiers) });
}

function adminPasswordMatches(password) {
  const configuredHash = env("ADMIN_PASSWORD_HASH");
  const configuredPassword = env("ADMIN_PASSWORD");
  if (configuredHash) return hashText(password) === configuredHash;
  if (configuredPassword) return String(password) === configuredPassword;
  return String(password) === "admin123456";
}

async function adminLogin(body) {
  const username = String(body.username || "admin").trim();
  const password = String(body.password || "");
  const configuredUser = env("ADMIN_USERNAME", "admin");
  if (username !== configuredUser || !adminPasswordMatches(password)) return json({ error: "管理员账号或密码错误" }, 401);
  const token = randomToken("a");
  await putJson(`admin-sessions/${hashText(token)}.json`, {
    username,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  });
  return json({ ok: true, adminToken: token, admin: { username } });
}

async function requireAdmin(event) {
  const admin = await sessionUser(event, true);
  return admin ? { admin } : { error: json({ error: "admin login required" }, 401) };
}

function aggregateStats(users) {
  return users.reduce((stats, user) => {
    const item = user.stats || emptyStats();
    stats.totalUsers += 1;
    if (user.status === "pending") stats.pendingUsers += 1;
    stats.totalPlanets += item.planetCount || 0;
    stats.totalPhotos += item.photoCount || 0;
    stats.totalStorageBytes += item.storageBytes || 0;
    return stats;
  }, { totalUsers: 0, pendingUsers: 0, totalPlanets: 0, totalPhotos: 0, totalStorageBytes: 0 });
}

async function getProjectRecord(id) {
  return readJson(`projects/${id}.json`, null);
}

async function writeProjectForUser(user, id, payload, stored = null, tiers = null) {
  const normalizedPayload = preferAlbumWithPhotos(payload);
  const ossBytes = await calcOssPhotoBytes(user.userId, id);
  const currentStats = projectStats(normalizedPayload, ossBytes);
  const freshUser = await getUser(user.userId) || user;
  const existingIds = Array.isArray(freshUser.projectIds) ? freshUser.projectIds : [];
  const mergedIds = existingIds.includes(id) ? existingIds : [...existingIds, id];
  const existingStats = freshUser.projectStats || {};
  existingStats[id] = currentStats;
  const allTotals = Object.values(existingStats).reduce((acc, s) => {
    acc.planetCount = Math.max(acc.planetCount, s.planetCount || 0);
    acc.photoCount += s.photoCount || 0;
    acc.storageBytes += s.storageBytes || 0;
    return acc;
  }, { planetCount: 0, photoCount: 0, storageBytes: 0 });
  allTotals.projectCount = mergedIds.length;
  await putJson(`projects/${id}.json`, {
    editToken: stored?.editToken || "",
    userId: user.userId,
    payload: { ...normalizedPayload, cloud: { provider: "aliyun-oss", planetId: id, userId: user.userId } },
    stats: currentStats,
    updatedAt: new Date().toISOString()
  });
  freshUser.projectIds = mergedIds;
  freshUser.projectStats = existingStats;
  freshUser.stats = allTotals;
  await putUser(freshUser);
  return { user: publicUser(freshUser, tiers || await getTiers()), usage: allTotals, stats: currentStats, payload: normalizedPayload };
}

async function putProject(event, id, body) {
  const auth = await requireActiveUser(event);
  if (auth.error) return auth.error;
  const { user } = auth;
  if (!body.payload) return json({ error: "missing payload" }, 400);
  const stored = await getProjectRecord(id);
  if (stored?.userId && stored.userId !== user.userId) return json({ error: "project belongs to another user" }, 403);
  if (stored?.editToken && stored.editToken !== body.editToken && !stored.userId) return json({ error: "invalid edit token" }, 403);

  const tiers = await getTiers();
  const tier = tiers[user.tier] || tiers.free || DEFAULT_TIERS.free;
  const hydrated = await hydratePayloadPhotosFromOss(user, id, body.payload);
  const payload = hydrated.payload;
  const ossBytes = await calcOssPhotoBytes(user.userId, id);
  const currentStats = projectStats(payload, ossBytes);
  const totals = {
    projectCount: 1,
    planetCount: currentStats.planetCount || 0,
    photoCount: currentStats.photoCount || 0,
    storageBytes: currentStats.storageBytes || 0
  };
  const error = quotaError(totals, tier, currentStats);
  if (error) return json({ error, quota: tier, usage: totals }, 403);

  const result = await writeProjectForUser(user, id, payload, { ...stored, editToken: body.editToken || stored?.editToken || "" }, tiers);
  return json({ ok: true, user: result.user, usage: result.usage, quota: tier, hydrated: hydrated.hydrated });
}

async function getProject(event, id) {
  const stored = await getProjectRecord(id);
  if (!stored) return json({ error: "project not found" }, 404);
  const user = await sessionUser(event).catch(() => null);
  const owner = user?.userId && stored.userId === user.userId;
  let payload = preferAlbumWithPhotos(stored.payload);
  let hydrated = false;
  const projectUser = owner ? user : (stored.userId ? await getUser(stored.userId) : null);
  if (projectUser) {
    const result = await hydratePayloadPhotosFromOss(projectUser, id, stored.payload);
    payload = preferAlbumWithPhotos(result.payload);
    hydrated = result.hydrated;
    if (hydrated) {
      await writeProjectForUser(projectUser, id, payload, stored);
    }
  }
  return json({
    payload,
    updatedAt: stored.updatedAt,
    userId: stored.userId || "",
    editToken: owner ? (stored.editToken || "") : "",
    hydrated
  });
}

function ossPostPolicy(key) {
  const bucket = env("OSS_BUCKET");
  const endpoint = env("OSS_ENDPOINT").replace(/^https?:\/\//, "");
  const publicDomain = env("OSS_PUBLIC_DOMAIN") || `https://${bucket}.${endpoint}`;
  const accessKeyId = env("ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = env("ALIYUN_ACCESS_KEY_SECRET");
  const expiration = new Date(Date.now() + 3600 * 1000).toISOString();
  const policy = Buffer.from(JSON.stringify({
    expiration,
    conditions: [
      ["content-length-range", 0, 20 * 1024 * 1024],
      ["starts-with", "$key", key.split("/").slice(0, 2).join("/") + "/"]
    ]
  })).toString("base64");
  const signature = crypto.createHmac("sha1", accessKeySecret).update(policy).digest("base64");
  return {
    key,
    uploadUrl: `https://${bucket}.${endpoint}`,
    publicUrl: `${publicDomain.replace(/\/+$/, "")}/${key}`,
    fields: { key, policy, OSSAccessKeyId: accessKeyId, Signature: signature, success_action_status: "200" }
  };
}

async function uploadToken(event, body) {
  const auth = await requireActiveUser(event);
  if (auth.error) return auth.error;
  const { user } = auth;
  const planetId = String(body.planetId || "").trim();
  if (!planetId) return json({ error: "missing planetId" }, 400);
  const stored = await getProjectRecord(planetId);
  if (stored?.userId && stored.userId !== user.userId) return json({ error: "project belongs to another user" }, 403);
  const tiers = await getTiers();
  const tier = tiers[user.tier] || tiers.free || DEFAULT_TIERS.free;
  const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const key = `planets/${user.userId}/${planetId}/${suffix}-${safeName(body.filename)}`;
  const ticket = ossPostPolicy(key);
  const basePayload = stored?.payload || defaultProjectPayload(planetId, user.userId);
  const hydrated = await hydratePayloadPhotosFromOss(user, planetId, basePayload);
  const photo = {
    name: photoNameFromKey(key),
    url: ticket.publicUrl,
    story: "",
    date: "",
    location: "",
    favorite: false
  };
  const payload = appendPhotoToPayload(hydrated.payload, photo);
  const ossBytes = await calcOssPhotoBytes(user.userId, planetId);
  const currentStats = projectStats(payload, ossBytes);
  const totals = {
    projectCount: 1,
    planetCount: currentStats.planetCount || 0,
    photoCount: currentStats.photoCount || 0,
    storageBytes: currentStats.storageBytes || 0
  };
  const error = quotaError(totals, tier, currentStats);
  if (error) return json({ error, quota: tier, usage: totals }, 403);
  await writeProjectForUser(user, planetId, payload, { ...stored, editToken: body.editToken || stored?.editToken || "" }, tiers);
  return json(ticket);
}

async function setupBucketCors() {
  const bucket = env("OSS_BUCKET");
  const endpoint = env("OSS_ENDPOINT").replace(/^https?:\/\//, "");
  const accessKeyId = env("ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = env("ALIYUN_ACCESS_KEY_SECRET");
  if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) throw new Error("OSS credentials not configured");
  const corsXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<CORSConfiguration><CORSRule>",
    "<AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedMethod>POST</AllowedMethod>",
    "<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>x-oss-request-id</ExposeHeader>",
    "<MaxAgeSeconds>3600</MaxAgeSeconds>",
    "</CORSRule></CORSConfiguration>"
  ].join("");
  const md5 = crypto.createHash("md5").update(corsXml, "utf8").digest("base64");
  const date = new Date().toUTCString();
  const resource = "/" + bucket + "/?cors";
  const stringToSign = ["PUT", md5, "application/xml", date, resource].join("\n");
  const signature = crypto.createHmac("sha1", accessKeySecret).update(stringToSign, "utf8").digest("base64");
  const response = await fetch("https://" + bucket + "." + endpoint + "/?cors", {
    method: "PUT",
    headers: { "Content-Type": "application/xml", "Content-MD5": md5, "Date": date, "Authorization": "OSS " + accessKeyId + ":" + signature },
    body: corsXml
  });
  if (!response.ok) throw new Error("CORS setup failed: " + response.status + " " + await response.text());
}

exports.handler = async function handler(event) {
  event = normalizeEvent(event);
  const method = getMethod(event);
  const path = getPath(event);
  if (method === "OPTIONS") return { statusCode: 204, headers: jsonHeaders, body: "" };

  try {
    if (path === "/setup/cors" && method === "GET") {
      await setupBucketCors();
      return json({ ok: true, message: "OSS bucket CORS configured successfully" });
    }
    if (path === "/auth/register" && method === "POST") return register(getBody(event));
    if (path === "/auth/login" && method === "POST") return login(getBody(event));
    if (path === "/auth/me" && method === "GET") return me(event);
    if (path === "/auth/logout" && method === "POST") return logout(event);
    if (path === "/auth/password" && method === "PUT") return changePassword(event, getBody(event));
    if (path === "/admin/login" && method === "POST") return adminLogin(getBody(event));

    if (path.startsWith("/admin/")) {
      const auth = await requireAdmin(event);
      if (auth.error) return auth.error;
      if (path === "/admin/me" && method === "GET") return json({ admin: auth.admin });
      if (path === "/admin/stats" && method === "GET") {
        const index = await getUsersIndex();
        return json({ stats: aggregateStats(index.users || []) });
      }
      if (path === "/admin/users" && method === "GET") {
        const index = await getUsersIndex();
        return json({ users: index.users || [], stats: aggregateStats(index.users || []) });
      }
      if (path === "/admin/config" && method === "GET") return json({ config: await getAdminConfig() });
      if (path === "/admin/config" && method === "PUT") {
        const body = getBody(event);
        const config = { ...DEFAULT_ADMIN_CONFIG, reviewRequired: Boolean(body.reviewRequired), defaultTier: body.defaultTier || "free" };
        await putJson("admin/config.json", config);
        return json({ ok: true, config });
      }
      if (path === "/admin/tiers" && method === "GET") return json({ tiers: await getTiers() });
      if (path === "/admin/tiers" && method === "PUT") {
        const tiers = { ...DEFAULT_TIERS, ...(getBody(event).tiers || {}) };
        await putJson("admin/tiers.json", tiers);
        return json({ ok: true, tiers });
      }
      const clearMatch = path.match(/^\/admin\/users\/([^/]+)\/clear$/);
      if (clearMatch && method === "POST") {
        const userId = decodeURIComponent(clearMatch[1]);
        const user = await getUser(userId);
        if (!user) return json({ error: "user not found" }, 404);
        const userPrefix = "planets/" + userId + "/";
        const allKeys = await listOssKeys(userPrefix);
        let deletedPhotos = 0;
        for (const key of allKeys) {
          try { await deleteOssKey(key); deletedPhotos++; } catch {}
        }
        const projectIds = Array.isArray(user.projectIds) ? user.projectIds : [];
        let deletedProjects = 0;
        for (const pid of projectIds) {
          try { await deleteOssKey("projects/" + pid + ".json"); deletedProjects++; } catch {}
        }
        user.projectIds = [];
        user.projectStats = {};
        user.stats = { projectCount: 0, planetCount: 0, photoCount: 0, storageBytes: 0 };
        await putUser(user);
        return json({ ok: true, message: "已清除用户 " + user.username + " 的数据", deleted: { photos: deletedPhotos, projects: deletedProjects } });
      }

      const userMatch = path.match(/^\/admin\/users\/([^/]+)$/);
      if (userMatch && method === "PUT") {
        const user = await getUser(decodeURIComponent(userMatch[1]));
        if (!user) return json({ error: "user not found" }, 404);
        const body = getBody(event);
        if (body.resetPassword) user.passwordHash = passwordHash("123456");
        if (["pending", "active", "blocked"].includes(body.status)) user.status = body.status;
        if (body.tier) user.tier = String(body.tier);
        await putUser(user);
        return json({ ok: true, user: publicUser(user, await getTiers()), temporaryPassword: body.resetPassword ? "123456" : "" });
      }
    }

    if (path === "/admin/reconcile" && method === "GET") {
      const adminCheck = await requireAdmin(event);
      if (adminCheck.error) return adminCheck.error;
      const projectKeys = (await listOssKeys("projects/")).filter((k) => k.endsWith(".json"));
      const userIdMap = {};
      for (const key of projectKeys) {
        const projectId = key.replace("projects/", "").replace(".json", "");
        const stored = await readJson(key, null);
        if (!stored || !stored.userId) continue;
        if (!userIdMap[stored.userId]) userIdMap[stored.userId] = [];
        userIdMap[stored.userId].push({ projectId, stored });
      }
      const results = { reconciledUsers: 0, fixedProjects: 0, errors: [] };
      for (const [userId, projects] of Object.entries(userIdMap)) {
        try {
          const user = await getUser(userId);
          if (!user) continue;
          const projectIds = [];
          const projectStatsAll = {};
          const tot = { planetCount: 0, photoCount: 0, storageBytes: 0 };
          for (const { projectId, stored } of projects) {
            const ossBytes = await calcOssPhotoBytes(userId, projectId);
            const stats = projectStats(stored.payload || {}, ossBytes);
            projectIds.push(projectId);
            projectStatsAll[projectId] = stats;
            tot.planetCount = Math.max(tot.planetCount, stats.planetCount);
            tot.photoCount += stats.photoCount;
            tot.storageBytes += stats.storageBytes;
          }
          tot.projectCount = projectIds.length;
          user.projectIds = projectIds;
          user.projectStats = projectStatsAll;
          user.stats = tot;
          await putUser(user);
          results.reconciledUsers++;
          results.fixedProjects += projectIds.length;
        } catch (e) {
          results.errors.push(userId + ": " + e.message);
        }
      }
      return json({ ok: true, ...results });
    }

    if (path === "/uploads/token" && method === "POST") return uploadToken(event, getBody(event));

    const match = path.match(/^\/projects\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (method === "GET") return getProject(event, id);
      if (method === "PUT") return putProject(event, id, getBody(event));
    }

    return json({ error: "not found", method, path }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error.message || "server error" }, 500);
  }
};
