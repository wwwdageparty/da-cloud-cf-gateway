/**
 * Pure JavaScript API Gateway for Cloudflare Workers
 * * This worker supports dynamic routing and service types (REST, ABLY).
 * * Architecture: Logic is now split into dedicated handler functions for cleaner maintenance.
 * * NOTE: The external API path no longer requires the '/api/' prefix.
 * * SECURITY: Implements a global Bearer Token check (GATEWAY_MASTER_TOKEN) for all incoming requests.
 */

import { DA_SERVICE_MAP } from './router.js';


// --- HANDLER FUNCTION: REST API Forwarding ---
async function handleRest(route, bodyJson) {
  let routeToken = route.token;
  if (!routeToken || routeToken === "") {
    if (route.authKeyEnvName) {
      routeToken = G_ENV[route.authKeyEnvName];
    }
  }
  // what if routeToken is empty; allowed now;

  const headers = { 'Content-Type': 'application/json' };
  if (routeToken) headers.Authorization = `Bearer ${routeToken}`;
  const res = await fetch(route.targetUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyJson),
  });
  return res;
}


// --- HANDLER FUNCTION: ABLY Message Bus Publishing ---
async function handleAbly(route, bodyJson) {
  let routeToken = route.token;
  if (!routeToken || routeToken === "") {
    if (route.authKeyEnvName) {
      routeToken = G_ENV[route.authKeyEnvName];
    }
  }
  const channel = route.channelName;
  const publishEndpoint = `${ABLY_PUBLISH_BASE_URL}/${encodeURIComponent(channel)}/messages`;
  const ablyName = bodyJson.action || "gateway-event";

  const messageBusPayload = JSON.stringify([{ 
      name: ablyName, 
      data: bodyJson
  }]);

  const publishRequest = new Request(publishEndpoint, {
      method: 'POST',
      headers: {
          'Authorization': `Basic ${btoa(routeToken)}`, 
          'Content-Type': 'application/json',
      },
      body: messageBusPayload,
  });

  const publishResponse = await fetch(publishRequest);

  if (publishResponse.ok) {
      return jsonSuccess({ 
          status: 'Accepted', 
          message: `Event published successfully to Ably channel: ${channel}`
      });
  } else {
      return jsonError(`Failed to publish event to Ably: ${await publishResponse.text()}`, 502);
  }
}

async function handleApi(request) {
    const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return nack("unknown", "UNAUTHORIZED", "Missing or invalid Authorization header");
  }

  const token = auth.split(" ")[1];
  if (token !== G_ENV[C_GATEWAY_TOKEN_NAME]) {
    return nack("unknown", "INVALID_TOKEN", "Token authentication failed");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return nack("unknown", "INVALID_JSON", "Malformed JSON body");
  }
  
  const requestId = body.request_id || "unknown";
  const version = body.version || "v1";
  const service = body.service;

  if (!service)
    return nack(requestId, "INVALID_FIELD", "Missing field: service");

  // any case without payload?
  if (!body.payload) {
    return nack(requestId, "INVALID_FIELD", "Missing required field: payload");
  }

  const key = `${version}/${service}`;
  let route = DA_SERVICE_MAP[key];

  if (!route) {
    route = await findRouteFromDB(key);
    if (!route) {
      return nack(requestId, "NO_ROUTE", `No route found for ${key}`);
    }
  }

  try {
    if (route.table_name) {
      body.payload.table_name = route.table_name;
    } else {
      // ensure payload does not accidentally contain table_name from client side
      if ("table_name" in body.payload) {
        delete body.payload.table_name;
      }
    }
  } catch (err) {
    console.warn(`Non-JSON or unparseable body for ${route.targetUrl}, skipping modification.`);
  }

  try {
      switch (route.type) {
          case 'REST':
              return await handleRest(route, body);
          case 'ABLY':
              return await handleAbly(route, body);
          default:
              return jsonError(`Unsupported service type: ${body.type}`, 501);
      }
  } catch (e) {
      console.error(`Error processing request for type ${body.type}: ${e.message}`);
      return jsonError('Gateway processing failed', 500);
  }

}


export default {
  async fetch(request, env, ctx) {
    G_DB = env.DB;
    G_CTX = ctx
    G_ENV = env
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname === "/api") {
      return await handleApi(request);
    } else {
      return new Response("Not Found", { status: 404 });
    }
  }
};

// --- UTILITIES ---
function ack(requestId, payload = {}) {
  return jsonResponse({ type: "ack", request_id: requestId, payload });
}

function nack(requestId, code, message) {
  return jsonResponse(
    { type: "nack", request_id: requestId, payload: { status: "error", code, message } },
    400
  );
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
function base64Encode(str) {
  return btoa(str);
}
function jsonError(msg, code = 400) {
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonSuccess(data) {
  return new Response(JSON.stringify({ success: true, ...data }), {
    headers: { "Content-Type": "application/json" },
  });
}

// --- D1 DATABASE ---
async function findRouteFromDB(key) {
  if (!G_DB) return null;

  try {
    const query = `SELECT t1 FROM ${C_RouteTableName} WHERE c1 = ? LIMIT 1`;
    const { results } = await G_DB.prepare(query).bind(key).all();

    if (!results || results.length === 0) {
      return null;
    }

    const row = results[0];
    if (!row.t1) return null;

    let config;
    try {
      config = JSON.parse(row.t1);
    } catch (err) {
      console.error(`Invalid JSON in DB for route ${key}:`, err);
      return null;
    }
    return config;
  } catch (e) {
    console.error("DB lookup failed for route:", key, e);
    return null;
  }
}


let G_DB = null;
let G_CTX = null;
let G_ENV = null;
const C_RouteTableName = "darouter";
// --- GLOBAL CONFIGURATION ---
const ABLY_PUBLISH_BASE_URL = "https://rest.ably.io/channels"; 
const C_GATEWAY_TOKEN_NAME = "DA_GATEWAY_TOKEN";
