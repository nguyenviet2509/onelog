import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "hsl(222 14% 9%)",
        surface: "hsl(222 14% 13%)",
        border: "hsl(222 10% 22%)",
        fg: "hsl(220 14% 95%)",
        muted: "hsl(220 9% 65%)",
        accent: "hsl(206 88% 60%)",
        warn: "hsl(38 92% 56%)",
        err: "hsl(0 80% 60%)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
