import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Cache the static workspace so it can be reopened without a connection.
export default defineConfig({
    plugins: [
        vue(),
        VitePWA({
            registerType: "autoUpdate",
            manifest: {
                name: "知枝 · 知识图谱",
                short_name: "知枝",
                lang: "zh-CN",
                display: "standalone",
                theme_color: "#f8f7fc",
                background_color: "#f8f7fc",
            },
            workbox: {
                globPatterns: ["**/*.{js,css,html,webmanifest}"],
            },
        }),
    ],
});
