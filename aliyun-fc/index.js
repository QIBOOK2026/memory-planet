const crypto = require("node:crypto");

const jsonHeaders = {
  "content-type": "application/json;charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

function json(data, statusCode = 200) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(data)
  };
}

function safeName(name = "photo") {
  return String(name)
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "photo";
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function getBody(event) {
  event = normalizeEvent(event);
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
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

function getMethod(event) {
  event = normalizeEvent(event);
  return event.httpMethod
    || event.requestContext?.http?.method
    || event.requestContext?.httpMethod
    || event.method
    || "GET";
}

function getPath(event) {
  event = normalizeEvent(event);
  const rawPath = event.path
    || event.rawPath
    || event.requestContext?.http?.path
    || event.requestContext?.path
    || "/";
  const routePrefix = event.requestContext?.http?.triggerPath || event.requestContext?.triggerPath || "";
  const path = String(rawPath).replace(/^https?:\/\/[^/]+/i, "") || "/";
  if (routePrefix && path.startsWith(routePrefix)) {
    return path.slice(routePrefix.length) || "/";
  }
  return path;
}

async function ossFetch(method, key, body = null, contentType = "application/json") {
  const bucket = env("OSS_BUCKET");
  const endpoint = env("OSS_ENDPOINT").replace(/^https?:\/\//, "");
  const accessKeyId = env("ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = env("ALIYUN_ACCESS_KEY_SECRET");
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

async function getProjectRecord(id) {
  const response = await ossFetch("GET", `projects/${id}.json`, null, "");
  return JSON.parse(await response.text());
}

async function putProject(id, payload, editToken) {
  const stored = await getProjectRecord(id).catch(() => null);
  if (stored?.editToken && stored.editToken !== editToken) {
    return json({ error: "invalid edit token" }, 403);
  }
  await ossFetch("PUT", `projects/${id}.json`, JSON.stringify({
    editToken,
    payload,
    updatedAt: new Date().toISOString()
  }));
  return json({ ok: true });
}

async function getProject(id) {
  try {
    const stored = await getProjectRecord(id);
    return json({ payload: stored.payload, updatedAt: stored.updatedAt });
  } catch {
    return json({ error: "project not found" }, 404);
  }
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
      ["eq", "$key", key]
    ]
  })).toString("base64");
  const signature = crypto.createHmac("sha1", accessKeySecret).update(policy).digest("base64");
  return {
    key,
    uploadUrl: `https://${bucket}.${endpoint}`,
    publicUrl: `${publicDomain.replace(/\/+$/, "")}/${key}`,
    fields: {
      key,
      policy,
      OSSAccessKeyId: accessKeyId,
      Signature: signature,
      success_action_status: "200"
    }
  };
}

function uploadToken(body) {
  const planetId = String(body.planetId || "").trim();
  const editToken = String(body.editToken || "").trim();
  if (!planetId || !editToken) return json({ error: "missing planetId or editToken" }, 400);
  const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const key = `planets/${planetId}/${suffix}-${safeName(body.filename)}`;
  return json(ossPostPolicy(key));
}

exports.handler = async function handler(event) {
  event = normalizeEvent(event);
  const method = getMethod(event);
  const path = getPath(event);
  if (method === "OPTIONS") return { statusCode: 204, headers: jsonHeaders, body: "" };

  try {
    if (path === "/uploads/token" && method === "POST") {
      return uploadToken(getBody(event));
    }

    const match = path.match(/^\/projects\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (method === "GET") return getProject(id);
      if (method === "PUT") {
        const body = getBody(event);
        if (!body.editToken || !body.payload) return json({ error: "missing editToken or payload" }, 400);
        return putProject(id, body.payload, body.editToken);
      }
    }

    return json({ error: "not found", method, path }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error.message || "server error" }, 500);
  }
};
