/**
 * Router Template for Cloudflare Worker Gateway
 * 
 * 👇 Copy this file to `router.js` and modify it to define your own routing.
 * 
 * When updating the core gateway, this file won't be overwritten.
 */

export const DA_SERVICE_MAP = {
  "v99/demorest": {
    type: "REST",
    targetUrl: "https://v1-users-api.example.com",
    authKeyEnvName: "REST_API_BEARER_TOKEN",
  },
  "v88/demoably": {
    type: "ABLY",
    authKeyEnvName: "ABLY_API_KEY",
    channelName: "system_bus_v1",
  },
  // Add your routes below 👇
  // "v2/payments": { type: "REST", targetUrl: "...", authKeyEnvName: "..." },
};

