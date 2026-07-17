import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel runs Next.js natively (SSR + API routes as Serverless Functions on
  // the free Hobby tier). Firebase services (Firestore/FCM/Auth/Remote Config)
  // are wired via env vars; the static-export + Cloud Functions refactor was
  // reverted because Firebase Spark can't host a backend (Cloud Functions need
  // Blaze). `standalone` bundles only needed deps for the serverless output.
  output: "standalone",
  // Pin the Turbopack workspace root to this project (a stray lockfile in the
  // parent dir otherwise makes Next infer the wrong root).
  turbopack: { root: process.cwd() },
};

export default nextConfig;
