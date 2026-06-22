const BASE_TOKEN = "OKuOb0576aK0J2seAw8cnW5snTc";
const TABLE_ID = "tblyJH47VwqfG2bm";
const LARK_API = "https://open.feishu.cn/open-apis";
const MAX_ITEMS = 50;
const DEFAULT_ITEMS = ["平成屋", "海鲜面", "卤肉饭", "拉面", "饺子", "KFC", "麦麦", "麻辣香锅", "米线", "大米先生", "foodbowl"];

let tokenCache = { value: "", expiresAt: 0 };

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

async function getTenantToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  const response = await fetch(`${LARK_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.LARK_APP_ID, app_secret: env.LARK_APP_SECRET })
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
    throw new Error(`Lark authentication failed: ${result.code || response.status}`);
  }

  tokenCache = {
    value: result.tenant_access_token,
    expiresAt: Date.now() + Math.max((result.expire || 7200) - 300, 60) * 1000
  };
  return tokenCache.value;
}

async function larkRequest(env, path, init = {}) {
  const token = await getTenantToken(env);
  const response = await fetch(`${LARK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      ...init.headers
    }
  });
  const result = await response.json();
  if (!response.ok || result.code !== 0) {
    throw new Error(`Lark API failed: ${result.code || response.status} ${result.msg || ""}`.trim());
  }
  return result.data;
}

async function listRecords(env) {
  const path = `/base/v3/bases/${BASE_TOKEN}/tables/${TABLE_ID}/records?limit=100&offset=0`;
  const data = await larkRequest(env, path);
  const nameIndex = data.fields?.indexOf("选项名称") ?? -1;
  const enabledIndex = data.fields?.indexOf("启用") ?? -1;
  const statusIndex = data.fields?.indexOf("状态") ?? -1;

  if (nameIndex < 0 || enabledIndex < 0 || statusIndex < 0) {
    throw new Error("Required Base fields are missing");
  }

  return (data.data || []).map((row, index) => ({
    id: data.record_id_list?.[index] || "",
    name: String(row[nameIndex] || "").trim(),
    enabled: row[enabledIndex] === true,
    normal: row[statusIndex] === "正常" || (Array.isArray(row[statusIndex]) && row[statusIndex].includes("正常"))
  })).filter(record => record.id && record.name);
}

function enabledItems(records) {
  const seen = new Set();
  return records
    .filter(record => record.enabled && record.normal)
    .map(record => record.name)
    .filter(name => !seen.has(name.toLocaleLowerCase()) && seen.add(name.toLocaleLowerCase()))
    .slice(0, MAX_ITEMS);
}

async function updateRecord(env, recordId, fields) {
  const path = `/base/v3/bases/${BASE_TOKEN}/tables/${TABLE_ID}/records/${recordId}`;
  await larkRequest(env, path, {
    method: "PATCH",
    body: JSON.stringify(fields)
  });
}

async function createRecord(env, name, source = "Cloudflare 网页") {
  const path = `/base/v3/bases/${BASE_TOKEN}/tables/${TABLE_ID}/records`;
  await larkRequest(env, path, {
    method: "POST",
    body: JSON.stringify({
      "选项名称": name,
      "启用": true,
      "创建来源": source,
      "状态": "正常"
    })
  });
}

async function resetOptions(env) {
  const records = await listRecords(env);
  const defaults = new Set(DEFAULT_ITEMS.map(item => item.toLocaleLowerCase()));
  const existing = new Set(records.map(record => record.name.toLocaleLowerCase()));

  for (const record of records) {
    const shouldEnable = defaults.has(record.name.toLocaleLowerCase());
    if (record.enabled !== shouldEnable || (shouldEnable && !record.normal)) {
      await updateRecord(env, record.id, { "启用": shouldEnable, ...(shouldEnable ? { "状态": "正常" } : {}) });
    }
  }

  for (const name of DEFAULT_ITEMS) {
    if (!existing.has(name.toLocaleLowerCase())) {
      await createRecord(env, name, "恢复默认");
    }
  }

  return [...DEFAULT_ITEMS];
}

export async function onRequestGet({ env }) {
  try {
    return json({ items: enabledItems(await listRecords(env)) });
  } catch (error) {
    console.error("Failed to list lunch options", error);
    return json({ error: "暂时无法读取共享选项" }, 502);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return json({ error: "请求格式不正确" }, 415);
    }

    const body = await request.json();
    if (body.action === "reset") {
      return json({ items: await resetOptions(env) });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 12 || /[<>\u0000-\u001f]/.test(name)) {
      return json({ error: "选项名称应为 1 至 12 个字符" }, 400);
    }

    const records = await listRecords(env);
    const currentItems = enabledItems(records);
    const existing = records.find(record => record.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing?.enabled && existing.normal) {
      return json({ error: "这个选项已经有了", items: currentItems }, 409);
    }
    if (currentItems.length >= MAX_ITEMS) {
      return json({ error: `共享选项最多 ${MAX_ITEMS} 个` }, 409);
    }

    if (existing) {
      await updateRecord(env, existing.id, { "启用": true, "状态": "正常" });
    } else {
      await createRecord(env, name);
    }

    return json({ item: name, items: [...currentItems, name] }, 201);
  } catch (error) {
    console.error("Failed to create lunch option", error);
    return json({ error: "暂时无法保存共享选项" }, 502);
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return json({ error: "请求格式不正确" }, 415);
    }

    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const records = await listRecords(env);
    const currentItems = enabledItems(records);
    const record = records.find(item => item.enabled && item.normal && item.name.toLocaleLowerCase() === name.toLocaleLowerCase());

    if (!record) return json({ error: "这个选项已经停用了", items: currentItems }, 404);
    if (currentItems.length <= 2) return json({ error: "至少保留两个选项", items: currentItems }, 409);

    await updateRecord(env, record.id, { "启用": false });
    return json({ items: currentItems.filter(item => item.toLocaleLowerCase() !== name.toLocaleLowerCase()) });
  } catch (error) {
    console.error("Failed to disable lunch option", error);
    return json({ error: "暂时无法停用共享选项" }, 502);
  }
}

export function onRequest() {
  return json({ error: "Method not allowed" }, 405);
}
