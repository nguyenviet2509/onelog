/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output keeps the Docker image small: copies only the runtime
  // deps actually used, no node_modules sprawl.
  output: "standalone",
  // Disable Next's request logging in production to keep stdout focused on
  // app events (BFF already logs proxy hits via structured agent logs).
  poweredByHeader: false,
  experimental: {
    // SSE pass-through needs streaming; ensure Node runtime, not Edge.
  },
};
export default nextConfig;
