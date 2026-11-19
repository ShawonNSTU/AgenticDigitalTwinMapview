/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Godot web export lives in /public/godot and is loaded in an iframe.
  // It is exported single-threaded, so no cross-origin isolation headers are needed.
  async headers() {
    return [{ source: '/godot/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=3600' }] }];
  },
};
export default nextConfig;
