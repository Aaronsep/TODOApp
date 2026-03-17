import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0d11",
        panel: "#131722",
        line: "#262b39",
        glow: "#8be7c4",
        muted: "#8c94a8",
      },
      boxShadow: {
        note: "0 30px 80px rgba(0, 0, 0, 0.45), 0 10px 24px rgba(0, 0, 0, 0.25)",
      },
      keyframes: {
        panelIn: {
          "0%": { opacity: "0", transform: "translateY(8px) scale(0.985)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        itemIn: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "panel-in": "panelIn 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "item-in": "itemIn 140ms ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
